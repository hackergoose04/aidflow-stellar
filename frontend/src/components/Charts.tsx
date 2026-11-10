"use client";

import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { RECON_CATEGORIES, STATUSES, type BatchSummary, type ReconCategory, type Status } from "@/lib/api";
import { RECON_STYLE, STATUS_STYLE } from "@/lib/format";

export const STATUS_COLOR: Record<Status, string> = {
  INVALID: "#b91c1c",
  PENDING_REVIEW: "#d97706",
  HELD: "#64748b",
  APPROVED: "#0284c7",
  REJECTED: "#a8a29e",
  SUBMITTED: "#6366f1",
  CONFIRMED: "#059669",
  CLAIMED: "#0f766e",
  FAILED: "#e11d48",
  UNKNOWN: "#ea580c",
};

const axis = { fontSize: 11, fill: "#78716c" };
const tooltipStyle = { fontSize: 12, borderRadius: 8, borderColor: "#e7e5e4" };

export function StatusDonut({ counts }: { counts: Record<Status, number> }) {
  const data = STATUSES.filter((s) => counts[s]).map((s) => ({ name: STATUS_STYLE[s].label, value: counts[s], status: s }));
  const total = data.reduce((n, d) => n + d.value, 0);
  if (!total) return <p className="text-sm text-stone-500">No requests yet.</p>;
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative h-48 w-48 shrink-0">
        <ResponsiveContainer>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="100%" paddingAngle={1}
              stroke="none" isAnimationActive={false}>
              {data.map((d) => <Cell key={d.status} fill={STATUS_COLOR[d.status]} />)}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-2xl font-semibold tabular-nums text-stone-900">{total}</div>
          <div className="text-xs text-stone-500">requests</div>
        </div>
      </div>
      <ul className="grid flex-1 grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {STATUSES.map((s) => (
          <li key={s} className={`flex items-center gap-2 ${counts[s] ? "" : "opacity-40"}`}>
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLOR[s] }} />
            <span className="flex-1 text-stone-600">{STATUS_STYLE[s].label}</span>
            <span className="tabular-nums font-medium text-stone-900">{counts[s]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReconBars({ counts }: { counts: Record<ReconCategory, number> }) {
  const data = RECON_CATEGORIES.map((c) => ({ name: RECON_STYLE[c].label, value: counts[c] ?? 0, c }));
  return (
    <div className="h-48">
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}>
          <XAxis type="number" allowDecimals={false} tick={axis} />
          <YAxis type="category" dataKey="name" width={130} tick={axis} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#f5f5f4" }} />
          <Bar dataKey="value" name="Requests" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.c} fill={RECON_STYLE[d.c].color} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RiskHistogram({ bins, threshold }: { bins: number[]; threshold: number }) {
  const data = bins.map((n, i) => ({ range: `${(i / 10).toFixed(1)}`, n, high: (i + 1) / 10 > threshold }));
  return (
    <div className="h-48">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ left: -16, right: 8, bottom: 8 }}>
          <CartesianGrid vertical={false} stroke="#f5f5f4" />
          <XAxis dataKey="range" tick={axis} label={{ value: "AI risk score", position: "insideBottom", offset: -6, fontSize: 11, fill: "#78716c" }} height={40} />
          <YAxis allowDecimals={false} tick={axis} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#f5f5f4" }}
            labelFormatter={(l) => `Risk ${l}–${(Number(l) + 0.1).toFixed(1)}`} />
          <Bar dataKey="n" name="Requests" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.range} fill={d.high ? "#7c3aed" : "#d6d3d1"} />)}
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
  return (
    <div className="h-56">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ left: -16, right: 8 }}>
          <CartesianGrid vertical={false} stroke="#f5f5f4" />
          <XAxis dataKey="name" tick={axis} />
          <YAxis allowDecimals={false} tick={axis} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#f5f5f4" }} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Confirmed" stackId="a" fill="#059669" isAnimationActive={false} />
          <Bar dataKey="Flagged" stackId="a" fill="#d97706" isAnimationActive={false} />
          <Bar dataKey="Other" stackId="a" fill="#d6d3d1" radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
