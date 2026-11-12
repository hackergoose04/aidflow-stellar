"use client";

import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { STATUSES, type BatchSummary, type Status } from "@/lib/api";
import { STATUS_STYLE } from "@/lib/format";

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

export function RiskHistogram({ bins, threshold }: { bins: number[]; threshold: number }) {
  const data = bins.map((n, i) => ({ range: `${(i / 10).toFixed(1)}`, n, high: (i + 1) / 10 > threshold }));
  return (
    <div className="h-44">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ left: -24, right: 4, top: 4, bottom: 0 }} barCategoryGap={3}>
          <CartesianGrid vertical={false} stroke="#f4f4f5" />
          <XAxis dataKey="range" tick={axis} tickLine={false} axisLine={{ stroke: "#e4e4e7" }} />
          <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={tooltipStyle} cursor={cursor}
            labelFormatter={(l) => `Risk ${l}–${(Number(l) + 0.1).toFixed(1)}`} />
          <ReferenceLine x={(Math.floor(threshold * 10) / 10).toFixed(1)} stroke="#a1a1aa" strokeDasharray="3 3" />
          <Bar dataKey="n" name="Requests" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.range} fill={d.high ? "#f43f5e" : "#d4d4d8"} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
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
