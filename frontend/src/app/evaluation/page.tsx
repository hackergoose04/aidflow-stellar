"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { get, type MlMetrics, type ReconEval, type Summary } from "@/lib/api";
import { pct } from "@/lib/format";
import { Card, ErrorNote, PageHeader } from "@/components/ui";
import { BatchBars, RiskHistogram } from "@/components/Charts";

export default function EvaluationPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [metrics, setMetrics] = useState<MlMetrics | null>(null);
  const [recon, setRecon] = useState<ReconEval | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<Summary>("/summary").then(setSummary, (e) => setError((e as Error).message));
    get<MlMetrics>("/ml/metrics").then(setMetrics, () => setMetrics(null));
    get<ReconEval>("/eval/recon").then(setRecon, () => setRecon(null));
  }, []);

  return (
    <>
      <PageHeader title="Evaluation" subtitle="How the AI screening and the reconciliation engine perform, and what the current data looks like." />
      <ErrorNote error={error} />

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card title="AI risk distribution"
          action={<Link href="/requests" className="link">Review threshold {metrics?.threshold ?? 0.9} →</Link>}>
          {summary && <RiskHistogram bins={summary.risk_histogram} threshold={metrics?.threshold ?? 0.9} />}
        </Card>
        <Card title="Batches">
          {summary && summary.batches.length > 0 ? <BatchBars batches={summary.batches} /> : <p className="text-[13px] text-zinc-500">No batches yet.</p>}
        </Card>
      </div>

      {metrics ? <Evaluation m={metrics} recon={recon} /> : <p className="text-[13px] text-zinc-500">No model metrics yet: run <code className="font-mono text-[12px]">python ml/evaluate.py</code>.</p>}
    </>
  );
}

function Evaluation({ m, recon }: { m: MlMetrics; recon: ReconEval | null }) {
  const rows: [string, string, typeof m.ml][] = [
    ["All manual review", "baseline", m.manual_all],
    ["Rules only", "", m.rules],
    ["AI model only", "", m.ml],
    ["Rules + AI", "live", m.rules_or_ml],
  ];
  const types = Object.keys(m.ml.recall_by_type);
  return (
    <>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-[15px] font-semibold text-zinc-900">Evaluation</h2>
        <span className="text-[12px] text-zinc-500">{m.test_rows.toLocaleString()} simulated requests · {m.anomalies} injected anomalies</span>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Less manual review, same anomalies caught" flush>
          <div className="overflow-x-auto">
            <table className="data-table min-w-[560px]">
              <thead>
                <tr>
                  <th>Approach</th>
                  <th className="text-right">Sent to review</th>
                  <th className="text-right">Workload saved</th>
                  <th className="text-right">Caught</th>
                  <th className="text-right">Precision</th>
                  <th className="text-right">False positives</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {rows.map(([name, tag, r]) => (
                  <tr key={name} className={tag === "live" ? "bg-zinc-50/80" : ""}>
                    <td className="font-medium text-zinc-900">
                      {name}
                      {tag && <span className={`ml-2 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ${tag === "live" ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-500"}`}>{tag}</span>}
                    </td>
                    <td className="text-right">{pct(r.review_share)}</td>
                    <td className={`text-right font-medium ${tag === "live" ? "text-emerald-600" : "text-zinc-900"}`}>{100 - Math.round(r.review_share * 100)}%</td>
                    <td className="text-right">{pct(r.recall)}</td>
                    <td className="text-right">{pct(r.precision)}</td>
                    <td className="text-right">{pct(r.false_positive_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
            Simulated data shows the workflow works, not real-world accuracy. On labelled PaySim fraud the model,
            refit on its own history, finds about half the fraud in the top 10% it ranks.
          </p>
        </Card>

        <Card title="Reconciliation accuracy">
          {recon ? (
            <>
              <div className="text-[40px] font-semibold leading-none tracking-tight tabular-nums text-zinc-900">{pct(recon.category_accuracy)}</div>
              <p className="mt-2 text-[13px] text-zinc-500">of {recon.records.toLocaleString()} records put in the right category</p>
              <dl className="mt-5 flex flex-col divide-y divide-zinc-100 border-y border-zinc-100 text-[13px]">
                <div className="flex justify-between py-2"><dt className="text-zinc-500">Exact reason given</dt><dd className="tabular-nums font-medium">{pct(recon.reason_accuracy)}</dd></div>
                <div className="flex justify-between py-2"><dt className="text-zinc-500">Stray payouts found</dt><dd className="tabular-nums font-medium">{recon.strays_found} / {recon.stray_payouts}</dd></div>
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
