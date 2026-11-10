"""Feature extraction, shared by training (ml/) and live scoring (backend screening).

Input: a DataFrame with the request CSV columns (request_ref, beneficiary_id, wallet,
amount, asset, created_at). Each row's features look at the other requests in the same
frame, so pass the full history, not just the new rows."""
from __future__ import annotations

import numpy as np
import pandas as pd

FEATURES = [
    "log_amount",           # size of the payout
    "amount_vs_global",     # amount / median amount of everyone
    "amount_vs_own",        # amount / median of this beneficiary's other requests (1 if none)
    "hour_sin", "hour_cos",  # time of day, as a circle so 23:00 is close to 00:00
    "ben_requests_24h",     # other requests by the same beneficiary within 24 h
    "same_amount_24h",      # ... of which with the same amount (double request)
    "log_gap_hours",        # hours to the nearest other request of this beneficiary
    "wallet_ben_count",     # distinct beneficiaries using this wallet (shared wallet)
    "ben_wallet_count",     # distinct wallets used by this beneficiary (wallet switch)
]
NO_NEIGHBOUR_GAP_HOURS = 24 * 60.0


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    t = pd.to_datetime(df["created_at"], utc=True, format="ISO8601")
    amount = df["amount"].astype(float).to_numpy()
    hours = (t - t.min()).dt.total_seconds().to_numpy() / 3600.0
    hour_of_day = (t.dt.hour + t.dt.minute / 60.0).to_numpy()

    n = len(df)
    amount_vs_own = np.ones(n)
    count_24h = np.zeros(n)
    same_24h = np.zeros(n)
    gap = np.full(n, NO_NEIGHBOUR_GAP_HOURS)

    for idx in df.groupby("beneficiary_id").indices.values():
        if len(idx) < 2:
            continue
        h, a = hours[idx], amount[idx]
        for k, i in enumerate(idx):
            others = np.delete(np.arange(len(idx)), k)
            dt = np.abs(h[others] - h[k])
            near = dt <= 24
            amount_vs_own[i] = a[k] / np.median(a[others])
            count_24h[i] = near.sum()
            same_24h[i] = (near & (a[others] == a[k])).sum()
            gap[i] = dt.min()

    return pd.DataFrame({
        "log_amount": np.log1p(amount),
        "amount_vs_global": amount / np.median(amount),
        "amount_vs_own": amount_vs_own,
        "hour_sin": np.sin(2 * np.pi * hour_of_day / 24),
        "hour_cos": np.cos(2 * np.pi * hour_of_day / 24),
        "ben_requests_24h": count_24h,
        "same_amount_24h": same_24h,
        "log_gap_hours": np.log1p(gap),
        "wallet_ben_count": df.groupby("wallet")["beneficiary_id"].transform("nunique").to_numpy(),
        "ben_wallet_count": df.groupby("beneficiary_id")["wallet"].transform("nunique").to_numpy(),
    }, index=df.index)[FEATURES]
