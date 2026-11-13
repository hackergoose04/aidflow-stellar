"use client";

import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { STATUSES, type BatchSummary, type Status } from "@/lib/api";
import { describeFlag, STATUS_STYLE } from "@/lib/format";
import { CutoffPreview } from "@/components/CutoffPreview";

const axis = { fontSize: 11, fill: "#a1a1aa" };
const tooltipStyle = {
  fontSize: 12, borderRadius: 6, border: "1px solid #e4e4e7", boxShadow: "0 4px 12px rgba(0,0,0,0.06)", padding: "6px 10px",
};
const cursor = { fill: "#f4f4f5" };

/** One segmented bar for the whole pipeline, with a compact legend underneath. */
export function StatusBreakdown({ counts }: { counts: Record<Status, number> }) {
  const total = STATUSES.reduce((n, s) => n + (counts[s] ?? 0), 0);
  if (!total) return <p className="text-[13px] text-zinc-500">No requests yet.</p>;
  return (
    <div>
      <div className="flex h-2 gap-[2px] overflow-hidden rounded-full">
        {STATUSES.filter((s) => counts[s]).map((s) => (
          <div key={s} title={`${STATUS_STYLE[s].label}: ${counts[s]}`}
            style={{ flexGrow: counts[s], flexBasis: 0, minWidth: 3, background: STATUS_STYLE[s].dot }} />
        ))}
      </div>
      <ul className="mt-5 grid grid-cols-2 gap-x-8 gap-y-2.5 text-[13px] sm:grid-cols-3 xl:grid-cols-4">
        {STATUSES.map((s) => (
          <li key={s} className={`flex items-center gap-2 ${counts[s] ? "" : "opacity-40"}`}>
            <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: STATUS_STYLE[s].dot }} />
            <span className="flex-1 truncate text-zinc-600">{STATUS_STYLE[s].label}</span>
            <span className="font-medium tabular-nums text-zinc-900">{counts[s]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RiskHistogram({ bins, flagged = [], threshold }: { bins: number[]; flagged?: number[]; threshold: number | null }) {
  const data = bins.map((n, i) => ({ range: `${(i / 10).toFixed(1)}`, below: n - (flagged[i] ?? 0), above: flagged[i] ?? 0 }));
  return (
    <div>
      <div className="h-44">
        <ResponsiveContainer>
          <BarChart data={data} margin={{ left: -24, right: 4, top: 4, bottom: 0 }} barCategoryGap={3}>
            <CartesianGrid vertical={false} stroke="#f4f4f5" />
            <XAxis dataKey="range" tick={axis} tickLine={false} axisLine={{ stroke: "#e4e4e7" }} />
            <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={tooltipStyle} cursor={cursor}
              labelFormatter={(l) => `Risk ${l}–${(Number(l) + 0.1).toFixed(1)}`} />
            <Bar dataKey="below" name="Below ML cutoff" stackId="risk" fill="#d4d4d8" isAnimationActive={false} />
            <Bar dataKey="above" name="At or above ML cutoff" stackId="risk" fill="#dc2626" isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-zinc-600">
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-zinc-300" /> Below ML cutoff</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-red-600" /> At or above ML cutoff</span>
        {threshold !== null && <span>Current ML cutoff: {Number(threshold.toFixed(6))}</span>}
      </div>
      <p className="mt-2 text-[12px] text-zinc-500">Colors reflect the ML cutoff used when each request was scored. Rules such as duplicates can send lower-scoring requests to Review.</p>
      {threshold !== null && <CutoffPreview key={threshold} threshold={threshold} />}
    </div>
  );
}

export function StatusDonut({ counts }: { counts: Record<Status, number> }) {
  const data = STATUSES.filter((status) => counts[status] > 0).map((status) => ({
    status, name: STATUS_STYLE[status].label, count: counts[status],
  }));
  const total = data.reduce((sum, item) => sum + item.count, 0);
  if (!total) return <p className="text-[13px] text-zinc-500">No requests yet.</p>;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative mx-auto size-40 shrink-0">
        <ResponsiveContainer>
          <PieChart>
            <Pie data={data} dataKey="count" nameKey="name" innerRadius="65%" outerRadius="98%" stroke="none" isAnimationActive={false}>
              {data.map(({ status }) => <Cell key={status} fill={STATUS_STYLE[status].dot} />)}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid content-center text-center">
          <strong className="text-[22px] tabular-nums">{total.toLocaleString()}</strong>
          <span className="text-[12px] text-zinc-500">requests</span>
        </div>
      </div>
      <ul className="grid min-w-36 flex-1 grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-5 gap-y-2 text-[13px]">
        {STATUSES.map((status) => <li key={status} className={`flex items-center gap-2 ${counts[status] ? "" : "opacity-50"}`}>
          <span className="size-2 shrink-0 rounded-sm" style={{ background: STATUS_STYLE[status].dot }} />
          <span className="flex-1 text-zinc-600">{STATUS_STYLE[status].label}</span>
          <span className="tabular-nums">{(counts[status] ?? 0).toLocaleString()}</span>
        </li>)}
      </ul>
    </div>
  );
}

export function ReviewReasonBars({ reasons, total }: { reasons: Record<string, number>; total: number }) {
  const ordered = Object.entries(reasons).sort(([a, n], [b, m]) => m - n || a.localeCompare(b));
  if (!total) return <p className="text-[13px] text-zinc-500">No requests need review.</p>;
  return (
    <>
      <p className="mb-4 text-[12px] text-zinc-500">{total.toLocaleString()} requests need review. Each request counts once per reason and can appear in multiple bars.</p>
      <ul className="space-y-3">
        {ordered.map(([reason, count]) => <li key={reason}>
          <div className="mb-1 flex justify-between gap-3 text-[13px]">
            <span>{describeFlag(reason).label}</span><span className="tabular-nums">{count.toLocaleString()}</span>
          </div>
          <div className="h-2 rounded bg-zinc-100" aria-hidden="true">
            <div className="h-full rounded bg-amber-500" style={{ width: `${count / total * 100}%` }} />
          </div>
        </li>)}
      </ul>
    </>
  );
}

export function BatchBars({ batches }: { batches: BatchSummary[] }) {
  const data = batches.map((b) => ({
    name: b.batch_id ?? "—", Confirmed: b.confirmed, Flagged: b.flagged,
    Other: Math.max(0, b.requests - b.confirmed - b.flagged),
  }));
  const legend = [["Confirmed", "#16a34a"], ["Flagged", "#f59e0b"], ["Other", "#e4e4e7"]];
  return (
    <div>
      <div className="mb-3 flex gap-4 text-[12px] text-zinc-500">
        {legend.map(([k, c]) => (
          <span key={k} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px]" style={{ background: c }} />{k}</span>
        ))}
      </div>
      <div className="h-52">
        <ResponsiveContainer>
          <BarChart data={data} margin={{ left: -24, right: 4, top: 4 }} barCategoryGap="30%">
            <CartesianGrid vertical={false} stroke="#f4f4f5" />
            <XAxis dataKey="name" tick={axis} tickLine={false} axisLine={{ stroke: "#e4e4e7" }} />
            <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={tooltipStyle} cursor={cursor} />
            <Bar dataKey="Confirmed" stackId="a" fill="#16a34a" maxBarSize={44} isAnimationActive={false} />
            <Bar dataKey="Flagged" stackId="a" fill="#f59e0b" maxBarSize={44} isAnimationActive={false} />
            <Bar dataKey="Other" stackId="a" fill="#e4e4e7" radius={[3, 3, 0, 0]} maxBarSize={44} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
