"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  get, payAll, post, uploadCsv,
  type AidRequest, type ClaimResult, type Delivery, type DeliveryCost, type Summary, type UploadReport, type VerifyResult, type Wallet,
} from "@/lib/api";
import { formatAmount, formatDuration, formatHours, shortKey } from "@/lib/format";
import { Button, ErrorNote, Notice, ReviewerInput, useReviewer } from "@/components/ui";

const OPEN = new Set(["PENDING_REVIEW", "HELD", "INVALID"]);
const PAID = new Set(["CONFIRMED", "CLAIMED"]);

interface BatchView {
  id: string;
  people: number;
  amount: number;
  needsReview: number;
  approved: number;
  sending: number;
  received: number;
  waiting: number;
  stopped: number;
  latest: string;
}

function batchesOf(rows: AidRequest[]): BatchView[] {
  const by = new Map<string, AidRequest[]>();
  for (const r of rows) {
    if (r.status === "REJECTED") continue;
    const k = r.batch_id ?? "Unbatched";
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by.entries()].map(([id, rs]) => ({
    id,
    people: new Set(rs.map((r) => r.beneficiary_id)).size,
    amount: rs.filter((r) => r.status !== "FAILED" && r.status !== "INVALID").reduce((n, r) => n + Number(r.amount), 0),
    needsReview: rs.filter((r) => OPEN.has(r.status)).length,
    approved: rs.filter((r) => r.status === "APPROVED").length,
    sending: rs.filter((r) => r.status === "SUBMITTED" || r.status === "UNKNOWN").length,
    received: rs.filter((r) => r.status === "CLAIMED" || (r.status === "CONFIRMED" && r.method === "payment")).length,
    waiting: rs.filter((r) => r.status === "CONFIRMED" && r.method === "claimable_balance").length,
    stopped: rs.filter((r) => r.status === "FAILED").length,
    latest: rs.reduce((m, r) => (r.created_at > m ? r.created_at : m), ""),
  })).sort((a, b) => b.latest.localeCompare(a.latest));
}

function batchState(b: BatchView): { label: string; tone: string } {
  if (b.needsReview) return { label: "Needs review", tone: "bg-amber-50 text-amber-800" };
  if (b.approved) return { label: "Ready to pay", tone: "bg-blue-50 text-blue-800" };
  if (b.sending) return { label: "Paying", tone: "bg-blue-50 text-blue-800" };
  if (b.waiting) return { label: "Awaiting collection", tone: "bg-zinc-100 text-zinc-700" };
  return { label: "Completed", tone: "bg-emerald-50 text-emerald-800" };
}

export default function Home() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<AidRequest[] | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
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
      const [s, r] = await Promise.all([get<Summary>("/summary"), get<AidRequest[]>("/requests")]);
      setSummary(s);
      setRows(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    get<Wallet>("/wallet").then(setWallet, () => setWallet(null));
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

  const all = useMemo(() => rows ?? [], [rows]);
  const batches = useMemo(() => batchesOf(all), [all]);
  const s = summary?.by_status;
  const flagged = (summary?.pending_flagged ?? 0) + (s?.HELD ?? 0) + (s?.INVALID ?? 0);
  const clean = s ? s.PENDING_REVIEW - (summary?.pending_flagged ?? 0) : 0;
  const approvedRows = all.filter((r) => r.status === "APPROVED");
  const approvedAmount = approvedRows.reduce((n, r) => n + Number(r.amount), 0);
  const inFlight = (s?.SUBMITTED ?? 0) + (s?.UNKNOWN ?? 0);
  const unclaimed = delivery?.unclaimed ?? [];
  const mismatches = summary?.recon.MISMATCH ?? 0;

  const paidRows = all.filter((r) => PAID.has(r.status));
  const paidAmount = paidRows.reduce((n, r) => n + Number(r.amount), 0);
  const paidPeople = new Set(paidRows.map((r) => r.beneficiary_id)).size;
  const stopped = summary?.registry.BLOCKED ?? 0;
  const totalFees = cost?.payouts ? (cost.avg_fee_usd ?? 0) * cost.payouts : null;

  const tasks: { key: string; tone: string; title: React.ReactNode; detail: string; action: React.ReactNode }[] = [];
  if (flagged) tasks.push({
    key: "review", tone: "bg-amber-500",
    title: <><b>{flagged}</b> {flagged === 1 ? "request needs" : "requests need"} a decision</>,
    detail: "Flagged by a rule or the AI model. Nothing is paid until a person approves it.",
    action: <Link href="/review"><Button size="sm">Review</Button></Link>,
  });
  if (clean > 0) tasks.push({
    key: "clean", tone: "bg-emerald-500",
    title: <><b>{clean}</b> {clean === 1 ? "request" : "requests"} passed every check</>,
    detail: reviewer.trim() ? `Approve them in one step as ${reviewer.trim()}.` : "Enter your name under Reviewing as to approve them.",
    action: <Button size="sm" variant="secondary" disabled={!!busy || !reviewer.trim()}
      onClick={() => run("approve", () => post<{ approved: number }>("/review/approve-clean", { reviewer }),
        (r) => `Approved ${r.approved} requests.`)}>Approve all</Button>,
  });
  if (approvedRows.length) tasks.push({
    key: "pay", tone: "bg-blue-600",
    title: <><b>{approvedRows.length}</b> approved {approvedRows.length === 1 ? "payment is" : "payments are"} ready to send</>,
    detail: `${formatAmount(approvedAmount)} AIDUSD on Stellar. About 15 seconds per payment.`,
    action: <Button size="sm" disabled={!!busy}
      onClick={() => run("pay", () => {
        const total = approvedRows.length;
        setProgress(`0 of ${total}`);
        return payAll(async (done) => { setProgress(`${Math.min(done, total)} of ${total}`); await refresh(); });
      }, (r) => {
        const ok = r.filter((x) => x.status === "CONFIRMED").length;
        const blocked = r.filter((x) => x.status === "FAILED").length;
        return <>Sent {ok} {ok === 1 ? "payment" : "payments"}{blocked ? `, ${blocked} stopped as duplicate` : ""}. <Link className="link" href="/payouts">See payouts</Link></>;
      })}>
      {busy === "pay" ? `Sending ${progress}…` : "Send"}
    </Button>,
  });
  if (inFlight) tasks.push({
    key: "verify", tone: "bg-blue-400",
    title: <><b>{inFlight}</b> {inFlight === 1 ? "payment is" : "payments are"} awaiting confirmation</>,
    detail: "Look them up on Stellar by transaction hash.",
    action: <VerifyButton busy={busy} run={run} label="Verify" />,
  });
  if (unclaimed.length) tasks.push({
    key: "claims", tone: unclaimed.some((u) => u.overdue) ? "bg-rose-500" : "bg-zinc-400",
    title: <><b>{unclaimed.length}</b> {unclaimed.length === 1 ? "payment hasn't" : "payments haven't"} been collected yet</>,
    detail: `Oldest has waited ${formatHours(unclaimed[0].waiting_hours)}. Uncollected money returns to you after 30 days.`,
    action: <VerifyButton busy={busy} run={run} label="Check now" />,
  });
  if (mismatches) tasks.push({
    key: "recon", tone: "bg-rose-500",
    title: <><b>{mismatches}</b> {mismatches === 1 ? "payment doesn't" : "payments don't"} match the chain</>,
    detail: "Our record and Stellar disagree. Someone should look at it.",
    action: <Link href="/recon?run=1"><Button size="sm" variant="secondary">Investigate</Button></Link>,
  });

  return (
    <>
      <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) run("upload", () => uploadCsv(f), (r) => { setUpload(r); return `Uploaded ${f.name}: ${r.accepted} requests added.`; });
          e.target.value = "";
        }} />

      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-1 text-[13px] text-zinc-500">
            {/* reset_demo.py suffixes the programme id with -MMDD-HHMM; people don't need to see it */}
            {(summary?.registry.program ?? "Aid programme").replace(/-\d{4}-\d{4}$/, "")} · Stellar Testnet
          </div>
          <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-zinc-900">Disbursements</h1>
        </div>
        <div className="flex items-center gap-2">
          <ReviewerInput value={reviewer} onChange={setReviewer} compact />
          <Button className="h-9 px-4" onClick={() => fileRef.current?.click()} disabled={!!busy}>
            {busy === "upload" ? "Uploading…" : "New batch"}
          </Button>
        </div>
      </header>

      <ErrorNote error={error} />
      {message && <Notice tone="success">{message}</Notice>}
      {upload && upload.rejected.length > 0 && (
        <Notice tone="warning">
          {upload.rejected.length} {upload.rejected.length === 1 ? "row was" : "rows were"} not accepted:{" "}
          {upload.rejected.slice(0, 3).map((r) => `line ${r.line} (${r.reasons.join(", ").replaceAll("_", " ")})`).join("; ")}
          {upload.rejected.length > 3 && "…"}
        </Notice>
      )}

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <Section title="Needs your attention" count={tasks.length || undefined}>
            {rows === null ? (
              <div className="px-5 py-8 text-[14px] text-zinc-500">Loading…</div>
            ) : tasks.length ? (
              <ul className="divide-y divide-zinc-100">
                {tasks.map((t) => (
                  <li key={t.key} className="flex items-center gap-4 px-5 py-4">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${t.tone}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] text-zinc-900 [&_b]:font-semibold">{t.title}</div>
                      <div className="mt-0.5 text-[13px] text-zinc-500">{t.detail}</div>
                    </div>
                    <div className="shrink-0">{t.action}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex items-center gap-3 px-5 py-6">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-emerald-50 text-emerald-600">
                  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m3.5 8.5 3 3 6-7" /></svg>
                </span>
                <div>
                  <div className="text-[14px] font-medium text-zinc-900">You&apos;re all caught up</div>
                  <div className="text-[13px] text-zinc-500">{all.length ? "Every request is decided, paid and collected." : "Start by uploading a batch of payment requests."}</div>
                </div>
              </div>
            )}
          </Section>

          <Section title="Batches" count={batches.length || undefined}
            action={<Link href="/requests" className="text-[13px] text-zinc-500 hover:text-zinc-900">All requests →</Link>}>
            {batches.length ? (
              <ul className="divide-y divide-zinc-100">
                {batches.map((b) => <BatchRow key={b.id} b={b} />)}
              </ul>
            ) : (
              <div className="px-5 py-8 text-center text-[14px] text-zinc-500">
                No batches yet. <button className="link" onClick={() => fileRef.current?.click()}>Upload a CSV</button> to create one.
              </div>
            )}
          </Section>
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          <div className="rounded-xl bg-zinc-900 p-5 text-white">
            <div className="text-[13px] text-zinc-400">Available to disburse</div>
            <div className="mt-1 text-[30px] font-semibold tracking-[-0.02em]">
              {wallet ? formatAmount(Number(wallet.balances.AIDUSD ?? 0).toFixed(2)) : "—"}
              <span className="ml-1.5 text-[14px] font-normal text-zinc-400">AIDUSD</span>
            </div>
            {wallet && (
              <a href={wallet.explorer} target="_blank" rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1 text-[12px] text-zinc-400 hover:text-white">
                NGO wallet {shortKey(wallet.account, 4)} on Stellar ↗
              </a>
            )}
          </div>

          <div>
            <h2 className="mb-3 text-[15px] font-semibold text-zinc-900">So far</h2>
            <dl className="flex flex-col gap-4">
              <Fact value={`${formatAmount(paidAmount.toFixed(2))} AIDUSD`} label={`delivered to ${paidPeople} ${paidPeople === 1 ? "person" : "people"}`} />
              <Fact value={delivery?.timing.approved_to_hand.n ? formatDuration(delivery.timing.approved_to_hand.median_s) : "—"}
                label="typical time from approval to money in hand" note="Aid transfers usually take weeks." />
              <Fact value={totalFees !== null ? `$${totalFees < 0.01 ? totalFees.toFixed(4) : totalFees.toFixed(2)}` : "—"}
                label={cost?.payouts ? `in network fees, ${((cost.cost_share ?? 0) * 100).toFixed(2)}% of the amount` : "in network fees"}
                note="Remittances average 6.4%." />
              <Fact value={String(stopped)} label={`duplicate ${stopped === 1 ? "payment" : "payments"} stopped on chain`} />
              {summary?.last_recon ? (
                <Fact value={mismatches ? `${mismatches} mismatch${mismatches === 1 ? "" : "es"}` : "All matched"}
                  label="our records against Stellar" tone={mismatches ? "text-rose-600" : undefined} />
              ) : (
                <Fact value="Not checked" label="our records against Stellar" note="Run reconciliation to compare." />
              )}
            </dl>
            <Link href="/evaluation" className="mt-5 inline-block text-[13px] text-zinc-500 hover:text-zinc-900">How the AI screening performs →</Link>
          </div>
        </aside>
      </div>
    </>
  );
}

function VerifyButton({ busy, run, label }: {
  busy: string | null;
  run: <T>(label: string, fn: () => Promise<T>, done: (r: T) => React.ReactNode) => Promise<void>;
  label: string;
}) {
  return (
    <Button size="sm" variant="secondary" disabled={!!busy}
      onClick={() => run("verify", async () => ({
        v: await post<VerifyResult[]>("/payouts/verify"),
        c: await post<ClaimResult[]>("/payouts/claims"),
      }), ({ c }) => {
        const got = c.filter((x) => x.claim_status === "CLAIMED").length;
        return got ? `${got} ${got === 1 ? "beneficiary has" : "beneficiaries have"} collected their money.` : "Checked Stellar: nothing new collected yet.";
      })}>
      {busy === "verify" ? "Checking…" : label}
    </Button>
  );
}

function Section({ title, count, action, children }: {
  title: string; count?: number; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-zinc-900">
          {title}{count !== undefined && <span className="ml-2 font-normal text-zinc-400">{count}</span>}
        </h2>
        {action}
      </div>
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">{children}</div>
    </section>
  );
}

function BatchRow({ b }: { b: BatchView }) {
  const state = batchState(b);
  const total = b.received + b.waiting + b.sending + b.approved + b.needsReview + b.stopped || 1;
  const parts = [
    { n: b.received, color: "#15803d", label: "received" },
    { n: b.waiting, color: "#86efac", label: "sent, not collected" },
    { n: b.sending + b.approved, color: "#93c5fd", label: "approved" },
    { n: b.needsReview, color: "#fcd34d", label: "in review" },
    { n: b.stopped, color: "#fda4af", label: "stopped" },
  ];
  const date = b.latest ? new Date(b.latest).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
  return (
    <li>
      <Link href="/payouts" className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 px-5 py-4 transition-colors hover:bg-zinc-50 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_7rem_8.5rem]">
        <div className="col-start-1 row-start-1 min-w-0 sm:col-start-auto sm:row-start-auto">
          <div className="truncate text-[14px] font-medium text-zinc-900">{b.id}</div>
          <div className="text-[13px] text-zinc-500">{b.people} {b.people === 1 ? "person" : "people"}{date && ` · ${date}`}</div>
        </div>
        <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto" title={parts.filter((p) => p.n).map((p) => `${p.n} ${p.label}`).join(", ")}>
          <div className="flex h-1.5 gap-[2px] overflow-hidden rounded-full bg-zinc-100">
            {parts.filter((p) => p.n).map((p) => (
              <span key={p.label} style={{ flexGrow: p.n / total, flexBasis: 0, background: p.color }} />
            ))}
          </div>
          <div className="mt-1.5 text-[12px] text-zinc-500">
            {b.received} of {total} received{b.stopped ? ` · ${b.stopped} stopped` : ""}
          </div>
        </div>
        <div className="text-right text-[14px] font-medium tabular-nums text-zinc-900 max-sm:hidden">
          {formatAmount(b.amount.toFixed(2))}<span className="ml-1 text-[11px] font-normal text-zinc-400">AIDUSD</span>
        </div>
        <div className="col-start-2 row-start-1 justify-self-end sm:col-start-auto sm:row-start-auto">
          <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium ${state.tone}`}>{state.label}</span>
        </div>
      </Link>
    </li>
  );
}

function Fact({ value, label, note, tone }: { value: string; label: string; note?: string; tone?: string }) {
  return (
    <div>
      <dt className={`text-[20px] font-semibold tracking-[-0.01em] ${tone ?? "text-zinc-900"}`}>{value}</dt>
      <dd className="text-[13px] text-zinc-500">
        {label}
        {note && <span className="block text-[12px] text-zinc-400">{note}</span>}
      </dd>
    </div>
  );
}
