#![cfg(test)]
extern crate std;

use super::{AidRegistry, AidRegistryClient, EntryStatus, Error};
use soroban_sdk::testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation};
use soroban_sdk::{Address, BytesN, Env, IntoVal, Symbol};

fn setup() -> (Env, Address, AidRegistryClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(AidRegistry, (admin.clone(),));
    let client = AidRegistryClient::new(&env, &id);
    (env, admin, client)
}

fn h(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

#[test]
fn register_then_mark_paid() {
    let (env, _, r) = setup();
    let (key, req, tx) = (h(&env, 1), h(&env, 2), h(&env, 3));
    assert!(!r.is_registered(&key));
    r.register(&key, &req);
    let e = r.get(&key).unwrap();
    assert_eq!((e.request_hash.clone(), e.status, e.tx_hash.clone()), (req.clone(), EntryStatus::Reserved, None));
    r.mark_paid(&key, &tx);
    let e = r.get(&key).unwrap();
    assert_eq!((e.status, e.tx_hash), (EntryStatus::Paid, Some(tx)));
}

#[test]
fn same_beneficiary_same_period_is_refused() {
    let (env, _, r) = setup();
    let key = h(&env, 1);
    r.register(&key, &h(&env, 2));
    // A second request (different request hash) for the same person and period.
    assert_eq!(r.try_register(&key, &h(&env, 9)), Err(Ok(Error::AlreadyRegistered)));
    // The original entry is untouched.
    assert_eq!(r.get(&key).unwrap().request_hash, h(&env, 2));
}

#[test]
fn other_period_or_person_is_a_different_key() {
    let (env, _, r) = setup();
    r.register(&h(&env, 1), &h(&env, 2));
    r.register(&h(&env, 4), &h(&env, 5));
    assert!(r.is_registered(&h(&env, 1)) && r.is_registered(&h(&env, 4)));
}

#[test]
fn release_frees_a_reserved_key_for_retry() {
    let (env, _, r) = setup();
    let key = h(&env, 1);
    r.register(&key, &h(&env, 2));
    r.release(&key);
    assert!(!r.is_registered(&key));
    r.register(&key, &h(&env, 2));
    assert!(r.is_registered(&key));
}

#[test]
fn a_paid_entry_cannot_be_released_or_paid_again() {
    let (env, _, r) = setup();
    let key = h(&env, 1);
    r.register(&key, &h(&env, 2));
    r.mark_paid(&key, &h(&env, 3));
    assert_eq!(r.try_release(&key), Err(Ok(Error::AlreadyPaid)));
    assert_eq!(r.try_mark_paid(&key, &h(&env, 4)), Err(Ok(Error::AlreadyPaid)));
    assert_eq!(r.try_register(&key, &h(&env, 2)), Err(Ok(Error::AlreadyRegistered)));
}

#[test]
fn unknown_key() {
    let (env, _, r) = setup();
    assert_eq!(r.get(&h(&env, 7)), None);
    assert_eq!(r.try_mark_paid(&h(&env, 7), &h(&env, 3)), Err(Ok(Error::NotFound)));
    assert_eq!(r.try_release(&h(&env, 7)), Err(Ok(Error::NotFound)));
}

#[test]
fn register_requires_admin_auth() {
    let (env, admin, r) = setup();
    let (key, req) = (h(&env, 1), h(&env, 2));
    r.register(&key, &req);
    assert_eq!(
        env.auths(),
        std::vec![(
            admin,
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    r.address.clone(),
                    Symbol::new(&env, "register"),
                    (key, req).into_val(&env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
}

#[test]
#[should_panic]
fn stranger_cannot_register() {
    let env = Env::default(); // no mocked auths: a real admin signature is required
    let id = env.register(AidRegistry, (Address::generate(&env),));
    AidRegistryClient::new(&env, &id).register(&h(&env, 1), &h(&env, 2));
}
