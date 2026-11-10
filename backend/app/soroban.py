"""Generic Soroban helpers: submit a contract call, wait for it, read by simulation."""
from __future__ import annotations

import time

from stellar_sdk import Address, Keypair, TransactionBuilder, scval, xdr
from stellar_sdk.soroban_rpc import GetTransactionStatus, SendTransactionStatus

from . import config, stellar_client as sc


class ContractError(Exception):
    """The contract refused the call (e.g. Error(Contract, #1)). `code` is the number."""

    def __init__(self, code: int | None, message: str):
        super().__init__(message)
        self.code = code


def _contract_code(message: str) -> int | None:
    marker = "Error(Contract, #"
    if marker not in message:
        return None
    return int(message.split(marker, 1)[1].split(")", 1)[0])


def prepare(signer_public: str, build):
    """Build and simulate. Raises ContractError if the contract rejects the call."""
    rpc = sc.rpc()
    source = rpc.load_account(signer_public)
    builder = TransactionBuilder(source, config.NETWORK_PASSPHRASE, base_fee=config.BASE_FEE)
    build(builder)
    tx = builder.set_timeout(config.TX_TIMEOUT_SECONDS).build()
    try:
        return rpc.prepare_transaction(tx)
    except Exception as exc:
        sim = getattr(exc, "simulate_transaction_response", None)
        message = (getattr(sim, "error", None) or str(exc))
        raise ContractError(_contract_code(message), message) from exc


def submit(signer: Keypair, build, timeout: int = 60) -> tuple[str, str, xdr.SCVal | None]:
    """Prepare, sign, send, wait. Returns (SUCCESS | FAILED | UNKNOWN, tx_hash, return value)."""
    tx = prepare(signer.public_key, build)
    tx.sign(signer)
    return send_and_wait(tx, timeout)


def send_and_wait(tx, timeout: int = 60) -> tuple[str, str, xdr.SCVal | None]:
    rpc = sc.rpc()
    sent = rpc.send_transaction(tx)
    if sent.status == SendTransactionStatus.ERROR:
        return "FAILED", sent.hash, None
    deadline = time.time() + timeout
    while time.time() < deadline:
        got = rpc.get_transaction(sent.hash)
        if got.status == GetTransactionStatus.SUCCESS:
            return "SUCCESS", sent.hash, _return_value(got.result_meta_xdr)
        if got.status == GetTransactionStatus.FAILED:
            return "FAILED", sent.hash, None
        time.sleep(1)
    return "UNKNOWN", sent.hash, None


def _return_value(meta_xdr: str | None) -> xdr.SCVal | None:
    if not meta_xdr:
        return None
    meta = xdr.TransactionMeta.from_xdr(meta_xdr)
    for v in ("v4", "v3"):
        m = getattr(meta, v, None)
        if m is not None and m.soroban_meta is not None:
            return m.soroban_meta.return_value
    return None


def read(contract_id: str, function: str, args: list[xdr.SCVal]):
    """Call a read-only function by simulation (free, nothing is submitted)."""
    return scval.to_native(_simulate(contract_id, function, args))


def _simulate(contract_id: str, function: str, args: list[xdr.SCVal]) -> xdr.SCVal:
    rpc = sc.rpc()
    source = rpc.load_account(config.public("DISTRIBUTION"))
    tx = (TransactionBuilder(source, config.NETWORK_PASSPHRASE, base_fee=config.BASE_FEE)
          .append_invoke_contract_function_op(contract_id, function, args).set_timeout(30).build())
    sim = rpc.simulate_transaction(tx)
    if sim.error:
        raise ContractError(_contract_code(sim.error), sim.error)
    return xdr.SCVal.from_xdr(sim.results[0].xdr)


def address_of(val: xdr.SCVal) -> str:
    return Address.from_xdr_sc_address(val.address).address
