"""Reconciliation classification, offline: one case per category and per mismatch reason."""
from __future__ import annotations

from backend.app import stellar_client as sc
from backend.app.services.recon import classify

ISSUER = "GISSUER"
W1, W2 = "GWALLET1", "GWALLET2"


def row(ref, status, amount="50.0000000", wallet=W1, tx="tx-" + "a"):
    return {"request_ref": ref, "status": status, "amount": amount, "wallet": wallet,
            "asset": "AIDUSD", "tx_hash": tx}


def op(ref, amount="50.0000000", to=W1, asset=f"AIDUSD:{ISSUER}", tx="tx-a"):
    return {"tx_hash": tx, "type": "payment", "to": to, "amount": amount, "asset": asset,
            "memo_hex": sc.memo_hash(ref).hex()}


def one(rows, chain):
    rep = classify(rows, chain, ISSUER)
    return {r["request_ref"]: (r["category"], r["reasons"]) for r in rep["results"]}, rep


def test_matched():
    res, _ = one([row("R1", "CONFIRMED"), row("R2", "CLAIMED")], [op("R1"), op("R2")])
    assert res["R1"] == ("MATCHED", [])
    assert res["R2"] == ("MATCHED", [])  # claimed by the beneficiary: still the same payout


def test_each_mismatch_reason():
    rows = [row("A", "CONFIRMED"), row("B", "CONFIRMED"), row("C", "CONFIRMED"),
            row("D", "CONFIRMED"), row("E", "CONFIRMED"), row("F", "CONFIRMED", tx="tx-f")]
    chain = [op("A", amount="60.0000000"), op("B", to=W2), op("C", asset="native"),
             op("E", tx="tx-x"), op("F", tx="tx-f"), op("F", tx="tx-g")]
    res, _ = one(rows, chain)
    assert res["A"] == ("MISMATCH", ["amount_differs"])
    assert res["B"] == ("MISMATCH", ["wallet_differs"])
    assert res["C"] == ("MISMATCH", ["asset_differs"])
    assert res["D"] == ("MISMATCH", ["missing_on_chain"])
    assert res["E"] == ("MISMATCH", ["tx_hash_differs"])
    assert res["F"] == ("MISMATCH", ["paid_2_times"])


def test_pending_verification():
    res, _ = one([row("P1", "SUBMITTED"), row("P2", "UNKNOWN")], [op("P2")])
    assert res["P1"] == ("PENDING_VERIFICATION", ["submitted"])
    assert res["P2"] == ("PENDING_VERIFICATION", ["unknown", "found_on_chain_run_verify"])


def test_not_executed():
    rows = [row("N1", "REJECTED"), row("N2", "HELD"), row("N3", "PENDING_REVIEW"),
            row("N4", "APPROVED"), row("N5", "FAILED"), row("N6", "INVALID")]
    res, _ = one(rows, [])
    assert {k: v[0] for k, v in res.items()} == {k: "NOT_EXECUTED" for k in res}
    assert res["N2"][1] == ["held"]
    assert res["N6"][1] == ["invalid"]


def test_money_moved_for_a_request_that_should_not_have_paid():
    res, _ = one([row("X1", "REJECTED"), row("X2", "FAILED")], [op("X1"), op("X2")])
    assert res["X1"] == ("MISMATCH", ["on_chain_but_never_submitted"])
    assert res["X2"] == ("MISMATCH", ["on_chain_but_marked_failed"])


def test_unrecorded_payouts_are_listed():
    _, rep = one([row("R1", "CONFIRMED")], [op("R1"), op("NOT-OURS")])
    assert rep["summary"]["UNRECORDED_ON_CHAIN"] == 1
    assert rep["summary"]["MATCHED"] == 1


def test_registry_checks_on_confirmed_payments():
    ok = {"request_hash": sc.memo_hash("G1"), "status": "Paid", "tx_hash": "tx-a"}
    entries = {
        "G1": ok,
        "G2": None,
        "G3": {**ok, "request_hash": sc.memo_hash("SOMEONE-ELSE")},
        "G4": {**ok, "request_hash": sc.memo_hash("G4"), "status": "Reserved"},
        "G5": {**ok, "request_hash": sc.memo_hash("G5"), "tx_hash": "tx-zzz"},
    }
    rows = [row(r, "CONFIRMED") for r in entries]
    chain = [op(r) for r in entries]
    rep = classify(rows, chain, ISSUER, entries)
    res = {r["request_ref"]: (r["category"], r["reasons"]) for r in rep["results"]}
    assert res["G1"] == ("MATCHED", [])
    assert res["G2"] == ("MISMATCH", ["registry_missing"])
    assert res["G3"] == ("MISMATCH", ["registry_held_by_other_request"])
    assert res["G4"] == ("MISMATCH", ["registry_not_marked_paid"])
    assert res["G5"] == ("MISMATCH", ["registry_tx_differs"])
