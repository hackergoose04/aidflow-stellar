"use client";

import { useState } from "react";
import { Button, ErrorNote } from "@/components/ui";
import { get, type CutoffPreview as CutoffPreviewResult } from "@/lib/api";

export function CutoffPreview({ threshold }: { threshold: number }) {
  const [cutoff, setCutoff] = useState(String(threshold));
  const [result, setResult] = useState<CutoffPreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function preview() {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      setResult(await get<CutoffPreviewResult>(`/ml/cutoff-preview?cutoff=${encodeURIComponent(cutoff)}`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="mt-3 border-t border-zinc-100 pt-2">
      <summary className="w-fit cursor-pointer text-[13px] font-medium text-teal-800 hover:underline">Preview cutoff</summary>
      <div className="mt-3 space-y-3 text-[12px] text-zinc-600">
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-950">
          Keep the calibrated cutoff unless validation data supports a change. A lower cutoff can increase review workload and false positives. A higher cutoff can miss anomalies. Amount, time, and duplicate rules are evaluated independently.
        </p>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void preview(); }}>
          <label className="grid gap-1">
            Candidate cutoff
            <input className="input w-44 tabular-nums" type="number" min="0" max="1" step="any" required disabled={busy}
              value={cutoff} onChange={(event) => { setCutoff(event.target.value); setResult(null); setError(null); }} />
          </label>
          <Button type="submit" size="sm" variant="secondary" disabled={busy}>{busy ? "Calculating…" : "Preview impact"}</Button>
        </form>
        <ErrorNote error={error} />
        {result && (
          <table className="data-table tabular-nums" aria-label="Cutoff impact on pending requests">
            <thead><tr><th>Pending requests</th><th className="text-right">Current</th><th className="text-right">Preview</th></tr></thead>
            <tbody>
              <tr><th scope="row">ML flagged</th><td className="text-right">{result.current.ml_flags.toLocaleString()}</td><td className="text-right">{result.preview.ml_flags.toLocaleString()}</td></tr>
              <tr><th scope="row">Flagged for Review (ML or rules)</th><td className="text-right">{result.current.review.toLocaleString()}</td><td className="text-right">{result.preview.review.toLocaleString()}</td></tr>
            </tbody>
          </table>
        )}
        <p>Read-only preview using saved scores. Older rounded scores may affect counts near the cutoff.</p>
      </div>
    </details>
  );
}
