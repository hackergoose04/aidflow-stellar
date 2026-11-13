"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { get, type MlMetrics, type ReconEval, type Summary } from "@/lib/api";
import { SimulatedResults } from "@/components/SimulatedResults";
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

  const threshold = summary?.risk_threshold;

  return (
    <>
      <PageHeader title="Evaluation" subtitle="How the AI screening and the reconciliation engine perform, and what the current data looks like." />
      <ErrorNote error={error} />

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card title="AI risk distribution"
          action={<Link href="/requests" className="link">View requests →</Link>}>
          {summary && <RiskHistogram bins={summary.risk_histogram} flagged={summary.risk_histogram_flagged} threshold={threshold ?? null} />}
        </Card>
        <Card title="Batches">
          {summary && summary.batches.length > 0 ? <BatchBars batches={summary.batches} /> : <p className="text-[13px] text-zinc-500">No batches yet.</p>}
        </Card>
      </div>

      {metrics ? <SimulatedResults m={metrics} recon={recon} /> : <p className="text-[13px] text-zinc-500">No model metrics yet: run <code className="font-mono text-[12px]">python ml/evaluate.py</code>.</p>}
    </>
  );
}
