"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  get, post, uploadCsv,
  type ClaimResult, type MlMetrics, type PayoutResult, type ReconEval, type Summary, type UploadReport, type VerifyResult, type Wallet,
} from "@/lib/api";
import { formatAmount, formatTime, pct, shortKey } from "@/lib/format";
import { Button, Card, ErrorNote, PageHeader, ReviewerInput, useReviewer } from "@/components/ui";
import { BatchBars, ReconBars, RiskHistogram, StatusDonut } from "@/components/Charts";

export default function Overview() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MlMetrics | null>(null);
  const [reconEval, setReconEval] = useState<ReconEval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<React.ReactNode>(null);
  const [upload, setUpload] = useState<UploadReport | null>(null);
  const [reviewer, setReviewer] = useReviewer();
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setSummary(await get<Summary>("/summary"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    get<Wallet>("/wallet").then(setWallet, (e) => setWalletError((e as Error).message));
    get<MlMetrics>("/ml/metrics").then(setMetrics, () => setMetrics(null));
    get<ReconEval>("/eval/recon").then(setReconEval, () => setReconEval(null));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function run<T>(label: string, fn: () => Promise<T>, done: (r: T) => React.ReactNode) {
    setBusy(label);
    setMessage(null);
    try {
      setMessage(done(await fn()));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      refresh();
    }
  }

  const s = summary?.by_status;
  const pendingClean = s ? s.PENDING_REVIEW - (summary?.pending_flagged ?? 0) : 0;
  const total = s ? Object.values(s).reduce((a, b) => a + b, 0) : 0;
  const needsReview = (summary?.pending_flagged ?? 0) + (s?.HELD ?? 0) + (s?.INVALID ?? 0);

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Payment requests are checked on upload, reviewed by a person, paid on Stellar Testnet, then reconciled against the chain."
        action={<ReviewerInput value={reviewer} onChange={setReviewer} />}
      />
      <ErrorNote error={error} />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Payment requests" value={total} />
        <Kpi label="Confirmed disbursements" value={(s?.CONFIRMED ?? 0) + (s?.CLAIMED ?? 0)} tone="text-emerald-700" />
        <Kpi label="Pending or failed" value={(s?.SUBMITTED ?? 0) + (s?.UNKNOWN ?? 0) + (s?.FAILED ?? 0)} tone="text-rose-700" />
        <Kpi label="Requiring review" value={needsReview} tone="text-amber-700" href="/review" />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="NGO wallet">
          {wallet ? (
            <>
              <div className="text-3xl font-semibold tabular-nums text-stone-900">
                {formatAmount(wallet.balances.AIDUSD ?? 0)}
                <span className="ml-1.5 text-base font-normal text-stone-500">AIDUSD</span>
              </div>
              <div className="mt-1 text-sm text-stone-500">{formatAmount(wallet.balances.XLM ?? 0)} XLM for fees</div>
              <a href={wallet.explorer} target="_blank" rel="noreferrer"
                className="mt-3 inline-block font-mono text-xs text-teal-700 hover:underline">
                {shortKey(wallet.account, 6)} ↗
              </a>
              {summary?.registry.enabled && (
                <div className="mt-4 border-t border-stone-100 pt-3 text-sm">
                  <div className="font-medium text-stone-900">On-chain payout registry</div>
                  <p className="mt-0.5 text-xs text-stone-500">One payout per person per batch, enforced by a Soroban contract. Stores hashes only.</p>
                  <div className="mt-2 flex gap-4 text-xs">
                    <span><b className="tabular-nums text-emerald-700">{summary.registry.PAID ?? 0}</b> paid</span>
                    <span><b className="tabular-nums text-rose-700">{summary.registry.BLOCKED ?? 0}</b> blocked</span>
                    <span><b className="tabular-nums text-stone-700">{summary.registry.RESERVED ?? 0}</b> reserved</span>
                  </div>
                  {summary.registry.explorer && (
                    <a href={summary.registry.explorer} target="_blank" rel="noreferrer"
                      className="mt-2 inline-block font-mono text-xs text-teal-700 hover:underline">
                      {shortKey(summary.registry.contract, 6)} ↗
                    </a>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-stone-500">{walletError ?? "Loading…"}</p>
          )}
        </Card>
        <Card title="Requests by status" className="md:col-span-2">
          {s && <StatusDonut counts={s} />}
        </Card>
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-stone-500">Pipeline</h2>
      <div className="grid gap-3 md:grid-cols-5">
        <Step n={1} title="Upload" text="CSV of payment requests. Bad rows are rejected; the rest are screened by rules and the AI model.">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) run("upload", () => uploadCsv(f), (r) => { setUpload(r); return `Uploaded ${f.name}`; });
              e.target.value = "";
            }} />
          <Button onClick={() => fileRef.current?.click()} disabled={!!busy}>
            {busy === "upload" ? "Uploading…" : "Choose CSV"}
          </Button>
        </Step>

        <Step n={2} title="Review" text={`${summary?.pending_flagged ?? 0} flagged, ${s?.HELD ?? 0} held and ${s?.INVALID ?? 0} invalid need a person. ${pendingClean} have no flags.`}>
          <div className="flex flex-wrap gap-2">
            <Link href="/review"><Button variant="secondary">Open queue</Button></Link>
            <Button disabled={!!busy || !pendingClean || !reviewer.trim()}
              title={!reviewer.trim() ? "Enter your name as reviewer first" : undefined}
              onClick={() => run("approve", () => post<{ approved: number }>("/review/approve-clean", { reviewer }),
                (r) => `Approved ${r.approved} requests with no flags.`)}>
              Approve {pendingClean} clean
            </Button>
          </div>
        </Step>

        <Step n={3} title="Pay" text={`${s?.APPROVED ?? 0} approved. Registers each on chain, then sends AIDUSD on Stellar Testnet.`}>
          <Button disabled={!!busy || !s?.APPROVED}
            onClick={() => run("pay", () => post<PayoutResult[]>("/payouts/run"), (r) => {
              const ok = r.filter((x) => x.status === "CONFIRMED").length;
              return <>Sent {r.length}: {ok} confirmed. <Link className="underline" href="/payouts">See payouts</Link></>;
            })}>
            {busy === "pay" ? "Paying…" : "Run payouts"}
          </Button>
        </Step>

        <Step n={4} title="Verify" text={`${(s?.SUBMITTED ?? 0) + (s?.UNKNOWN ?? 0)} waiting. Looks unclear transactions up by hash, and checks which claimable balances were picked up.`}>
          <Button variant="secondary" disabled={!!busy}
            onClick={() => run("verify", async () => ({
              v: await post<VerifyResult[]>("/payouts/verify"),
              c: await post<ClaimResult[]>("/payouts/claims"),
            }), ({ v, c }) => `Verified ${v.length} unclear transactions. ${c.filter((x) => x.claim_status === "CLAIMED").length} of ${c.length} claimable balances picked up.`)}>
            {busy === "verify" ? "Checking…" : "Verify"}
          </Button>
        </Step>

        <Step n={5} title="Reconcile" text="Matches every request with what the wallet actually sent on chain.">
          <Link href="/recon?run=1"><Button variant="secondary">Run</Button></Link>
        </Step>
      </div>

      {message && (
        <div className="mt-4 rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-900">{message}</div>
      )}
      {upload && <UploadResult report={upload} />}

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Card title="Reconciliation results"
          action={<span className="text-xs text-stone-500">{summary?.last_recon ? `last run ${formatTime(summary.last_recon)}` : "not run yet"}</span>}>
          {summary && <ReconBars counts={summary.recon} />}
          <Link href="/recon?run=1" className="text-xs text-teal-700 hover:underline">Run reconciliation →</Link>
        </Card>
        <Card title="Anomaly scores"
          action={<span className="text-xs text-stone-500">purple bins hold scores at or above the review threshold{metrics ? ` (${metrics.threshold})` : ""}</span>}>
          {summary && <RiskHistogram bins={summary.risk_histogram} threshold={metrics?.threshold ?? 0.9} />}
          <Link href="/requests" className="text-xs text-teal-700 hover:underline">Sort requests by risk →</Link>
        </Card>
      </div>

      {summary && summary.batches.length > 0 && (
        <Card title="Disbursement batches" className="mt-4">
          <BatchBars batches={summary.batches} />
        </Card>
      )}

      {metrics && <Evaluation m={metrics} recon={reconEval} />}
    </>
  );
}

function Kpi({ label, value, tone = "text-stone-900", href }: { label: string; value: number; tone?: string; href?: string }) {
  const body = (
    <div className="rounded-xl border border-stone-200 bg-white px-4 py-3 transition hover:border-stone-300">
      <div className={`text-2xl font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="text-xs text-stone-500">{label}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function Step({ n, title, text, children }: { n: number; title: string; text: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-stone-200 bg-white p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-stone-900 text-[11px] font-semibold text-white">{n}</span>
        <span className="font-medium text-stone-900">{title}</span>
      </div>
      <p className="mb-3 flex-1 text-xs leading-relaxed text-stone-500">{text}</p>
      {children}
    </div>
  );
}

function UploadResult({ report }: { report: UploadReport }) {
  return (
    <Card title="Upload result" className="mt-4">
      <div className="mb-3 flex flex-wrap gap-6 text-sm">
        <span><b className="tabular-nums">{report.received}</b> rows received</span>
        <span className="text-emerald-700"><b className="tabular-nums">{report.accepted}</b> accepted</span>
        <span className="text-amber-700"><b className="tabular-nums">{report.flagged.length}</b> flagged for review</span>
        <span className="text-rose-700"><b className="tabular-nums">{report.rejected.length}</b> rejected</span>
      </div>
      {report.rejected.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-stone-500">
            <tr><th className="py-1 font-medium">Line</th><th className="font-medium">Ref</th><th className="font-medium">Why rejected</th></tr>
          </thead>
          <tbody>
            {report.rejected.map((r) => (
              <tr key={`${r.line}`} className="border-t border-stone-100">
                <td className="py-1.5 tabular-nums">{r.line}</td>
                <td className="font-mono text-xs">{r.request_ref ?? "—"}</td>
                <td className="text-rose-700">{r.reasons.join(", ").replaceAll("_", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Evaluation({ m, recon }: { m: MlMetrics; recon: ReconEval | null }) {
  const rows: [string, string, typeof m.ml][] = [
    ["All manual review", "baseline", m.manual_all],
    ["Rule-based", "", m.rules],
    ["AI model only", "", m.ml],
    ["Rules + AI", "live", m.rules_or_ml],
  ];
  const types = Object.keys(m.ml.recall_by_type);
  return (
    <>
      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-stone-500">Evaluation</h2>
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2" title="Can AI reduce manual review and still catch irregular payments?"
          action={<span className="text-xs text-stone-500">{m.test_rows} simulated requests, {m.anomalies} injected anomalies</span>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-xs text-stone-500">
                <tr>
                  <th className="py-1 font-medium">Approach</th>
                  <th className="font-medium">Sent to review</th>
                  <th className="font-medium">Workload saved</th>
                  <th className="font-medium">Anomalies caught</th>
                  <th className="font-medium">Precision</th>
                  <th className="font-medium">False positive rate</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([name, tag, r]) => (
                  <tr key={name} className={`border-t border-stone-100 ${tag === "live" ? "bg-teal-50/50" : ""}`}>
                    <td className="py-2 font-medium text-stone-800">
                      {name}{tag && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-stone-400">{tag}</span>}
                    </td>
                    <td className="tabular-nums">{pct(r.review_share)}</td>
                    <td className="tabular-nums font-medium text-teal-800">{100 - Math.round(r.review_share * 100)}%</td>
                    <td className="tabular-nums">{pct(r.recall)}</td>
                    <td className="tabular-nums">{pct(r.precision)}</td>
                    <td className="tabular-nums">{pct(r.false_positive_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-xs text-stone-500">Caught by anomaly type</summary>
            <table className="mt-2 w-full text-left text-xs">
              <thead className="text-stone-500">
                <tr><th className="py-1 font-medium">Approach</th>{types.map((t) => <th key={t} className="font-medium">{t.replaceAll("_", " ")}</th>)}</tr>
              </thead>
              <tbody>
                {rows.slice(1).map(([name, , r]) => (
                  <tr key={name} className="border-t border-stone-100">
                    <td className="py-1.5">{name}</td>
                    {types.map((t) => (
                      <td key={t} className={`tabular-nums ${r.recall_by_type[t] >= 0.9 ? "text-emerald-700" : r.recall_by_type[t] < 0.5 ? "text-rose-600" : ""}`}>
                        {pct(r.recall_by_type[t])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          <p className="mt-3 text-xs text-stone-500">
            Simulated data: these numbers show the workflow works, not real-world accuracy. On labelled PaySim fraud the
            model, refit on its own history, finds about half the fraud in the top 10% it ranks (see ml/README.md).
          </p>
        </Card>

        <Card title="Reconciliation accuracy">
          {recon ? (
            <>
              <div className="text-3xl font-semibold tabular-nums text-emerald-700">{pct(recon.category_accuracy)}</div>
              <p className="mt-1 text-sm text-stone-600">
                of {recon.records.toLocaleString()} records put in the right category, with {pct(recon.reason_accuracy)} giving the exact reason.
                {" "}{recon.strays_found}/{recon.stray_payouts} stray payouts found.
              </p>
              <p className="mt-2 text-xs text-stone-500">
                {Object.keys(recon.by_scenario).length} kinds of injected discrepancy: wrong amount, wallet or asset; missing; paid twice; paid although rejected or failed; still pending; claimed.
              </p>
              <p className="mt-2 text-xs text-stone-400">{recon.note}</p>
            </>
          ) : (
            <p className="text-sm text-stone-500">Run <code className="text-xs">python scripts/recon_eval.py</code>.</p>
          )}
        </Card>
      </div>
    </>
  );
}
