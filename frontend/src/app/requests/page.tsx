"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { get, STATUSES, type AidRequest, type Status } from "@/lib/api";
import { formatAmount, formatTime, STATUS_STYLE } from "@/lib/format";
import { Card, ErrorNote, FlagChips, PageHeader, ReconBadge, RiskBar, StatusBadge } from "@/components/ui";

type SortKey = "created_at" | "risk_score" | "amount";

function RequestsTable() {
  const params = useSearchParams();
  const router = useRouter();
  const status = (params.get("status") as Status | null) ?? null;
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
      <PageHeader title="Requests" subtitle="Every request the system has seen, with its flags, AI risk and payout status." />
      <ErrorNote error={error} />

      <div className="mb-4 flex flex-wrap gap-1">
        <Tab active={!status} onClick={() => setStatus(null)}>All</Tab>
        {STATUSES.map((s) => (
          <Tab key={s} active={status === s} onClick={() => setStatus(s)}>{STATUS_STYLE[s].label}</Tab>
        ))}
      </div>

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-4">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search ref, beneficiary token or wallet"
            className="w-full max-w-xs rounded-lg border border-stone-300 px-3 py-1.5 text-sm focus:border-teal-600 focus:outline-none" />
          <form onSubmit={(e) => { e.preventDefault(); lookup(); }} className="flex items-center gap-1"
            title="The real ID is hashed on the server to find this person's token. It is not stored.">
            <input value={realId} onChange={(e) => setRealId(e.target.value)} placeholder="Find by real beneficiary ID"
              className="w-52 rounded-lg border border-stone-300 px-3 py-1.5 text-sm focus:border-teal-600 focus:outline-none" />
            <button className="rounded-lg px-2 py-1.5 text-sm text-teal-700 hover:bg-teal-50">Find</button>
          </form>
          <label className="flex items-center gap-2 text-sm text-stone-600">
            <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} className="accent-teal-700" />
            Flagged only
          </label>
          <label className="flex items-center gap-2 text-sm text-stone-600">
            Batch
            <select value={batch} onChange={(e) => setBatch(e.target.value)}
              className="rounded-lg border border-stone-300 px-2 py-1 text-sm">
              <option value="">All</option>
              {batches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-stone-600">
            Sort by
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-lg border border-stone-300 px-2 py-1 text-sm">
              <option value="created_at">Newest</option>
              <option value="risk_score">AI risk</option>
              <option value="amount">Amount</option>
            </select>
          </label>
          <span className="ml-auto text-xs text-stone-500">{shown.length} shown</span>
        </div>

        {rows === null && !error ? (
          <p className="text-sm text-stone-500">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-stone-500">No requests match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-left text-sm [&_td]:pr-3 [&_th]:pr-3 [&_th]:whitespace-nowrap">
              <thead className="text-xs text-stone-500">
                <tr>
                  <th className="py-2 font-medium">Ref</th>
                  <th className="font-medium">Batch</th>
                  <th className="font-medium">Beneficiary</th>
                  <th className="text-right font-medium">Amount</th>
                  <th className="pl-6 font-medium">AI risk</th>
                  <th className="font-medium">Flags</th>
                  <th className="font-medium">Status</th>
                  <th className="font-medium">Reconciliation</th>
                  <th className="font-medium">Requested</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.request_ref} onClick={() => router.push(`/requests/${encodeURIComponent(r.request_ref)}`)}
                    className="cursor-pointer border-t border-stone-100 hover:bg-stone-50">
                    <td className="whitespace-nowrap py-2 font-mono text-xs">
                      <Link href={`/requests/${encodeURIComponent(r.request_ref)}`}>{r.request_ref}</Link>
                    </td>
                    <td className="whitespace-nowrap text-xs text-stone-600">{r.batch_id ?? "—"}</td>
                    <td className="whitespace-nowrap">{r.beneficiary_id}</td>
                    <td className="text-right tabular-nums">{formatAmount(r.amount)}</td>
                    <td className="pl-6"><RiskBar score={r.risk_score} /></td>
                    <td className="max-w-[260px]"><FlagChips flags={r.flags} /></td>
                    <td className="whitespace-nowrap"><StatusBadge status={r.status} /></td>
                    <td className="whitespace-nowrap"><ReconBadge category={r.recon_status} /></td>
                    <td className="whitespace-nowrap text-xs text-stone-500">{formatTime(r.created_at)}</td>
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
      className={`rounded-full px-3 py-1 text-sm transition ${active ? "bg-stone-900 text-white" : "bg-white text-stone-600 ring-1 ring-stone-200 hover:bg-stone-100"}`}>
      {children}
    </button>
  );
}

export default function RequestsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-stone-500">Loading…</p>}>
      <RequestsTable />
    </Suspense>
  );
}
