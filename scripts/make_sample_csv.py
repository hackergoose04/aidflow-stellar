"""Generate data/samples/requests.csv: the shared sample for the backend, UI and demo.

Built with the same generator as the ML training data (ml/generate.py), so "normal"
looks the same everywhere, plus three ingest-level errors the backend must reject.
Ground truth goes to requests_labels.csv (request_ref -> label; unlisted rows are normal).

Wallets are random valid Stellar addresses that do not exist on Testnet.

  python scripts/make_sample_csv.py
  python scripts/make_sample_csv.py --beneficiaries 100
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ml.generate import generate  # noqa: E402

OUT = ROOT / "data" / "samples" / "requests.csv"
LABELS = ROOT / "data" / "samples" / "requests_labels.csv"
FIELDS = ["request_ref", "batch_id", "beneficiary_id", "wallet", "amount", "asset", "created_at"]


def main() -> None:
    n = int(sys.argv[sys.argv.index("--beneficiaries") + 1]) if "--beneficiaries" in sys.argv else 60
    df = generate(n, seed=7)
    df["request_ref"] = [f"REQ-{i + 1:04d}" for i in range(len(df))]

    normal = df[df["label"] == "normal"]
    first, second, third = normal.iloc[0], normal.iloc[1], normal.iloc[2]
    k = len(df)
    extra = pd.DataFrame([
        {**first.to_dict(), "label": "duplicate_ref"},  # same ref uploaded twice
        {**second.to_dict(), "request_ref": f"REQ-{k + 1:04d}", "wallet": "GNOTAREALADDRESS",
         "label": "invalid_wallet"},
        {**third.to_dict(), "request_ref": f"REQ-{k + 2:04d}", "amount": -20,
         "label": "invalid_amount"},
    ])
    df = pd.concat([df, extra], ignore_index=True)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    df[FIELDS].to_csv(OUT, index=False)
    labels = df.loc[df["label"] != "normal", ["request_ref", "label"]]
    labels.to_csv(LABELS, index=False)
    print(f"wrote {len(df)} rows to {OUT.relative_to(ROOT)}; "
          f"{len(labels)} labelled problems: {labels['label'].value_counts().to_dict()}")


if __name__ == "__main__":
    main()
