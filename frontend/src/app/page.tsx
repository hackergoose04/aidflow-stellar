"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  get, payAll, post, uploadCsv,
  type AidRequest, type ClaimResult, type Delivery, type DeliveryCost, type Summary, type UploadReport, type VerifyResult, type Wallet,
} from "@/lib/api";
import { formatDuration, formatHours, shortKey } from "@/lib/format";
import { Button, ErrorNote, Notice, useReviewer } from "@/components/ui";

const PAID = new Set(["CONFIRMED", "CLAIMED"]);
const SENT = new Set(["SUBMITTED", "UNKNOWN", "CONFIRMED", "CLAIMED", "FAILED"]);
const DAYS = 14;

/** 2980.5 -> "2,980" + ".50": the decimals are drawn lighter, like a bank statement. */
function Money({ value, unit = true, className = "" }: { value: number; unit?: boolean; className?: string }) {
  const [whole, cents] = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).split(".");
  return (
    <span className={`tabular-nums ${className}`}>
      {whole}<span className="text-zinc-400">.{cents}</span>
      {unit && <span className="ml-1.5 text-[0.45em] font-medium tracking-normal text-zinc-500">AIDUSD</span>}
    </span>
  );
}

function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** Beneficiaries are pseudonymous (H-<hash>) so no personal data reaches the chain; show a short,
 * stable handle and a colour derived from it. Readable ids like BEN-ALICE become "Alice". */
const AVATAR = ["bg-blue-50 text-blue-700", "bg-amber-50 text-amber-800", "bg-emerald-50 text-emerald-800", "bg-violet-50 text-violet-700", "bg-rose-50 text-rose-700"];
function person(id: string): { name: string; mark: string; tone: string } {
  const hash = id.match(/^H-([0-9a-f]+)$/i)?.[1];
  const tone = AVATAR[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % AVATAR.length];
  if (hash) return { name: `Recipient ${hash.slice(0, 6)}`, mark: hash.slice(0, 2).toUpperCase(), tone };
  const n = id.replace(/^BEN-/i, "").replace(/[-_]+/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return { name: n, mark: n.slice(0, 2).toUpperCase(), tone };
}

function paymentState(r: AidRequest): { label: string; tone: string } {
  const ok = "bg-emerald-50 text-emerald-800";
  if (r.status === "CLAIMED") return { label: "Collected", tone: ok };
  if (r.status === "CONFIRMED") return r.method === "payment"
    ? { label: "In wallet", tone: ok }
    : { label: "Waiting to collect", tone: "bg-zinc-100 text-zinc-700" };
  if (r.status === "FAILED") return r.registry_status === "BLOCKED"
    ? { label: "Stopped · duplicate", tone: "bg-rose-50 text-rose-800" }
    : { label: "Failed", tone: "bg-rose-50 text-rose-800" };
  return { label: "Sending", tone: "bg-blue-50 text-blue-800" };
}

/** Money that reached people, per day, for the last DAYS days (today last). */
function deliveredByDay(rows: AidRequest[]): { day: Date; amount: number }[] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() - (DAYS - 1 - i));
    return { day: d, amount: 0 };
  });
  for (const r of rows) {
    if (!PAID.has(r.status) || !r.submitted_at) continue;
    const t = new Date(r.submitted_at);
    t.setHours(0, 0, 0, 0);
    const i = Math.round((t.getTime() - days[0].day.getTime()) / 86400000);
    if (i >= 0 && i < DAYS) days[i].amount += Number(r.amount);
  }
  return days;
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
  const [reviewer] = useReviewer();
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
  const days = useMemo(() => deliveredByDay(all), [all]);
  const today = days[days.length - 1].amount;
  const stopped = summary?.registry.BLOCKED ?? 0;
  const recent = all.filter((r) => SENT.has(r.status))
    .sort((a, b) => (b.submitted_at ?? b.updated_at).localeCompare(a.submitted_at ?? a.updated_at))
    .slice(0, 8);

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
    detail: reviewer.trim() ? `Approve them in one step as ${reviewer.trim()}.` : "Enter your name at the top right to approve them.",
    action: <Button size="sm" variant="secondary" disabled={!!busy || !reviewer.trim()}
      onClick={() => run("approve", () => post<{ approved: number }>("/review/approve-clean", { reviewer }),
        (r) => `Approved ${r.approved} requests.`)}>Approve all</Button>,
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

  function send() {
    run("pay", () => {
      const total = approvedRows.length;
      setProgress(`0 of ${total}`);
      return payAll(async (done) => { setProgress(`${Math.min(done, total)} of ${total}`); await refresh(); });
    }, (r) => {
      const ok = r.filter((x) => x.status === "CONFIRMED").length;
      const blocked = r.filter((x) => x.status === "FAILED").length;
      return <>Sent {ok} {ok === 1 ? "payment" : "payments"}{blocked ? `, ${blocked} stopped as duplicate` : ""}.</>;
    });
  }

  const balance = wallet ? Number(wallet.balances.AIDUSD ?? 0) : null;
  const toHand = delivery?.timing.approved_to_hand;

  return (
    <>
      <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Nothing accepted is not a success: the warning below explains why, so no green message.
          if (f) run("upload", () => uploadCsv(f), (r) => {
            setUpload(r);
            return r.accepted ? `Uploaded ${f.name}: ${r.accepted} ${r.accepted === 1 ? "request" : "requests"} added.` : null;
          });
          e.target.value = "";
        }} />
      <h1 className="sr-only">Home</h1>

      <ErrorNote error={error} />
      {message && <Notice tone="success">{message}</Notice>}
      {upload && upload.rejected.length > 0 && (
        <Notice tone="warning">
          {upload.accepted === 0 && upload.rejected.every((r) => r.reasons.includes("duplicate_ref")) ? (
            <>Nothing new: all {upload.rejected.length} rows in this file were uploaded before. Duplicates are never added twice.</>
          ) : (
            <>
              {upload.rejected.length} {upload.rejected.length === 1 ? "row was" : "rows were"} not accepted:{" "}
              {upload.rejected.slice(0, 3).map((r) => `line ${r.line} (${r.reasons.join(", ").replaceAll("_", " ").replace("duplicate ref", "already uploaded")})`).join("; ")}
              {upload.rejected.length > 3 && "…"}
            </>
          )}
        </Notice>
      )}

      {/* Balance and what has reached people */}
      <section className="flex flex-wrap gap-6">
        <div className="flex min-w-0 flex-[1_1_340px] flex-col rounded-2xl border border-zinc-200 bg-white p-7">
          <div className="text-[13px] text-zinc-500">Available to disburse</div>
          <div className="mt-2 text-[44px] font-semibold leading-none tracking-[-0.03em] text-zinc-900">
            {balance !== null ? <Money value={balance} /> : <span className="text-zinc-300">—</span>}
          </div>
          <div className="mt-3 text-[13px] text-zinc-500">
            {(summary?.registry.program ?? "Aid programme").replace(/-\d{4}-\d{4}$/, "")}
            {wallet && <> · <a href={wallet.explorer} target="_blank" rel="noreferrer" className="link font-mono text-[12px]">{shortKey(wallet.account, 4)} ↗</a></>}
          </div>
          <div className="mt-auto flex flex-wrap gap-2.5 pt-7">
            <Button className="h-11 px-5 text-[14px]" onClick={() => fileRef.current?.click()} disabled={!!busy}>
              {busy === "upload" ? "Uploading…" : "New batch"}
            </Button>
            <Button variant="secondary" className="h-11 px-5 text-[14px]" onClick={send} disabled={!!busy || !approvedRows.length}
              title={approvedRows.length ? `${approvedAmount.toFixed(2)} AIDUSD, about 15 seconds per payment` : "Nothing approved to send"}>
              {busy === "pay" ? `Sending ${progress}…` : `Send approved${approvedRows.length ? ` · ${approvedRows.length}` : ""}`}
            </Button>
          </div>
        </div>

        <div className="min-w-0 flex-[2_1_520px] rounded-2xl border border-zinc-200 bg-white px-7 pt-6 pb-5">
          <div className="text-[13px] text-zinc-500">Delivered to people</div>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 text-[26px] font-semibold tracking-[-0.02em] text-zinc-900">
            <Money value={paidAmount} />
            <span className="text-[13px] font-medium tracking-normal text-zinc-500">
              {paidPeople} {paidPeople === 1 ? "person" : "people"}
              {today > 0 && <span className="ml-2 text-emerald-700">+{today.toLocaleString("en-US", { maximumFractionDigits: 2 })} today</span>}
            </span>
          </div>
          <DayBars days={days} />
        </div>
      </section>

      {/* Key figures in one strip */}
      <section className="mt-6 grid overflow-hidden rounded-2xl border border-zinc-200 bg-white sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Approval → money in hand"
          value={toHand?.n ? formatDuration(toHand.median_s) : "—"}
          note={toHand?.n ? `median of ${toHand.n} · bank transfers take days` : "no payments in hand yet"} />
        <Figure label="Fees per payout"
          value={cost?.payouts ? <>${(cost.avg_fee_usd ?? 0).toFixed(3)} <span className="text-[13px] font-medium text-zinc-500">{((cost.cost_share ?? 0) * 100).toFixed(2)}%</span></> : "—"}
          note={cost?.payouts ? "of the amount · remittances average 6.4%" : cost ? "no payments yet" : "reading fees from Stellar…"} />
        <Figure label="Duplicates stopped" value={String(stopped)} note="blocked by the on-chain registry" />
        {summary?.last_recon ? (
          <Figure label="Records vs Stellar"
            value={mismatches
              ? <span className="text-rose-700">{mismatches} mismatch{mismatches === 1 ? "" : "es"}</span>
              : <span className="inline-flex items-center gap-2"><Check />All match</span>}
            note={`checked ${ago(summary.last_recon)}`} />
        ) : (
          <Figure label="Records vs Stellar" value={<span className="text-zinc-400">Not checked</span>}
            note={<Link href="/recon?run=1" className="link">Run the check →</Link>} />
        )}
      </section>

      {tasks.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-[16px] font-semibold text-zinc-900">Needs your attention</h2>
          <ul className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-white">
            {tasks.map((t) => (
              <li key={t.key} className="flex items-center gap-4 px-6 py-4">
                <span className={`h-2 w-2 shrink-0 rounded-full ${t.tone}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] text-zinc-900 [&_b]:font-semibold">{t.title}</div>
                  <div className="mt-0.5 text-[13px] text-zinc-500">{t.detail}</div>
                </div>
                <div className="shrink-0">{t.action}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-[16px] font-semibold text-zinc-900">Recent payments</h2>
          <Link href="/payouts" className="link text-[13px]">View all →</Link>
        </div>
        <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
          {rows === null ? (
            <div className="px-6 py-10 text-[14px] text-zinc-500">Loading…</div>
          ) : recent.length ? (
            <table className="w-full min-w-[720px] text-left text-[14px]">
              <thead>
                <tr className="text-[12px] text-zinc-500">
                  <th className="border-b border-zinc-100 py-3 pr-3 pl-6 font-medium">Recipient</th>
                  <th className="border-b border-zinc-100 px-3 py-3 font-medium">Batch</th>
                  <th className="border-b border-zinc-100 px-3 py-3 font-medium">Status</th>
                  <th className="border-b border-zinc-100 px-3 py-3 font-medium">When</th>
                  <th className="border-b border-zinc-100 py-3 pr-6 pl-3 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => {
                  const st = paymentState(r);
                  const who = person(r.beneficiary_id);
                  return (
                    <tr key={r.request_ref} className="group border-b border-zinc-50 last:border-0 hover:bg-zinc-50/70">
                      <td className="py-3.5 pr-3 pl-6">
                        <Link href={`/requests/${encodeURIComponent(r.request_ref)}`} className="flex items-center gap-3">
                          <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full font-mono text-[11px] font-semibold ${who.tone}`}>
                            {who.mark}
                          </span>
                          <span className="min-w-0">
                            <span className="block font-medium text-zinc-900 group-hover:underline">{who.name}</span>
                            <span className="block font-mono text-[12px] text-zinc-400">{shortKey(r.wallet, 4)}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-3 py-3.5 text-zinc-600">{r.batch_id ?? "—"}</td>
                      <td className="px-3 py-3.5">
                        <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium ${st.tone}`}>{st.label}</span>
                      </td>
                      <td className="px-3 py-3.5 whitespace-nowrap text-zinc-600">{ago(r.claimed_at ?? r.submitted_at ?? r.updated_at)}</td>
                      <td className="py-3.5 pr-6 pl-3 text-right font-medium text-zinc-900">
                        <Money value={Number(r.amount)} unit={false} />
                        <span className="ml-1.5 text-[12px] font-normal text-zinc-400">AIDUSD</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="px-6 py-12 text-center text-[14px] text-zinc-500">
              No payments yet. <button className="link" onClick={() => fileRef.current?.click()}>Upload a batch</button> to get started.
            </div>
          )}
        </div>
      </section>
    </>
  );
}

/** One bar per day; empty days get a thin grey stub so the axis still reads. Hover shows the day's figure. */
function DayBars({ days }: { days: { day: Date; amount: number }[] }) {
  const max = Math.max(...days.map((d) => d.amount), 1);
  const fmt = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return (
    <figure className="mt-5" aria-label={`AIDUSD delivered per day, last ${days.length} days`}>
      <div className="relative flex h-36 items-end gap-[6px] border-b border-zinc-200">
        {[0.33, 0.66, 1].map((y) => (
          <span key={y} className="pointer-events-none absolute inset-x-0 border-t border-zinc-100" style={{ bottom: `${y * 100}%` }} />
        ))}
        {days.map((d, i) => {
          const last = i === days.length - 1;
          return (
            <div key={i} className="group relative flex h-full flex-1 items-end">
              <span className={`block w-full rounded-t-[4px] ${d.amount ? "bg-accent" : "bg-zinc-200"}`}
                style={{ height: d.amount ? `${Math.max((d.amount / max) * 100, 4)}%` : 3 }} />
              <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-[11px] text-white opacity-0 shadow transition-opacity group-hover:opacity-100">
                {last ? "Today" : fmt(d.day)} · {d.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} AIDUSD
              </span>
            </div>
          );
        })}
      </div>
      <figcaption className="mt-2 flex justify-between text-[11px] text-zinc-400">
        <span>{fmt(days[0].day)}</span>
        <span>{fmt(days[Math.floor(days.length / 2)].day)}</span>
        <span>Today</span>
      </figcaption>
    </figure>
  );
}

function Figure({ label, value, note }: { label: string; value: React.ReactNode; note: React.ReactNode }) {
  return (
    <div className="border-zinc-100 px-6 py-5 max-lg:border-b sm:max-lg:odd:border-r lg:border-r lg:last:border-r-0 max-sm:last:border-b-0 sm:max-lg:[&:nth-last-child(-n+2)]:border-b-0">
      <div className="text-[13px] text-zinc-500">{label}</div>
      <div className="mt-1.5 text-[22px] font-semibold tracking-[-0.01em] tabular-nums text-zinc-900">{value}</div>
      <div className="mt-1 text-[12px] text-zinc-500">{note}</div>
    </div>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" className="h-[18px] w-[18px] text-emerald-700" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
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
