# AidFlow frontend

Next.js 15 (App Router) + Tailwind 4. Talks to the FastAPI backend.

```bash
npm install
npm run dev        # http://localhost:3000  (backend must run on :8000)
```

Backend URL defaults to `http://127.0.0.1:8000`. Override with `NEXT_PUBLIC_API_URL`
in `frontend/.env.local`.

| Page | What it's for |
| --- | --- |
| `/` Overview | Balance, the 5 pipeline steps as buttons, decision-to-money-in-hand metrics, status counts, Stellar accounts |
| `/evaluation` | Charts (AI risk distribution, batches) and the model / reconciliation scorecards |
| `/review` | Review queue: flagged requests sorted by AI risk, with plain-language reasons; approve / hold / reject; invalid records to correct |
| `/requests` | All requests: filter by status, search, sort by risk |
| `/requests/[ref]` | One request: details, flags, transaction link, audit trail, approve / hold / reject / correct / retry, delivery and registry status |
| `/payouts` | Pay approved requests, verify unclear ones and check claims; delivery and registry status |
| `/recon` | Reconciliation report: matched, problems, unknown on-chain payouts (`?run=1` runs it on open) |
| `/donor` | Public donor view: totals, batches, and a per-payment check that reads Stellar directly in the browser (`?ref=` to open one) |
| `/claim` | Public beneficiary page: connect a Stellar wallet (Stellar Wallets Kit), see payouts waiting for it, claim them in one transaction signed by the wallet |

Code: `src/lib/api.ts` (types + fetch), `src/lib/format.ts` (labels, flag wording),
`src/components/ui.tsx` (shared pieces).

Tailwind is pinned to 4.1.14: newer versions need Node ≥ 20.19.
