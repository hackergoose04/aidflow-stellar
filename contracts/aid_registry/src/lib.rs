//! AidFlow payout registry (Soroban). Plan B: a hash registry that never touches money.
//!
//! Before paying, the NGO registers
//!     key = HMAC-SHA256(secret, program | period | beneficiary_id)
//! The secret stays with the NGO, so nobody can test guesses of beneficiary IDs against
//! the chain. A key can be registered once, so a beneficiary gets at most one payout per
//! program and period, even if the backend has a bug or is run twice.
//!
//! The payment itself is a normal Stellar payment or claimable balance. Its memo is
//! SHA-256(request_ref), the same `request_hash` stored here, so the two can be matched.
//!
//! Lifecycle of an entry:
//!     register  -> RESERVED  (before paying; a second register of the key is refused)
//!     mark_paid -> PAID      (after the payment is confirmed; stores its tx hash)
//!     release   -> removed   (only while RESERVED, when the payment failed and may be retried)
//!
//! Only the admin (the NGO's distribution account) can write.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// This beneficiary already has an entry for this program and period.
    AlreadyRegistered = 1,
    /// No entry for this key.
    NotFound = 2,
    /// The entry is already PAID; it can't be paid again or released.
    AlreadyPaid = 3,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntryStatus {
    Reserved,
    Paid,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Entry {
    /// SHA-256(request_ref): the memo of the matching payment.
    pub request_hash: BytesN<32>,
    pub status: EntryStatus,
    /// Hash of the payment transaction, once PAID.
    pub tx_hash: Option<BytesN<32>>,
    /// Ledger of the last change.
    pub ledger: u32,
}

#[contracttype]
enum Key {
    Admin,
    Entry(BytesN<32>),
}

#[contractevent(topics = ["registered"])]
pub struct Registered {
    #[topic]
    pub key: BytesN<32>,
    pub request_hash: BytesN<32>,
}

#[contractevent(topics = ["paid"])]
pub struct MarkedPaid {
    #[topic]
    pub key: BytesN<32>,
    pub tx_hash: BytesN<32>,
}

#[contractevent(topics = ["released"])]
pub struct Released {
    #[topic]
    pub key: BytesN<32>,
}

// Keep entries alive for about a year (ledgers close every ~5 s). An archived entry
// still blocks `register` until restored, so expiry never silently allows a repeat.
const TTL: u32 = 6_300_000;
const TTL_THRESHOLD: u32 = TTL - 100_000;

#[contract]
pub struct AidRegistry;

#[contractimpl]
impl AidRegistry {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&Key::Admin, &admin);
    }

    /// Reserve `key` for the request `request_hash`. Fails if the key is already taken.
    pub fn register(env: Env, key: BytesN<32>, request_hash: BytesN<32>) -> Result<(), Error> {
        Self::admin(&env).require_auth();
        let k = Key::Entry(key.clone());
        if env.storage().persistent().has(&k) {
            return Err(Error::AlreadyRegistered);
        }
        let entry = Entry {
            request_hash: request_hash.clone(),
            status: EntryStatus::Reserved,
            tx_hash: None,
            ledger: env.ledger().sequence(),
        };
        Self::save(&env, &k, &entry);
        Registered { key, request_hash }.publish(&env);
        Ok(())
    }

    /// Record that the payment for `key` was confirmed on chain.
    pub fn mark_paid(env: Env, key: BytesN<32>, tx_hash: BytesN<32>) -> Result<(), Error> {
        Self::admin(&env).require_auth();
        let k = Key::Entry(key.clone());
        let mut entry: Entry = env.storage().persistent().get(&k).ok_or(Error::NotFound)?;
        if entry.status == EntryStatus::Paid {
            return Err(Error::AlreadyPaid);
        }
        entry.status = EntryStatus::Paid;
        entry.tx_hash = Some(tx_hash.clone());
        entry.ledger = env.ledger().sequence();
        Self::save(&env, &k, &entry);
        MarkedPaid { key, tx_hash }.publish(&env);
        Ok(())
    }

    /// Free a RESERVED key after its payment failed, so the payout can be retried.
    pub fn release(env: Env, key: BytesN<32>) -> Result<(), Error> {
        Self::admin(&env).require_auth();
        let k = Key::Entry(key.clone());
        let entry: Entry = env.storage().persistent().get(&k).ok_or(Error::NotFound)?;
        if entry.status == EntryStatus::Paid {
            return Err(Error::AlreadyPaid);
        }
        env.storage().persistent().remove(&k);
        Released { key }.publish(&env);
        Ok(())
    }

    pub fn get(env: Env, key: BytesN<32>) -> Option<Entry> {
        env.storage().persistent().get(&Key::Entry(key))
    }

    pub fn is_registered(env: Env, key: BytesN<32>) -> bool {
        env.storage().persistent().has(&Key::Entry(key))
    }

    pub fn admin_address(env: Env) -> Address {
        Self::admin(&env)
    }

    fn admin(env: &Env) -> Address {
        env.storage().instance().get(&Key::Admin).unwrap()
    }

    fn save(env: &Env, k: &Key, entry: &Entry) {
        env.storage().persistent().set(k, entry);
        env.storage().persistent().extend_ttl(k, TTL_THRESHOLD, TTL);
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL);
    }
}

#[cfg(test)]
mod test;
