"""Synthetic request data for training and evaluating the risk model.

Normal behaviour: payouts run in weekly batches (BATCH-01 .. BATCH-05). Each beneficiary
has a household-sized amount and gets at most one payout per batch, 1-3 batches a month,
requested during office hours. About 7% of rows are planted anomalies, each labelled:

  duplicate_payout  same person, same amount, again within hours, new ref
  amount_outlier    8-40x the person's usual amount
  shared_wallet     a new beneficiary ID paid into someone else's wallet
  burst             one person files 4-6 requests within 12 hours
  night_new_ben     new beneficiary, new wallet, 01:00-04:00, unusually high amount
  wallet_switch     an existing person suddenly asks to be paid into a new wallet

  python -m ml.generate                 # ml/data/train.csv (seed 1) + test.csv (seed 2)
  python -m ml.generate --beneficiaries 1000
"""
from __future__ import annotations

import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
from stellar_sdk import Keypair

OUT_DIR = Path(__file__).resolve().parent / "data"
START = datetime(2026, 10, 1, tzinfo=timezone.utc)
DAYS = 30
AMOUNTS, WEIGHTS = [25, 40, 50, 75, 100], [2, 3, 4, 2, 1]


def generate(n_ben: int, seed: int) -> pd.DataFrame:
    rng = random.Random(seed)
    wallet = lambda: Keypair.from_raw_ed25519_seed(rng.randbytes(32)).public_key  # noqa: E731
    office_time = lambda day: START + timedelta(  # noqa: E731
        days=day, hours=min(19.5, max(7.5, rng.gauss(13, 2.5))), minutes=rng.randint(0, 59))
    rows: list[dict] = []
    people = []

    def add(ben, w, amount, t, label="normal"):
        rows.append({"beneficiary_id": ben, "wallet": w, "amount": amount, "asset": "AIDUSD",
                     "created_at": t, "label": label})

    # Normal traffic
    for i in range(n_ben):
        ben, w, base = f"BEN-{i:05d}", wallet(), rng.choices(AMOUNTS, WEIGHTS)[0]
        people.append((ben, w, base))
        n_req = rng.choice([1, 2, 2, 3])
        weeks = sorted(rng.sample(range(5), n_req))  # one payout per weekly batch
        for wk in weeks:
            amount = base if rng.random() > 0.1 else rng.choices(AMOUNTS, WEIGHTS)[0]
            add(ben, w, amount, office_time(wk * 7 + rng.randint(0, 4)))

    n_normal = len(rows)
    n_each = max(3, int(n_normal * 0.07 / 6))
    normal_rows = rows[:n_normal]

    for _ in range(n_each):
        r = rng.choice(normal_rows)
        add(r["beneficiary_id"], r["wallet"], r["amount"],
            r["created_at"] + timedelta(minutes=rng.randint(5, 360)), "duplicate_payout")

        ben, w, base = rng.choice(people)
        add(ben, w, base * rng.randint(8, 40), office_time(rng.randrange(DAYS)), "amount_outlier")

        _, w, base = rng.choice(people)
        add(f"BEN-X{rng.randrange(10**6):06d}", w, base, office_time(rng.randrange(DAYS)),
            "shared_wallet")

        ben, w, base = rng.choice(people)
        t0 = office_time(rng.randrange(DAYS))
        for _ in range(rng.randint(4, 6)):
            add(ben, w, rng.choices(AMOUNTS, WEIGHTS)[0],
                t0 + timedelta(minutes=rng.randint(0, 720)), "burst")

        add(f"BEN-N{rng.randrange(10**6):06d}", wallet(), rng.choice([150, 200, 250, 300]),
            START + timedelta(days=rng.randrange(DAYS), hours=rng.uniform(1, 4)), "night_new_ben")

        # The switch comes after the person's normal history (that's what makes it a switch).
        ben, _, base = rng.choice(people)
        last = max(r["created_at"] for r in normal_rows if r["beneficiary_id"] == ben)
        add(ben, wallet(), base, last + timedelta(days=rng.randint(1, 5)), "wallet_switch")

    rng.shuffle(rows)
    df = pd.DataFrame(rows).sort_values("created_at").reset_index(drop=True)
    df.insert(0, "request_ref", [f"S{seed}-{i:06d}" for i in range(len(df))])
    df["batch_id"] = df["created_at"].map(lambda t: f"BATCH-{(t - START).days // 7 + 1:02d}")
    df["created_at"] = df["created_at"].map(lambda t: t.isoformat())
    return df[["request_ref", "batch_id", "beneficiary_id", "wallet", "amount", "asset",
               "created_at", "label"]]


def main() -> None:
    n = int(sys.argv[sys.argv.index("--beneficiaries") + 1]) if "--beneficiaries" in sys.argv else 800
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, seed in [("train", 1), ("test", 2)]:
        df = generate(n, seed)
        df.to_csv(OUT_DIR / f"{name}.csv", index=False)
        counts = df["label"].value_counts()
        print(f"{name}: {len(df)} rows, {len(df) - counts['normal']} anomalies "
              f"({(1 - counts['normal'] / len(df)):.1%})  {dict(counts.drop('normal'))}")


if __name__ == "__main__":
    main()
