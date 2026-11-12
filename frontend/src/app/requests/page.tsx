"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { get, STATUSES, type AidRequest, type Status } from "@/lib/api";
import { formatAmount, formatTime, STATUS_STYLE } from "@/lib/format";
import { Button, Card, Empty, ErrorNote, FlagChips, PageHeader, ReconBadge, RiskBar, StatusBadge } from "@/components/ui";

type SortKey = "created_at" | "risk_score" | "amount";

function RequestsTable() {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get("status");
  const status = raw && (STATUSES as readonly string[]).includes(raw) ? (raw as Status) : null;
  const [rows, setRows] = useState<AidRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [sort, setSort] = useState<SortKey>("created_at");
  const [batch, setBatch] = useState("");
  const [realId, setRealId] = useState("");
  async function lookup() {
    if (!realId.trim()) return;
    try {
      const { token } = await get<{ token: string }>(`/beneficiaries/lookup?id=${encodeURIComponent(realId.trim())}`);
      setQuery(token);
      setRealId("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    get<AidRequest[]>(status ? `/requests?status=${status}` : "/requests")
      .then((r) => { setRows(r); setError(null); }, (e) => setError((e as Error).message));
  }, [status]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (rows ?? []).filter((r) =>
      (!onlyFlagged || r.flags.length > 0)
      && (!batch || r.batch_id === batch)
      && (!q || [r.request_ref, r.beneficiary_id, r.wallet].some((v) => v.toLowerCase().includes(q))));
    const val = (r: AidRequest) =>
      sort === "risk_score" ? r.risk_score ?? -1 : sort === "amount" ? Number(r.amount) : Date.parse(r.created_at);
    return list.sort((a, b) => val(b) - val(a));
  }, [rows, query, onlyFlagged, sort, batch]);
  const batches = useMemo(() => [...new Set((rows ?? []).map((r) => r.batch_id ?? ""))].filter(Boolean).sort(), [rows]);

  const setStatus = (s: Status | null) => router.replace(s ? `/requests?status=${s}` : "/requests");

  return (
    <>
      <PageHeader title="Requests" subtitle="Every request the system has seen, with flags, AI risk and payout status." />
      <ErrorNote error={error} />

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-zinc-200">
        <Tab active={!status} onClick={() => setStatus(null)}>All</Tab>
        {STATUSES.map((s) => (
          <Tab key={s} active={status === s} onClick={() => setStatus(s)}>{STATUS_STYLE[s].label}</Tab>
        ))}
      </div>

      <Card flush>
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-5 py-3">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search ref, token or wallet"
            className="input w-full sm:w-64" />
          <form onSubmit={(e) => { e.preventDefault(); lookup(); }} className="flex items-center gap-1"
            title="The real ID is hashed on the server to find this person's token. It is not stored.">
            <input value={realId} onChange={(e) => setRealId(e.target.value)} placeholder="Real beneficiary ID" className="input w-44" />
            <Button size="sm" variant="ghost">Find</Button>
          </form>
          <select value={batch} onChange={(e) => setBatch(e.target.value)} className="input">
            <option value="">All batches</option>
            {batches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="input">
            <option value="created_at">Newest first</option>
            <option value="risk_score">Highest AI risk</option>
            <option value="amount">Largest amount</option>
          </select>
          <label className="flex items-center gap-2 px-1 text-[13px] text-zinc-600">
            <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} className="accent-zinc-900" />
            Flagged only
          </label>
          <span className="ml-auto text-[12px] tabular-nums text-zinc-500">{shown.length} shown</span>
        </div>

        {rows === null && !error ? (
          <Empty>Loading…</Empty>
        ) : shown.length === 0 ? (
          <Empty>No requests match.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[1080px]">
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Batch</th>
                  <th>Beneficiary</th>
                  <th className="text-right">Amount</th>
                  <th>AI risk</th>
                  <th>Flags</th>
                  <th>Status</th>
                  <th>Reconciliation</th>
                  <th>Requested</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.request_ref} onClick={() => router.push(`/requests/${encodeURIComponent(r.request_ref)}`)}
                    className="cursor-pointer transition-colors hover:bg-zinc-50">
                    <td className="whitespace-nowrap font-mono text-[12px] font-medium text-zinc-900">
                      <Link href={`/requests/${encodeURIComponent(r.request_ref)}`} onClick={(e) => e.stopPropagation()}>{r.request_ref}</Link>
                    </td>
                    <td className="whitespace-nowrap text-[12px] text-zinc-500">{r.batch_id ?? "—"}</td>
                    <td className="whitespace-nowrap font-mono text-[12px] text-zinc-600">{r.beneficiary_id}</td>
                    <td className="text-right font-medium tabular-nums">{formatAmount(r.amount)}</td>
                    <td><RiskBar score={r.risk_score} /></td>
                    <td className="max-w-[260px]"><FlagChips flags={r.flags} /></td>
                    <td className="whitespace-nowrap"><StatusBadge status={r.status} /></td>
                    <td className="whitespace-nowrap"><ReconBadge category={r.recon_status} /></td>
                    <td className="whitespace-nowrap text-[12px] text-zinc-500">{formatTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`-mb-px whitespace-nowrap border-b-2 px-2.5 pb-2.5 pt-1 text-[13px] transition-colors ${
        active ? "border-zinc-900 font-medium text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}>
      {children}
    </button>
  );
}

export default function RequestsPage() {
  return (
    <Suspense fallback={<p className="text-[13px] text-zinc-500">Loading…</p>}>
      <RequestsTable />
    </Suspense>
  );
}
