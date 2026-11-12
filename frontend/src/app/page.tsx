"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  get, payAll, post, uploadCsv,
  type ClaimResult, type Delivery, type DeliveryCost, type Summary, type UploadReport, type VerifyResult, type Wallet,
} from "@/lib/api";
import { formatAmount, formatDuration, formatHours, shortKey } from "@/lib/format";
import { Button, Card, ErrorNote, Notice, PageHeader, ReviewerInput, Stats, useReviewer } from "@/components/ui";
import { StatusBreakdown } from "@/components/Charts";

export default function Overview() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [cost, setCost] = useState<DeliveryCost | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
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
    get<Delivery>("/delivery").then(setDelivery, () => setDelivery(null));
    get<DeliveryCost>("/delivery/cost").then(setCost, () => setCost(null));
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
        { label: "Pending or failed", value: (s?.SUBMITTED ?? 0) + (s?.UNKNOWN ?? 0) + (s?.FAILED ?? 0), hint: "need attention",
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
              onClick={() => run("pay", () => {
                const total = s?.APPROVED ?? 0;
                setProgress(`0 of ${total}`);
                return payAll(async (done) => { setProgress(`${Math.min(done, total)} of ${total}`); await refresh(); });
              }, (r) => {
                const ok = r.filter((x) => x.status === "CONFIRMED").length;
                return <>Sent {r.length}: {ok} confirmed. <Link className="link" href="/payouts">See payouts</Link></>;
              })}>
              {busy === "pay" ? `Paying ${progress}…` : "Run payouts"}
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

      {delivery && (delivery.timing.approved_to_chain.n > 0 || delivery.unclaimed.length > 0) && <LastMile d={delivery} cost={cost} />}

      <div className="mb-6 grid items-start gap-6 lg:grid-cols-3">
        <Card title="Requests by status" action={<Link href="/evaluation" className="link">Charts and model evaluation →</Link>} className="lg:col-span-2">
          {s && <StatusBreakdown counts={s} />}
        </Card>
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

/** The Problem Space goal: shorten "decided to pay" -> "money in hand", and treat arrival as the start. */
function LastMile({ d, cost }: { d: Delivery; cost: DeliveryCost | null }) {
  const t = d.timing;
  const overdue = d.unclaimed.filter((u) => u.overdue).length;
  const scale = Math.max(cost?.benchmark ?? 0.064, cost?.cost_share ?? 0);
  const bars: [string, number | undefined, string][] = [
    ["AidFlow", cost?.cost_share, "bg-emerald-500"],
    ["UN target", cost?.target, "bg-zinc-300"],
    ["Global average", cost?.benchmark, "bg-zinc-300"],
  ];
  return (
    <Card title="From decision to money in hand" action={<Link href="/payouts" className="link">Payouts →</Link>} flush className="mb-6">
      <div className="grid lg:grid-cols-3">
        <section className="border-zinc-100 px-5 py-4 max-lg:border-b">
          <div className="text-[12px] text-zinc-500">Approval → money in hand</div>
          <div className="mt-1 text-[26px] font-semibold tracking-tight tabular-nums text-zinc-900">
            {t.approved_to_hand.n ? formatDuration(t.approved_to_hand.median_s) : "—"}
          </div>
          <div className="text-[12px] text-zinc-500">
            {t.approved_to_hand.n
              ? <>median of {t.approved_to_hand.n} payouts{t.approved_to_hand.max_s !== null && ` · slowest ${formatDuration(t.approved_to_hand.max_s)}`}</>
              : `nothing received yet · ${t.not_in_hand_yet} sent, waiting to be claimed`}
          </div>
          <dl className="mt-4 divide-y divide-zinc-100 border-t border-zinc-100 text-[13px]">
            <div className="flex justify-between py-2"><dt className="text-zinc-500">Sent → final on chain</dt><dd className="font-medium tabular-nums">{formatDuration(t.submitted_to_chain.median_s)}</dd></div>
            <div className="flex justify-between py-2"><dt className="text-zinc-500">Approval → on chain</dt><dd className="font-medium tabular-nums">{formatDuration(t.approved_to_chain.median_s)}</dd></div>
            <div className="flex justify-between py-2"><dt className="text-zinc-500">Typical aid disbursement</dt><dd className="text-zinc-500">weeks</dd></div>
          </dl>
        </section>

        <section className="border-zinc-100 px-5 py-4 max-lg:border-b lg:border-l">
          <div className="text-[12px] text-zinc-500">Network cost per payout</div>
          {cost?.payouts ? (
            <>
              <div className="mt-1 text-[26px] font-semibold tracking-tight tabular-nums text-zinc-900">
                {((cost.cost_share ?? 0) * 100).toFixed(2)}%
              </div>
              <div className="text-[12px] text-zinc-500">of the amount delivered · ≈ ${(cost.avg_fee_usd ?? 0).toFixed(3)} each</div>
              <ul className="mt-4 flex flex-col gap-2 text-[12px]">
                {bars.map(([label, v, color]) => (
                  <li key={label} className="grid grid-cols-[6.5rem_1fr_2.75rem] items-center gap-2">
                    <span className="text-zinc-500">{label}</span>
                    <span className="h-1.5 rounded-full bg-zinc-100">
                      <span className={`block h-full rounded-full ${color}`} style={{ width: `${((v ?? 0) / scale) * 100}%`, minWidth: 3 }} />
                    </span>
                    <span className="text-right font-medium tabular-nums">{((v ?? 0) * 100).toFixed(label === "AidFlow" ? 2 : 1)}%</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] leading-relaxed text-zinc-400">
                Fees actually charged on Testnet (payment + registry), at ${cost.xlm_usd?.toFixed(2)}/XLM. Excludes cash-out.
              </p>
            </>
          ) : <p className="mt-2 text-[13px] text-zinc-500">{cost ? "No payouts yet." : "Reading fees from Stellar…"}</p>}
        </section>

        <section className="border-zinc-100 px-5 py-4 lg:border-l">
          <div className="text-[12px] text-zinc-500">Last mile · sent but not yet received</div>
          <div className={`mt-1 text-[26px] font-semibold tracking-tight tabular-nums ${overdue ? "text-rose-600" : "text-zinc-900"}`}>{d.unclaimed.length}</div>
          <div className="text-[12px] text-zinc-500">
            {overdue ? `${overdue} waiting over ${formatHours(d.alert_hours)}: follow up` : `none waiting over ${formatHours(d.alert_hours)}`}
          </div>
          {d.unclaimed.length > 0 ? (
            <ul className="mt-4 divide-y divide-zinc-100 border-t border-zinc-100 text-[13px]">
              {d.unclaimed.slice(0, 3).map((u) => (
                <li key={u.request_ref} className="flex items-center justify-between gap-2 py-2">
                  <Link href={`/requests/${encodeURIComponent(u.request_ref)}`} className="truncate font-mono text-[12px] hover:underline">{u.request_ref}</Link>
                  <span className="shrink-0 tabular-nums text-zinc-500">{formatAmount(u.amount)}</span>
                  <span className={`shrink-0 text-[12px] tabular-nums ${u.overdue ? "font-medium text-rose-600" : "text-zinc-500"}`}>{formatHours(u.waiting_hours)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-4 border-t border-zinc-100 pt-3 text-[13px] text-zinc-500">Everything sent has been received.</p>}
          <p className="mt-3 text-[11px] leading-relaxed text-zinc-400">Arrival is the start: unclaimed money is tracked, and the NGO can reclaim it after 30 days.</p>
        </section>
      </div>
    </Card>
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
