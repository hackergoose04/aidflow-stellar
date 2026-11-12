"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  get, post, uploadCsv,
  type ClaimResult, type MlMetrics, type PayoutResult, type ReconEval, type Summary, type UploadReport, type VerifyResult, type Wallet,
} from "@/lib/api";
import { formatAmount, pct, shortKey } from "@/lib/format";
import { Button, Card, ErrorNote, Notice, PageHeader, ReviewerInput, Stats, useReviewer } from "@/components/ui";
import { BatchBars, RiskHistogram, StatusBreakdown } from "@/components/Charts";

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
      <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) run("upload", () => uploadCsv(f), (r) => { setUpload(r); return `Uploaded ${f.name}.`; });
          e.target.value = "";
        }} />
      <PageHeader
        eyebrow={summary?.registry.program ?? "Aid programme"}
        title="Overview"
        action={<ReviewerInput value={reviewer} onChange={setReviewer} compact />}
      />
      <ErrorNote error={error} />
      {message && <Notice tone="success">{message}</Notice>}
      {upload && <UploadResult report={upload} />}

      <Stats items={[
        { label: "NGO balance", value: wallet ? formatAmount(wallet.balances.AIDUSD ?? 0) : "—", hint: "AIDUSD available" },
        { label: "Paid out", value: (s?.CONFIRMED ?? 0) + (s?.CLAIMED ?? 0), hint: `${s?.CLAIMED ?? 0} claimed by beneficiary` },
        { label: "Pending or failed", value: (s?.SUBMITTED ?? 0) + (s?.UNKNOWN ?? 0) + (s?.FAILED ?? 0), hint: "on chain",
          tone: (s?.FAILED ?? 0) + (s?.UNKNOWN ?? 0) ? "text-rose-600" : undefined },
      ]} />

      <Card title="Pipeline" action="Nothing is paid until a person approves it" flush className="mb-6">
        <div className="grid sm:grid-cols-2 lg:grid-cols-5">
          <Step n={1} title="Upload" count={total} caption="validated and screened">
            <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} disabled={!!busy}>
              {busy === "upload" ? "Uploading…" : "Choose CSV"}
            </Button>
          </Step>
          <Step n={2} title="Review" count={needsReview}
            caption={<>need a person · <Link href="/review" className="link">open queue</Link></>}>
            <Button size="sm" disabled={!!busy || !pendingClean || !reviewer.trim()}
              title={!reviewer.trim() ? "Enter your name as reviewer first" : undefined}
              onClick={() => run("approve", () => post<{ approved: number }>("/review/approve-clean", { reviewer }),
                (r) => `Approved ${r.approved} requests with no flags.`)}>
              Approve {pendingClean} clean
            </Button>
          </Step>
          <Step n={3} title="Pay" count={s?.APPROVED ?? 0} caption="approved, ready to send">
            <Button size="sm" disabled={!!busy || !s?.APPROVED}
              onClick={() => run("pay", () => post<PayoutResult[]>("/payouts/run"), (r) => {
                const ok = r.filter((x) => x.status === "CONFIRMED").length;
                return <>Sent {r.length}: {ok} confirmed. <Link className="link" href="/payouts">See payouts</Link></>;
              })}>
              {busy === "pay" ? "Paying…" : "Run payouts"}
            </Button>
          </Step>
          <Step n={4} title="Verify" count={(s?.SUBMITTED ?? 0) + (s?.UNKNOWN ?? 0)} caption="awaiting chain result">
            <Button size="sm" variant="secondary" disabled={!!busy}
              onClick={() => run("verify", async () => ({
                v: await post<VerifyResult[]>("/payouts/verify"),
                c: await post<ClaimResult[]>("/payouts/claims"),
              }), ({ v, c }) => `Verified ${v.length} unclear transactions. ${c.filter((x) => x.claim_status === "CLAIMED").length} of ${c.length} claimable balances picked up.`)}>
              {busy === "verify" ? "Checking…" : "Verify"}
            </Button>
          </Step>
          <Step n={5} title="Reconcile" count={summary?.recon.MISMATCH ?? 0} caption="mismatches with the chain"
            alert={!!summary?.recon.MISMATCH}>
            <Link href="/recon?run=1"><Button size="sm" variant="secondary">Run</Button></Link>
          </Step>
        </div>
      </Card>

      <div className="mb-6 grid items-start gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <Card title="Requests by status" action={`${total} total`}>
            {s && <StatusBreakdown counts={s} />}
          </Card>
          <Card title="AI risk distribution"
            action={<Link href="/requests" className="link">Review threshold {metrics?.threshold ?? 0.9} →</Link>}>
            {summary && <RiskHistogram bins={summary.risk_histogram} threshold={metrics?.threshold ?? 0.9} />}
          </Card>
        </div>
        <Card title="Accounts on Stellar">
          {wallet ? (
            <dl className="flex flex-col gap-4 text-[13px]">
              <div>
                <dt className="text-zinc-500">NGO wallet</dt>
                <dd className="mt-0.5 flex items-baseline justify-between gap-2">
                  <a href={wallet.explorer} target="_blank" rel="noreferrer" className="link font-mono text-[12px]">{shortKey(wallet.account, 6)} ↗</a>
                  <span className="tabular-nums text-zinc-500">{formatAmount(Number(wallet.balances.XLM ?? 0).toFixed(0))} XLM</span>
                </dd>
              </div>
              {summary?.registry.enabled && (
                <div className="border-t border-zinc-100 pt-4">
                  <dt className="text-zinc-500">Payout registry · Soroban</dt>
                  <dd className="mt-0.5">
                    {summary.registry.explorer && (
                      <a href={summary.registry.explorer} target="_blank" rel="noreferrer" className="link font-mono text-[12px]">
                        {shortKey(summary.registry.contract, 6)} ↗
                      </a>
                    )}
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      {([["Paid", summary.registry.PAID], ["Blocked", summary.registry.BLOCKED], ["Reserved", summary.registry.RESERVED]] as const).map(([k, v]) => (
                        <div key={k} className="rounded-md bg-zinc-50 px-2.5 py-2">
                          <div className="text-[16px] font-semibold tabular-nums text-zinc-900">{v ?? 0}</div>
                          <div className="text-[11px] text-zinc-500">{k}</div>
                        </div>
                      ))}
                    </div>
                    <p className="mt-3 text-[12px] leading-relaxed text-zinc-500">Blocks repeat payments in the same payout slot.</p>
                  </dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="text-[13px] text-zinc-500">{walletError ?? "Loading…"}</p>
          )}
        </Card>
      </div>

      {summary && summary.batches.length > 0 && (
        <Card title="Batches" className="mb-6">
          <BatchBars batches={summary.batches} />
        </Card>
      )}

      {metrics && <Evaluation m={metrics} recon={reconEval} />}
    </>
  );
}

function Step({ n, title, count, caption, alert = false, children }: {
  n: number; title: string; count: number; caption: React.ReactNode; alert?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col border-zinc-100 px-5 py-4 max-lg:border-b lg:border-l lg:first:border-l-0">
      <div className="flex items-center gap-2 text-[12px] text-zinc-500">
        <span className="font-mono text-zinc-400">0{n}</span>{title}
      </div>
      <div className={`mt-2 text-[26px] font-semibold leading-none tracking-tight tabular-nums ${alert ? "text-rose-600" : "text-zinc-900"}`}>{count}</div>
      <div className="mt-1.5 flex-1 text-[12px] text-zinc-500">{caption}</div>
      <div className="mt-4 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function UploadResult({ report }: { report: UploadReport }) {
  return (
    <Card title="Upload result" className="mb-6" flush
      action={<span className="tabular-nums">{report.received} received · {report.accepted} accepted · {report.flagged.length} flagged · {report.rejected.length} rejected</span>}>
      {report.rejected.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>Line</th><th>Ref</th><th>Why rejected</th></tr></thead>
            <tbody>
              {report.rejected.map((r) => (
                <tr key={`${r.line}`}>
                  <td className="tabular-nums">{r.line}</td>
                  <td className="font-mono text-[12px]">{r.request_ref ?? "—"}</td>
                  <td className="text-rose-600">{r.reasons.join(", ").replaceAll("_", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="px-5 py-3 text-[13px] text-zinc-500">Every row passed validation.</div>}
    </Card>
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
      <div className="mb-3 mt-10 flex items-baseline justify-between gap-4">
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
