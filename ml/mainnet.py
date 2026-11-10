"""Layer-2 test: run the screening on REAL Stellar mainnet payouts.

Reads (never writes) a public payout account's outgoing USDC payments from mainnet
Horizon, maps them to the request format, and measures how much the rules and the
model would flag. There are no labels, so this measures the false-alarm side: on a
real, presumably mostly-legitimate payout stream, how many would land in review?

Mapping: request_ref = operation id, beneficiary_id = wallet = recipient account.
On chain there is no separate beneficiary ID, so the shared-wallet and wallet-changed
rules cannot fire here.

  python -m ml.mainnet GAUA7XL5...PNJU               # fetch (cached) + evaluate
  python -m ml.mainnet GAUA7XL5...PNJU --pages 300   # fetch more history
  python -m ml.mainnet GAUA7XL5...PNJU --max-per-recipient 50
      # drop recipients paid more than 50 times (exchanges / omnibus accounts), keeping
      # the person-to-person-like payouts that resemble an aid program
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from sklearn.ensemble import IsolationForest

from .features import FEATURES, build_features
from .score import anomaly_scores, load, risk_from_scores, threshold

HORIZON = "https://horizon.stellar.org"  # MAINNET, read-only
USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"  # Circle
ROOT = Path(__file__).resolve().parent
AMOUNT_LIMIT = 500


def fetch(account: str, max_pages: int) -> pd.DataFrame:
    cache = ROOT / "data" / f"mainnet_{account[:8]}.csv"
    if cache.exists():
        df = pd.read_csv(cache)
        print(f"using cached {cache.relative_to(ROOT.parent)} ({len(df)} payouts)")
        return df
    rows, url = [], f"{HORIZON}/accounts/{account}/payments?order=desc&limit=200"
    for page in range(max_pages):
        for attempt in range(5):
            r = requests.get(url, timeout=30)
            if r.status_code == 429:  # rate limited: back off
                time.sleep(2 ** attempt)
                continue
            r.raise_for_status()
            break
        d = r.json()
        recs = d["_embedded"]["records"]
        if not recs:
            break
        for op in recs:
            if (op["type"] == "payment" and op["from"] == account and op.get("asset_code") == "USDC"
                    and op.get("asset_issuer") == USDC_ISSUER and op.get("transaction_successful", True)):
                rows.append({"request_ref": op["id"], "beneficiary_id": op["to"], "wallet": op["to"],
                             "amount": float(op["amount"]), "asset": "USDC",
                             "created_at": op["created_at"]})
        url = d["_links"]["next"]["href"]
        if page % 20 == 19:
            print(f"  page {page + 1}: {len(rows)} payouts, back to {recs[-1]['created_at']}")
    df = pd.DataFrame(rows).sort_values("created_at").reset_index(drop=True)
    cache.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(cache, index=False)
    return df


def later_duplicate(df: pd.DataFrame) -> np.ndarray:
    """Backend dedup rule: same recipient + same amount as an earlier payout within 24 h."""
    t = pd.to_datetime(df["created_at"], utc=True).astype("int64").to_numpy() / 1e9
    out = np.zeros(len(df), dtype=bool)
    for idx in df.groupby("beneficiary_id").indices.values():
        idx = idx[np.argsort(t[idx])]
        for k in range(1, len(idx)):
            prev = idx[:k]
            close = t[idx[k]] - t[prev] <= 24 * 3600
            out[idx[k]] = bool((close & (df["amount"].to_numpy()[prev] == df["amount"].iat[idx[k]])).any())
    return out


def describe(df: pd.DataFrame) -> dict:
    t = pd.to_datetime(df["created_at"], utc=True)
    per_rec = df.groupby("beneficiary_id").size()
    return {
        "payouts": len(df), "recipients": int(per_rec.size),
        "from": str(t.min()), "to": str(t.max()),
        "days": round((t.max() - t.min()).total_seconds() / 86400, 1),
        "amount_median": float(df["amount"].median()),
        "amount_p90": float(df["amount"].quantile(0.9)),
        "amount_max": float(df["amount"].max()),
        "payouts_per_recipient_median": float(per_rec.median()),
        "payouts_per_recipient_max": int(per_rec.max()),
    }


def main() -> None:
    account = sys.argv[1]
    pages = int(sys.argv[sys.argv.index("--pages") + 1]) if "--pages" in sys.argv else 150
    df = fetch(account, pages)
    cap = int(sys.argv[sys.argv.index("--max-per-recipient") + 1]) if "--max-per-recipient" in sys.argv else None
    if cap:
        counts = df.groupby("beneficiary_id")["beneficiary_id"].transform("size")
        dropped = int((counts > cap).groupby(df["beneficiary_id"]).any().sum())
        df = df[counts <= cap].reset_index(drop=True)
        print(f"dropped {dropped} recipients paid more than {cap} times; {len(df)} payouts left")
    if len(df) < 50:
        raise SystemExit(f"only {len(df)} USDC payouts found; pick a busier account")
    X = build_features(df)

    rules = {"amount_above_limit": (df["amount"] > AMOUNT_LIMIT).to_numpy(),
             "possible_duplicate": later_duplicate(df)}
    rules_any = np.any(list(rules.values()), axis=0)

    # (a) The model as shipped: trained on our synthetic data.
    bundle = load()
    shipped = risk_from_scores(bundle, anomaly_scores(bundle, X)) >= threshold()

    # (b) Refit on this account's own history, as a real deployment would (no labels needed).
    #     Flag only clear outliers: raw score above the training cut-off sklearn infers.
    own = IsolationForest(n_estimators=300, max_samples=256, contamination="auto",
                          random_state=0).fit(X)
    own_flag = own.predict(X) == -1
    own_score = -own.score_samples(X)

    report = {
        "account": account, "max_per_recipient": cap, "data": describe(df),
        "flag_rate": {
            **{f"rule_{k}": round(float(v.mean()), 4) for k, v in rules.items()},
            "rules_any": round(float(rules_any.mean()), 4),
            "model_as_shipped": round(float(shipped.mean()), 4),
            "rules_or_model_as_shipped": round(float((rules_any | shipped).mean()), 4),
            "model_refit_on_own_history": round(float(own_flag.mean()), 4),
            "rules_or_model_refit": round(float((rules_any | own_flag).mean()), 4),
        },
        "synthetic_reference_false_alarm_rate": 0.045,
    }

    tag = f"mainnet_{account[:8]}" + (f"_cap{cap}" if cap else "")
    out = ROOT / "reports" / f"{tag}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2))

    # The most anomalous payouts under the refit model, for a human to inspect.
    top = df.assign(score=own_score, dup=rules["possible_duplicate"]).join(X)
    top = top.sort_values("score", ascending=False).head(25)
    top.to_csv(ROOT / "reports" / f"{tag}_top.csv", index=False)

    d = report["data"]
    print(f"\n{d['payouts']} USDC payouts to {d['recipients']} recipients over {d['days']} days "
          f"({d['from'][:10]} .. {d['to'][:10]})")
    print(f"amount median {d['amount_median']}, p90 {d['amount_p90']}, max {d['amount_max']}; "
          f"payouts per recipient median {d['payouts_per_recipient_median']}, max {d['payouts_per_recipient_max']}")
    print("\nshare of payouts that would go to human review:")
    for k, v in report["flag_rate"].items():
        print(f"  {k:32s} {v:6.1%}")
    print(f"\nwritten to {out.relative_to(ROOT.parent)} and the top-25 list next to it")


if __name__ == "__main__":
    main()
