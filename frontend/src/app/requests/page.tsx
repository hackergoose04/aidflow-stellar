"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { get, STATUSES, type AidRequest, type Status } from "@/lib/api";
import { formatAmount, formatTime, STATUS_STYLE } from "@/lib/format";
import { Button, Card, ErrorNote, FlagChips, PageHeader, Select, StatusBadge } from "@/components/ui";

type SortKey = "created_at" | "risk_score" | "amount";
type RequestGroup = "attention" | "awaiting" | "on-chain" | "closed";

const GROUPS: { id: RequestGroup; label: string; statuses: Status[] }[] = [
  { id: "attention", label: "Needs attention", statuses: ["INVALID", "PENDING_REVIEW", "HELD", "UNKNOWN"] },
  { id: "awaiting", label: "Awaiting payout", statuses: ["APPROVED"] },
  { id: "on-chain", label: "On chain", statuses: ["SUBMITTED", "CONFIRMED", "CLAIMED"] },
  { id: "closed", label: "Closed", statuses: ["REJECTED", "FAILED"] },
];

function RequestsTable() {
  const params = useSearchParams();
  const router = useRouter();
  const rawStatus = params.get("status");
  const status = STATUSES.includes(rawStatus as Status) ? rawStatus as Status : null;
  const rawGroup = params.get("group");
  const group = GROUPS.some((item) => item.id === rawGroup) ? rawGroup as RequestGroup : null;
  const [rows, setRows] = useState<AidRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [sort, setSort] = useState<SortKey>("created_at");
  const [batch, setBatch] = useState("");
  const [realId, setRealId] = useState("");

  useEffect(() => {
    get<AidRequest[]>("/requests")
      .then((r) => { setRows(r); setError(null); }, (e) => setError((e as Error).message));
  }, []);

  const grouped = useMemo(() => {
    if (status) return (rows ?? []).filter((r) => r.status === status);
    if (group) {
      const selected = GROUPS.find((item) => item.id === group);
      return (rows ?? []).filter((r) => selected?.statuses.includes(r.status));
    }
    return rows ?? [];
  }, [rows, status, group]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = grouped.filter((r) =>
      (!onlyFlagged || r.flags.length > 0)
      && (!batch || r.batch_id === batch)
      && (!q || [r.request_ref, r.beneficiary_id, r.wallet].some((v) => v.toLowerCase().includes(q))));
    const val = (r: AidRequest) =>
      sort === "risk_score" ? r.risk_score ?? -1 : sort === "amount" ? Number(r.amount) : Date.parse(r.created_at);
    return list.sort((a, b) => val(b) - val(a));
  }, [grouped, query, onlyFlagged, sort, batch]);

  const batches = useMemo(
    () => [...new Set((rows ?? []).map((r) => r.batch_id ?? ""))].filter(Boolean).sort(),
    [rows],
  );
  const groupCounts = useMemo(() => Object.fromEntries(GROUPS.map(({ id, statuses }) => [
    id, rows ? rows.filter((r) => statuses.includes(r.status)).length : undefined,
  ])) as Record<RequestGroup, number | undefined>, [rows]);

  function setView(next: { status?: Status | null; group?: RequestGroup | null }) {
    const params = new URLSearchParams();
    if (next.status) params.set("status", next.status);
    else if (next.group) params.set("group", next.group);
    router.replace(params.size ? `/requests?${params}` : "/requests", { scroll: false });
  }

  async function lookup() {
    if (!realId.trim()) return;
    try {
      const { token } = await get<{ token: string }>(`/beneficiaries/lookup?id=${encodeURIComponent(realId.trim())}`);
      setQuery(token);
      setRealId("");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function clearFilters() {
    setQuery("");
    setBatch("");
    setSort("created_at");
    setOnlyFlagged(false);
    setRealId("");
    setView({});
  }

  const hasFilters = !!(status || group || query || batch || onlyFlagged);

  return (
    <>
      <PageHeader title="Requests" subtitle="Every request the system has seen, with flags, AI risk and payout status." />
      <ErrorNote error={error} />

      <nav aria-label="Request workflow filters" className="dock-strip mb-5 flex gap-1 overflow-x-auto border-b border-zinc-200">
        <Tab active={!status && !group} onClick={() => setView({})}>
          All <TabCount value={rows?.length} />
        </Tab>
        {GROUPS.map(({ id, label }) => (
          <Tab key={id} active={group === id && !status} onClick={() => setView({ group: id })}>
            {label} <TabCount value={groupCounts[id]} />
          </Tab>
        ))}
      </nav>

      <Card flush>
        <div className="border-b border-zinc-100 px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="relative min-w-[220px] flex-1 sm:max-w-xl">
              <span className="sr-only">Search requests</span>
              <svg aria-hidden viewBox="0 0 20 20" fill="none" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400">
                <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Search reference, beneficiary or wallet"
                className="input h-10 w-full pl-9" />
            </label>
            <div className="ml-auto flex items-center gap-3">
              <span aria-live="polite" className="whitespace-nowrap text-[12px] tabular-nums text-zinc-500">
                Showing <span className="font-medium text-zinc-800">{shown.length}</span> of {grouped.length}
              </span>
              {hasFilters && (
                <button onClick={clearFilters} className="whitespace-nowrap text-[12px] font-medium text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline">
                  Clear filters
                </button>
              )}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select label="Filter by status" className="w-44" value={status ?? ""}
              onChange={(v) => setView({ status: (v as Status) || null })}
              options={[{ value: "", label: "All statuses" },
                ...STATUSES.map((s) => ({ value: s, label: STATUS_STYLE[s].label, dot: STATUS_STYLE[s].dot,
                  hint: String(rows?.filter((r) => r.status === s).length ?? "") }))]} />
            <Select label="Filter by batch" className="w-48" value={batch} onChange={setBatch}
              options={[{ value: "", label: "All batches" },
                ...batches.map((b) => ({ value: b, label: b, hint: String(rows?.filter((r) => r.batch_id === b).length ?? "") }))]} />
            <Select label="Sort requests" className="w-40" value={sort} onChange={(v) => setSort(v as SortKey)}
              options={[{ value: "created_at", label: "Newest first" }, { value: "risk_score", label: "Highest AI risk" },
                { value: "amount", label: "Largest amount" }]} />
            <form onSubmit={(e) => { e.preventDefault(); lookup(); }} className="flex items-center gap-1"
              title="The real ID is hashed on the server to find this person's token. It is not stored.">
              <input value={realId} onChange={(e) => setRealId(e.target.value)} placeholder="Real beneficiary ID" className="input w-44" />
              <Button size="sm" variant="ghost" disabled={!realId.trim()}>Find</Button>
            </form>
            <button type="button" role="switch" aria-checked={onlyFlagged} onClick={() => setOnlyFlagged((value) => !value)}
              className={`ml-auto inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors ${
                onlyFlagged ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
              }`}>
              <span className={`relative h-4 w-7 rounded-full transition-colors ${onlyFlagged ? "bg-white/30" : "bg-zinc-300"}`}>
                <span className={`absolute top-0.5 h-3 w-3 rounded-full transition-all ${onlyFlagged ? "left-3.5 bg-white" : "left-0.5 bg-white"}`} />
              </span>
              Flagged only
            </button>
          </div>

        </div>

        {rows === null && !error ? (
          <div className="px-5 py-14 text-center text-[13px] text-zinc-500">Loading requests…</div>
        ) : rows?.length === 0 && !error ? (
          <EmptyState title="No requests yet" description="No requests have been received by the system." />
        ) : shown.length === 0 && !error ? (
          <EmptyState title="No matching requests" description="Try adjusting your filters or search terms." action={
            <button onClick={clearFilters} className="text-[13px] font-medium text-zinc-900 underline underline-offset-4">Clear all filters</button>
          } />
        ) : rows && rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[1000px]">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Beneficiary</th>
                  <th className="text-right">Amount</th>
                  <th>AI risk</th>
                  <th>Flags</th>
                  <th>Status</th>
                  <th>Submitted</th>
                  <th><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.request_ref} className="transition-colors hover:bg-zinc-50">
                    <td className="whitespace-nowrap">
                      <Link href={`/requests/${encodeURIComponent(r.request_ref)}`} className="font-mono text-[12px] font-medium text-zinc-900 hover:underline">
                        {r.request_ref}
                      </Link>
                      {r.batch_id && <div className="mt-1 text-[11px] text-zinc-400">{r.batch_id}</div>}
                    </td>
                    <td className="whitespace-nowrap font-mono text-[12px] text-zinc-600">{r.beneficiary_id}</td>
                    <td className="text-right font-medium tabular-nums">{formatAmount(r.amount)} <span className="text-[11px] font-normal text-zinc-400">{r.asset}</span></td>
                    <td><RiskLevel score={r.risk_score} /></td>
                    <td className="max-w-[220px]"><FlagChips flags={r.flags} /></td>
                    <td className="whitespace-nowrap"><StatusBadge status={r.status} /></td>
                    <td className="whitespace-nowrap text-[12px] text-zinc-500">{formatTime(r.created_at)}</td>
                    <td className="whitespace-nowrap text-right">
                      <Link href={`/requests/${encodeURIComponent(r.request_ref)}`}
                        className="text-[12px] font-medium text-zinc-700 hover:text-zinc-950 hover:underline">
                        {r.status === "PENDING_REVIEW" || r.status === "INVALID" || r.status === "HELD" ? "Review" : "View"}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`dock-item -mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 pb-3 pt-1.5 text-[13px] transition-[color,border-color,transform] duration-200 ${
        active ? "border-zinc-900 font-medium text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-900"}`}>
      {children}
    </button>
  );
}

function TabCount({ value }: { value?: number }) {
  return <span className="text-[11px] tabular-nums text-zinc-400">{value ?? "—"}</span>;
}

function RiskLevel({ score }: { score: number | null }) {
  if (score === null) return <span className="text-[12px] text-zinc-400">Not scored</span>;
  const level = score >= 0.9 ? "High" : score >= 0.7 ? "Medium" : "Low";
  const style = level === "High" ? "bg-rose-50 text-rose-700"
    : level === "Medium" ? "bg-amber-50 text-amber-700" : "bg-zinc-100 text-zinc-600";
  return (
    <span title={`AI risk score ${score.toFixed(3)}`} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[12px] font-medium ${style}`}>
      <span className="font-mono tabular-nums">{score.toFixed(2)}</span>
      <span>{level}</span>
    </span>
  );
}

function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-5 py-12 text-center">
      <span className="mb-4 grid h-11 w-11 place-items-center rounded-full border border-zinc-200 bg-zinc-50 text-zinc-400">
        <svg aria-hidden viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 3.75h7l4.25 4.5v11A1.75 1.75 0 0 1 16.5 21h-9A1.75 1.75 0 0 1 5.75 19.25v-13.75A1.75 1.75 0 0 1 7.5 3.75Z" />
          <path strokeLinecap="round" d="M14 4v5h4M8.5 13h7m-7 3h7" />
        </svg>
      </span>
      <h2 className="text-[14px] font-semibold text-zinc-900">{title}</h2>
      <p className="mt-1 max-w-sm text-[13px] text-zinc-500">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export default function RequestsPage() {
  return (
    <Suspense fallback={<p className="text-[13px] text-zinc-500">Loading…</p>}>
      <RequestsTable />
    </Suspense>
  );
}
