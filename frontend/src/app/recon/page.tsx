"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { post, RECON_CATEGORIES, type ReconCategory, type ReconReport, type ReconResult } from "@/lib/api";
import { describeReason, formatAmount, RECON_STYLE, shortKey } from "@/lib/format";
import { Button, Card, Empty, ErrorNote, PageHeader, ReconBadge, StatusBadge, TxLink } from "@/components/ui";

const assetLabel = (a: string | undefined) => (a ? (a === "native" ? "XLM" : a.split(":")[0]) : "—");

export default function ReconPage() {
  return (
    <Suspense fallback={<p className="text-[13px] text-zinc-500">Loading…</p>}>
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
        subtitle="Every request is checked against what the NGO wallet actually sent on Stellar. The memo, a SHA-256 of the request ID, links the two."
        action={<Button onClick={run} disabled={busy}>{busy ? "Reading the chain…" : "Run reconciliation"}</Button>} />
      <ErrorNote error={error} />

      {!report && !error && (
        <Card flush><Empty>{busy ? "Reading the chain…" : "Run a reconciliation to compare our records with the chain."}</Empty></Card>
      )}

      {report && (
        <>
          <div className="mb-3 grid grid-cols-2 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] md:grid-cols-5">
            {RECON_CATEGORIES.map((c, i) => (
              <button key={c} onClick={() => setFilter(c)} title={RECON_STYLE[c].why}
                className={`relative border-zinc-100 px-5 py-4 text-left transition-colors ${i % 2 ? "border-l" : ""} ${i > 0 ? "md:border-l" : ""} ${i > 1 ? "border-t md:border-t-0" : ""} ${
                  filter === c ? "bg-zinc-50" : "hover:bg-zinc-50/60"}`}>
                {filter === c && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-zinc-900" />}
                <div className="flex items-center gap-1.5 text-[12px] text-zinc-500">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: RECON_STYLE[c].color }} />
                  {RECON_STYLE[c].label}
                </div>
                <div className={`mt-1 text-[22px] font-semibold tracking-tight tabular-nums ${c === "MISMATCH" && report.summary[c] ? "text-rose-600" : "text-zinc-900"}`}>
                  {report.summary[c]}
                </div>
              </button>
            ))}
            <div className="col-span-2 border-t border-zinc-100 px-5 py-4 md:col-span-1 md:border-t-0 md:border-l">
              <div className="text-[12px] text-zinc-500">On chain, not in records</div>
              <div className={`mt-1 text-[22px] font-semibold tracking-tight tabular-nums ${report.summary.UNRECORDED_ON_CHAIN ? "text-amber-600" : "text-zinc-900"}`}>
                {report.summary.UNRECORDED_ON_CHAIN}
              </div>
            </div>
          </div>
          <p className="mb-5 text-[12px] text-zinc-500">
            {report.chain_ops_checked} on-chain payouts read · {report.results.length} requests checked ·{" "}
            <button className="link" onClick={() => setFilter("ALL")}>show all</button>
          </p>

          <Card flush
            title={<>{filter === "ALL" ? "All requests" : RECON_STYLE[filter].label} <span className="ml-1 font-normal tabular-nums text-zinc-400">{shown.length}</span></>}
            action={filter !== "ALL" && RECON_STYLE[filter].why}>
            {shown.length === 0 ? (
              <Empty>Nothing in this category.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table min-w-[860px]">
                  <thead>
                    <tr>
                      <th>Request</th>
                      <th>Result</th>
                      <th>Amount · ours → chain</th>
                      <th>Wallet</th>
                      <th>Asset</th>
                      <th>Status</th>
                      <th>Transaction</th>
                    </tr>
                  </thead>
                  <tbody>{shown.slice(0, 300).map((r) => <Row key={r.request_ref} r={r} />)}</tbody>
                </table>
                {shown.length > 300 && <p className="border-t border-zinc-100 px-5 py-2 text-[12px] text-zinc-500">Showing the first 300.</p>}
              </div>
            )}
          </Card>

          {report.unrecorded_on_chain.length > 0 && (
            <Card className="mt-6" flush
              title={<>On chain, not in our records <span className="ml-1 font-normal tabular-nums text-zinc-400">{report.unrecorded_on_chain.length}</span></>}
              action="Test transactions, or a payment made outside AidFlow">
              <ul className="max-h-64 divide-y divide-zinc-100 overflow-y-auto text-[13px]">
                {report.unrecorded_on_chain.map((op) => (
                  <li key={op.tx_hash} className="flex flex-wrap items-center gap-4 px-5 py-2">
                    <span className="w-28 font-medium tabular-nums">{formatAmount(op.amount)} {assetLabel(op.asset)}</span>
                    <span className="font-mono text-[12px] text-zinc-500">→ {shortKey(op.to)}</span>
                    <span className="ml-auto"><TxLink hash={op.tx_hash} /></span>
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
  const cell = (ok: boolean) => (ok ? "" : "font-medium text-rose-600");
  return (
    <tr className="align-top">
      <td>
        <Link href={`/requests/${encodeURIComponent(r.request_ref)}`} className="font-mono text-[12px] font-medium hover:underline">{r.request_ref}</Link>
      </td>
      <td>
        <ReconBadge category={r.category} />
        {r.reasons.length > 0 && (
          <ul className="mt-1 text-[12px] text-zinc-500">
            {r.reasons.map((x) => <li key={x}>{describeReason(x)}</li>)}
          </ul>
        )}
      </td>
      <td className="whitespace-nowrap tabular-nums">
        {formatAmount(r.internal.amount)} <span className="text-zinc-300">→</span> <span className={cell(!bad.has("amount_differs"))}>{c ? formatAmount(c.amount) : "—"}</span>
      </td>
      <td className="whitespace-nowrap font-mono text-[12px]">
        {shortKey(r.internal.wallet)} <span className="text-zinc-300">→</span> <span className={cell(!bad.has("wallet_differs"))}>{c ? shortKey(c.to) : "—"}</span>
      </td>
      <td className="whitespace-nowrap text-[12px]">
        {assetLabel(r.internal.asset)} <span className="text-zinc-300">→</span> <span className={cell(!bad.has("asset_differs"))}>{assetLabel(c?.asset)}</span>
      </td>
      <td><StatusBadge status={r.internal.status} /></td>
      <td>
        <div className="flex flex-col gap-0.5">
          {c ? <TxLink hash={c.tx_hash} /> : <span className="text-[12px] text-zinc-400">none on chain</span>}
          {r.chain_count > 1 && <span className="text-[12px] text-rose-600">{r.chain_count} payouts</span>}
        </div>
      </td>
    </tr>
  );
}
