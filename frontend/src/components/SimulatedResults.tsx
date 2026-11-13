"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MlMetrics, ReconEval } from "@/lib/api";
import { pct } from "@/lib/format";
import { Button, Card } from "@/components/ui";

export function SimulatedResults({ m, recon }: { m: MlMetrics; recon: ReconEval | null }) {
  const [view, setView] = useState<"table" | "chart">("table");
  const rows: [string, string, typeof m.ml][] = [
    ["All manual review", "baseline", m.manual_all],
    ["Rules only", "", m.rules],
    ["AI model only", "", m.ml],
    ["Rules + AI", "combined", m.rules_or_ml],
  ];
  const types = Object.keys(m.ml.recall_by_type);
  const chart = rows.map(([approach, , result]) => ({ approach, review: result.review_share, recall: result.recall, precision: result.precision }));
  return (
    <>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-[15px] font-semibold text-zinc-900">Evaluation</h2>
        <span className="text-[12px] text-zinc-500">{m.test_rows.toLocaleString()} simulated requests · {m.anomalies} injected anomalies</span>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Screening benchmark" flush action={
          <div className="flex gap-1" role="group" aria-label="Benchmark view">
            <Button size="sm" variant={view === "table" ? "primary" : "ghost"} aria-pressed={view === "table"} onClick={() => setView("table")}>Table</Button>
            <Button size="sm" variant={view === "chart" ? "primary" : "ghost"} aria-pressed={view === "chart"} onClick={() => setView("chart")}>Chart</Button>
          </div>
        }>
          {view === "chart" ? (
            <div className="h-72 px-3 py-3">
              <ResponsiveContainer>
                <BarChart data={chart} margin={{ left: -12, right: 12, top: 8, bottom: 4 }}>
                  <CartesianGrid vertical={false} stroke="#e4e4e7" />
                  <XAxis dataKey="approach" tick={{ fontSize: 11 }} interval={0} />
                  <YAxis domain={[0, 1]} tickFormatter={pct} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(value) => pct(Number(value))} />
                  <Legend />
                  <Bar dataKey="review" name="Sent to review" fill="#64748b" isAnimationActive={false} />
                  <Bar dataKey="recall" name="Anomalies caught (recall)" fill="#0f766e" isAnimationActive={false} />
                  <Bar dataKey="precision" name="Precision" fill="#6d42c5" isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <div className="overflow-x-auto">
            <table className="data-table min-w-[560px]">
              <thead>
                <tr>
                  <th>Approach</th>
                  <th className="text-right">Sent to review</th>
                  <th className="text-right">Workload saved</th>
                  <th className="text-right">Recall</th>
                  <th className="text-right">Precision</th>
                  <th className="text-right">False-positive rate</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {rows.map(([name, tag, r]) => (
                  <tr key={name} className={tag === "combined" ? "bg-zinc-50/80" : ""}>
                    <td className="font-medium text-zinc-900">
                      {name}
                      {tag && <span className={`ml-2 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ${tag === "combined" ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-500"}`}>{tag}</span>}
                    </td>
                    <td className="text-right">{pct(r.review_share)}</td>
                    <td className={`text-right font-medium ${tag === "combined" ? "text-emerald-600" : "text-zinc-900"}`}>{100 - Math.round(r.review_share * 100)}%</td>
                    <td className="text-right">{pct(r.recall)}</td>
                    <td className="text-right">{pct(r.precision)}</td>
                    <td className="text-right">{pct(r.false_positive_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
          <details className="border-t border-zinc-100 text-[13px]">
            <summary className="cursor-pointer px-5 py-2.5 text-[12px] text-zinc-500 hover:text-zinc-900">Caught by anomaly type</summary>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr><th>Approach</th>{types.map((t) => <th key={t} className="text-right capitalize">{t.replaceAll("_", " ")}</th>)}</tr>
                </thead>
                <tbody className="tabular-nums">
                  {rows.slice(1).map(([name, , r]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      {types.map((t) => (
                        <td key={t} className={`text-right ${r.recall_by_type[t] < 0.5 ? "text-rose-600" : r.recall_by_type[t] >= 0.9 ? "text-zinc-900" : "text-zinc-500"}`}>
                          {pct(r.recall_by_type[t])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="border-t border-zinc-100 px-5 py-3 text-[12px] leading-relaxed text-zinc-500">
            These saved synthetic benchmark results use the original demo model and policy. The live Review queue uses its current model and settings.
          </p>
        </Card>

        <Card title="Reconciliation accuracy">
          <p className="mb-4 text-[13px] text-zinc-600">Reconciliation compares AidFlow’s payment records with the Stellar ledger to find mismatches and payouts with no matching record.</p>
          {recon ? (
            <>
              <div className="rounded-xl border border-teal-100 bg-teal-50 p-4">
                <div className="text-[36px] font-semibold leading-none tabular-nums text-teal-800">{pct(recon.category_accuracy)}</div>
                <p className="mt-2 text-[12px] text-teal-800">Correct status across {recon.records.toLocaleString()} simulated records</p>
              </div>
              <dl className="mt-4 flex flex-col divide-y divide-zinc-100 border-y border-zinc-100 text-[13px]">
                <div className="flex justify-between py-2"><dt className="text-zinc-500">Exact reason given</dt><dd className="tabular-nums font-medium">{pct(recon.reason_accuracy)}</dd></div>
                <div className="flex justify-between py-2"><dt className="text-zinc-500">Unrecorded payouts found</dt><dd className="tabular-nums font-medium text-teal-800">{recon.strays_found} / {recon.stray_payouts}</dd></div>
                <div className="flex justify-between py-2"><dt className="text-zinc-500">Discrepancy kinds</dt><dd className="tabular-nums font-medium">{Object.keys(recon.by_scenario).length}</dd></div>
              </dl>
              <p className="mt-3 text-[12px] text-zinc-400">{recon.note}</p>
            </>
          ) : (
            <p className="text-[13px] text-zinc-500">Run <code className="font-mono text-[12px]">python scripts/recon_eval.py</code>.</p>
          )}
        </Card>
      </div>
    </>
  );
}
