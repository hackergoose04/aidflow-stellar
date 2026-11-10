"""Reconciliation accuracy on a synthetic ledger with known, injected discrepancies.

Builds N internal payment records and the matching "chain" payouts, injects every kind of
discrepancy the design doc names (wrong amount, wrong wallet, wrong asset, missing,
duplicated, stray payouts, unresolved submissions...), runs the real classifier
(backend/app/services/recon.classify) and scores it against the known truth.

  python scripts/recon_eval.py            # 2000 records
Writes ml/reports/recon_eval.json (shown on the dashboard).

Caveat: this checks that the engine catches each discrepancy type it was designed for.
Real-world accuracy also depends on payments carrying the right memo.
"""
from __future__ import annotations

import json
import random
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app import stellar_client as sc  # noqa: E402
from backend.app.services.recon import CATEGORIES, classify  # noqa: E402

ISSUER = "GISSUER"
OUT = ROOT / "ml" / "reports" / "recon_eval.json"

# scenario -> (share, expected category, expected reasons)
SCENARIOS = {
    "clean_confirmed":       (0.62, "MATCHED", []),
    "rejected":              (0.03, "NOT_EXECUTED", ["rejected"]),
    "held":                  (0.02, "NOT_EXECUTED", ["held"]),
    "invalid":               (0.01, "NOT_EXECUTED", ["invalid"]),
    "approved_not_paid":     (0.02, "NOT_EXECUTED", ["approved"]),
    "failed":                (0.03, "NOT_EXECUTED", ["failed"]),
    "submitted_pending":     (0.03, "PENDING_VERIFICATION", ["submitted"]),
    "unknown_but_landed":    (0.02, "PENDING_VERIFICATION", ["unknown", "found_on_chain_run_verify"]),
    "amount_differs":        (0.03, "MISMATCH", ["amount_differs"]),
    "wallet_differs":        (0.03, "MISMATCH", ["wallet_differs"]),
    "asset_differs":         (0.03, "MISMATCH", ["asset_differs"]),
    "missing_on_chain":      (0.03, "MISMATCH", ["missing_on_chain"]),
    "paid_twice":            (0.03, "MISMATCH", ["paid_2_times"]),
    "tx_hash_differs":       (0.02, "MISMATCH", ["tx_hash_differs"]),
    "paid_but_rejected":     (0.02, "MISMATCH", ["on_chain_but_never_submitted"]),
    "claimed":               (0.03, "MATCHED", []),
    "paid_but_failed":       (0.03, "MISMATCH", ["on_chain_but_marked_failed"]),
}


def build(n: int, seed: int = 0):
    rng = random.Random(seed)
    names, weights = list(SCENARIOS), [v[0] for v in SCENARIOS.values()]
    wallet = lambda: "G" + "".join(rng.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", k=55))  # noqa: E731
    rows, chain, truth = [], [], {}
    for i in range(n):
        sc_name = rng.choices(names, weights)[0]
        ref, w, amt, tx = f"R-{i:05d}", wallet(), f"{rng.choice([25, 40, 50, 75, 100])}.0000000", f"tx{i:05d}"
        status = {"rejected": "REJECTED", "held": "HELD", "invalid": "INVALID", "approved_not_paid": "APPROVED",
                  "claimed": "CLAIMED", "failed": "FAILED", "paid_but_failed": "FAILED", "paid_but_rejected": "REJECTED",
                  "submitted_pending": "SUBMITTED", "unknown_but_landed": "UNKNOWN"}.get(sc_name, "CONFIRMED")
        rows.append({"request_ref": ref, "status": status, "amount": amt, "wallet": w,
                     "asset": "AIDUSD", "tx_hash": tx})
        truth[ref] = (SCENARIOS[sc_name][1], SCENARIOS[sc_name][2], sc_name)
        op = {"tx_hash": tx, "type": "payment", "to": w, "amount": amt,
              "asset": f"AIDUSD:{ISSUER}", "memo_hex": sc.memo_hash(ref).hex()}
        if sc_name in ("rejected", "held", "invalid", "approved_not_paid", "failed", "submitted_pending",
                       "missing_on_chain"):
            continue
        if sc_name == "amount_differs":
            op["amount"] = f"{float(amt) + rng.choice([-10, 10, 100]):.7f}"
        elif sc_name == "wallet_differs":
            op["to"] = wallet()
        elif sc_name == "asset_differs":
            op["asset"] = rng.choice(["native", "AIDUSD:GOTHERISSUER", "USDC:GISSUER"])
        elif sc_name == "tx_hash_differs":
            op["tx_hash"] = tx + "-other"
        chain.append(op)
        if sc_name == "paid_twice":
            chain.append({**op, "tx_hash": tx + "-dup"})
    strays = [{"tx_hash": f"stray{k}", "type": "payment", "to": wallet(), "amount": "50.0000000",
               "asset": f"AIDUSD:{ISSUER}", "memo_hex": sc.memo_hash(f"NOT-OURS-{k}").hex()}
              for k in range(max(1, n // 100))]
    chain += strays
    rng.shuffle(chain)
    return rows, chain, truth, len(strays)


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
    rows, chain, truth, n_strays = build(n)
    rep = classify(rows, chain, ISSUER)

    cat_ok = reason_ok = 0
    confusion = Counter()
    per_scenario = Counter()
    per_scenario_ok = Counter()
    for r in rep["results"]:
        want_cat, want_reasons, name = truth[r["request_ref"]]
        confusion[(want_cat, r["category"])] += 1
        per_scenario[name] += 1
        if r["category"] == want_cat:
            cat_ok += 1
            if r["reasons"] == want_reasons:
                reason_ok += 1
                per_scenario_ok[name] += 1
    result = {
        "records": n, "chain_payouts": len(chain), "stray_payouts": n_strays,
        "category_accuracy": round(cat_ok / n, 4),
        "reason_accuracy": round(reason_ok / n, 4),
        "strays_found": rep["summary"]["UNRECORDED_ON_CHAIN"],
        "by_scenario": {k: {"count": per_scenario[k], "correct": per_scenario_ok[k]} for k in SCENARIOS},
        "confusion": {f"{a} -> {b}": c for (a, b), c in sorted(confusion.items())},
        "categories": CATEGORIES,
        "note": "Synthetic ledger with injected discrepancies; checks the engine, not memo discipline in the field.",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, indent=2))
    print(f"{n} records, {len(chain)} chain payouts ({n_strays} stray)")
    print(f"category accuracy {result['category_accuracy']:.2%}, exact reason accuracy {result['reason_accuracy']:.2%}, "
          f"stray payouts found {result['strays_found']}/{n_strays}")
    for k, v in result["by_scenario"].items():
        print(f"  {k:22s} {v['correct']:>4d}/{v['count']:<4d}")
    print(f"written to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
