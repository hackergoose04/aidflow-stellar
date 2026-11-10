"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { post, RECON_CATEGORIES, type ReconCategory, type ReconReport, type ReconResult } from "@/lib/api";
import { describeReason, formatAmount, RECON_STYLE, shortKey } from "@/lib/format";
import { Button, Card, ErrorNote, PageHeader, ReconBadge, StatusBadge, TxLink } from "@/components/ui";

const assetLabel = (a: string | undefined) => (a ? (a === "native" ? "XLM" : a.split(":")[0]) : "—");

export default function ReconPage() {
  return (
    <Suspense fallback={<p className="text-sm text-stone-500">Loading…</p>}>
      <Recon />
    </Suspense>
  );
}

function Recon() {
  const params = useSearchParams();
  const autoRan = useRef(false);
  const [report, setReport] = useState<ReconReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<ReconCategory | "ALL">("MISMATCH");

  async function run() {
    setBusy(true);
    try {
      const r = await post<ReconReport>("/recon/run");
      setReport(r);
      setFilter(r.summary.MISMATCH ? "MISMATCH" : "ALL");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // /recon?run=1 runs straight away (reconciliation only reads the chain).
  useEffect(() => {
    if (params.get("run") === "1" && !autoRan.current) {
      autoRan.current = true;
      run();
    }
  });

  const shown = useMemo(() => {
    const order: Record<ReconCategory, number> = { MISMATCH: 0, PENDING_VERIFICATION: 1, MATCHED: 2, NOT_EXECUTED: 3 };
    return (report?.results ?? [])
      .filter((r) => filter === "ALL" || r.category === filter)
      .sort((a, b) => order[a.category] - order[b.category] || a.request_ref.localeCompare(b.request_ref));
  }, [report, filter]);

  return (
    <>
      <PageHeader title="Reconciliation"
        subtitle="Every request is checked against what the NGO wallet actually sent on Stellar: transaction, amount, wallet, asset and status. The memo (a SHA-256 fingerprint of the request ID) links the two."
        action={<Button onClick={run} disabled={busy}>{busy ? "Reading the chain…" : "Run reconciliation"}</Button>} />
      <ErrorNote error={error} />

      {!report && !error && (
        <Card><p className="text-sm text-stone-500">Run a reconciliation to compare our records with the chain.</p></Card>
      )}

      {report && (
        <>
          <div className="mb-2 grid grid-cols-2 gap-3 md:grid-cols-5">
            {RECON_CATEGORIES.map((c) => (
              <button key={c} onClick={() => setFilter(c)} title={RECON_STYLE[c].why}
                className={`rounded-xl border bg-white px-4 py-3 text-left transition ${filter === c ? "border-stone-900" : "border-stone-200 hover:border-stone-400"}`}>
                <div className="text-3xl font-semibold tabular-nums" style={{ color: RECON_STYLE[c].color }}>{report.summary[c]}</div>
                <div className="text-xs text-stone-500">{RECON_STYLE[c].label}</div>
              </button>
            ))}
            <div className="rounded-xl border border-stone-200 bg-white px-4 py-3">
              <div className="text-3xl font-semibold tabular-nums text-amber-700">{report.summary.UNRECORDED_ON_CHAIN}</div>
              <div className="text-xs text-stone-500">On chain, not in our records</div>
            </div>
          </div>
          <p className="mb-4 text-xs text-stone-500">
            {report.chain_ops_checked} on-chain payouts read · {report.results.length} requests checked ·{" "}
            <button className="underline" onClick={() => setFilter("ALL")}>show all</button>
          </p>

          {report.summary.MISMATCH === 0 && report.summary.MATCHED > 0 && (
            <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              No mismatches: every confirmed payout is on chain exactly once, with the right amount, wallet and asset.
            </div>
          )}
          {report.summary.MISMATCH === 0 && report.summary.MATCHED === 0 && (
            <div className="mb-4 rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm text-stone-600">
              No mismatches, but nothing has been paid yet, so there is nothing to match. Approve and pay some requests first.
            </div>
          )}

          <Card title={`${filter === "ALL" ? "All requests" : RECON_STYLE[filter].label} · ${shown.length}`}
            action={filter !== "ALL" && <span className="text-xs text-stone-500">{RECON_STYLE[filter].why}</span>}>
            {shown.length === 0 ? (
              <p className="text-sm text-stone-500">Nothing in this category.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-left text-sm">
                  <thead className="text-xs text-stone-500">
                    <tr>
                      <th className="py-2 font-medium">Request</th>
                      <th className="font-medium">Result</th>
                      <th className="font-medium">Amount (ours → chain)</th>
                      <th className="font-medium">Wallet</th>
                      <th className="font-medium">Asset</th>
                      <th className="font-medium">Status</th>
                      <th className="font-medium">Transaction</th>
                    </tr>
                  </thead>
                  <tbody>{shown.slice(0, 300).map((r) => <Row key={r.request_ref} r={r} />)}</tbody>
                </table>
                {shown.length > 300 && <p className="mt-2 text-xs text-stone-500">Showing the first 300.</p>}
              </div>
            )}
          </Card>

          {report.unrecorded_on_chain.length > 0 && (
            <Card className="mt-4" title={`On chain, not in our records · ${report.unrecorded_on_chain.length}`}>
              <p className="mb-2 text-xs text-stone-500">
                Payouts from the NGO wallet whose memo matches no request here: test transactions, or a payment made outside AidFlow.
              </p>
              <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-sm">
                {report.unrecorded_on_chain.map((op) => (
                  <li key={op.tx_hash} className="flex flex-wrap items-center gap-3">
                    <span className="tabular-nums">{formatAmount(op.amount)} {assetLabel(op.asset)}</span>
                    <span className="font-mono text-xs text-stone-500">→ {shortKey(op.to)}</span>
                    <TxLink hash={op.tx_hash} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </>
  );
}

function Row({ r }: { r: ReconResult }) {
  const bad = new Set(r.reasons);
  const c = r.chain;
  const cell = (ok: boolean) => (ok ? "" : "font-medium text-rose-700");
  return (
    <tr className="border-t border-stone-100 align-top">
      <td className="py-2">
        <Link href={`/requests/${encodeURIComponent(r.request_ref)}`} className="font-mono text-xs hover:underline">{r.request_ref}</Link>
      </td>
      <td>
        <ReconBadge category={r.category} />
        {r.reasons.length > 0 && (
          <ul className="mt-1 text-xs text-stone-600">
            {r.reasons.map((x) => <li key={x}>{describeReason(x)}</li>)}
          </ul>
        )}
      </td>
      <td className="tabular-nums">
        {formatAmount(r.internal.amount)} → <span className={cell(!bad.has("amount_differs"))}>{c ? formatAmount(c.amount) : "—"}</span>
      </td>
      <td className="font-mono text-xs">
        {shortKey(r.internal.wallet)} → <span className={cell(!bad.has("wallet_differs"))}>{c ? shortKey(c.to) : "—"}</span>
      </td>
      <td className="text-xs">
        {assetLabel(r.internal.asset)} → <span className={cell(!bad.has("asset_differs"))}>{assetLabel(c?.asset)}</span>
      </td>
      <td><StatusBadge status={r.internal.status} /></td>
      <td>
        <div className="flex flex-col gap-0.5">
          {c ? <TxLink hash={c.tx_hash} /> : <span className="text-xs text-stone-400">none on chain</span>}
          {r.chain_count > 1 && <span className="text-xs text-rose-700">{r.chain_count} payouts</span>}
        </div>
      </td>
    </tr>
  );
}
