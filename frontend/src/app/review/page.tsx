"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { get, post, type AidRequest } from "@/lib/api";
import { formatAmount, formatTime, shortKey } from "@/lib/format";
import {
  Button, Card, Empty, ErrorNote, FlagChips, Notice, PageHeader, ReviewerInput, RiskBar, StatusBadge, useReviewer,
} from "@/components/ui";

export default function ReviewQueue() {
  const [items, setItems] = useState<AidRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewer, setReviewer] = useReviewer();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [pending, held] = await Promise.all([
        get<AidRequest[]>("/requests?status=PENDING_REVIEW"),
        get<AidRequest[]>("/requests?status=HELD"),
      ]);
      const invalidRows = await get<AidRequest[]>("/requests?status=INVALID");
      const rows = [...pending, ...held, ...invalidRows];
      rows.sort((a, b) => (b.flags.length > 0 ? 1 : 0) - (a.flags.length > 0 ? 1 : 0)
        || (b.risk_score ?? 0) - (a.risk_score ?? 0));
      setItems(rows);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function decide(ref: string, action: "approve" | "reject" | "hold") {
    setBusy(ref);
    try {
      const updated = await post<AidRequest>(`/requests/${encodeURIComponent(ref)}/${action}`, { reviewer, note: notes[ref] || null });
      setItems((xs) => action === "hold"
        ? xs?.map((x) => (x.request_ref === ref ? updated : x)) ?? null
        : xs?.filter((x) => x.request_ref !== ref) ?? null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function approveClean() {
    setBusy("clean");
    try {
      await post("/review/approve-clean", { reviewer });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const held = items?.filter((x) => x.status === "HELD") ?? [];
  const invalid = items?.filter((x) => x.status === "INVALID") ?? [];
  const pending = items?.filter((x) => x.status === "PENDING_REVIEW") ?? [];
  const flagged = pending.filter((x) => x.flags.length);
  const clean = pending.filter((x) => !x.flags.length);
  const noReviewer = !reviewer.trim();

  return (
    <>
      <PageHeader title="Review queue"
        subtitle="No money moves until a person approves. Flagged requests are sorted by AI risk, highest first."
        action={<ReviewerInput value={reviewer} onChange={setReviewer} compact />} />
      <ErrorNote error={error} />
      {noReviewer && <Notice tone="warning">Enter your name under <b className="font-medium">Reviewing as</b> to approve, hold or reject.</Notice>}

      {items === null && !error && <p className="text-[13px] text-zinc-500">Loading…</p>}
      {items?.length === 0 && (
        <Card flush><Empty>Nothing waiting for review. Upload requests on the <Link className="link" href="/">overview</Link>.</Empty></Card>
      )}

      {clean.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-5 py-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div>
            <div className="text-[13px] font-semibold text-zinc-900">{clean.length} requests with no flags</div>
            <div className="text-[12px] text-zinc-500">Passed every rule and the AI model scored them as usual.</div>
          </div>
          <Button disabled={noReviewer || busy === "clean"} onClick={approveClean}>Approve all {clean.length}</Button>
        </div>
      )}

      {([["Invalid", "correct or reject", invalid], ["Held", "waiting for checks", held], ["Flagged", "decide one by one", flagged]] as const).map(([title, hint, list]) =>
        list.length > 0 && (
          <Card key={title} className="mb-6" flush
            title={<>{title} <span className="ml-1 font-normal tabular-nums text-zinc-400">{list.length}</span></>} action={hint}>
            <div className="divide-y divide-zinc-100">
              {list.map((r) => (
                <ReviewRow key={r.request_ref} r={r} note={notes[r.request_ref] ?? ""}
                  setNote={(v) => setNotes({ ...notes, [r.request_ref]: v })}
                  disabled={noReviewer || busy === r.request_ref} decide={decide} />
              ))}
            </div>
          </Card>
        ))}
    </>
  );
}

function ReviewRow({ r, note, setNote, disabled, decide }: {
  r: AidRequest;
  note: string;
  setNote: (v: string) => void;
  disabled: boolean;
  decide: (ref: string, action: "approve" | "reject" | "hold") => void;
}) {
  const href = `/requests/${encodeURIComponent(r.request_ref)}`;
  return (
    <div className="grid gap-5 px-5 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_13rem]">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Link href={href} className="font-mono text-[12px] font-medium text-zinc-900 hover:underline">{r.request_ref}</Link>
          {(r.status === "HELD" || r.status === "INVALID") && <StatusBadge status={r.status} />}
        </div>
        <div className="mt-1 text-[20px] font-semibold tracking-tight tabular-nums text-zinc-900">
          {formatAmount(r.amount)} <span className="text-[12px] font-normal text-zinc-400">{r.asset}</span>
        </div>
        <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-y-1 text-[12px]">
          <dt className="text-zinc-400">Beneficiary</dt><dd className="truncate font-mono text-zinc-700">{r.beneficiary_id}</dd>
          <dt className="text-zinc-400">Batch</dt><dd className="text-zinc-700">{r.batch_id ?? "—"}</dd>
          <dt className="text-zinc-400">Wallet</dt><dd className="font-mono text-zinc-700">{shortKey(r.wallet, 6)}</dd>
          <dt className="text-zinc-400">Requested</dt><dd className="text-zinc-700">{formatTime(r.created_at)}</dd>
          <dt className="text-zinc-400">AI risk</dt><dd><RiskBar score={r.risk_score} /></dd>
        </dl>
      </div>
      <div className="min-w-0 md:border-l md:border-zinc-100 md:pl-5">
        <div className="eyebrow mb-2">Why it&apos;s here</div>
        <FlagChips flags={r.flags} verbose />
      </div>
      <div className="flex flex-col gap-2">
        {r.status === "HELD" && r.note && <p className="text-[12px] text-zinc-500">Held: “{r.note}”</p>}
        <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="input" />
        {r.status !== "INVALID" && (
          <Button disabled={disabled} onClick={() => decide(r.request_ref, "approve")}>Approve</Button>
        )}
        <div className="flex gap-2">
          {r.status === "PENDING_REVIEW" && (
            <Button className="flex-1" variant="secondary" disabled={disabled} onClick={() => decide(r.request_ref, "hold")}>Hold</Button>
          )}
          <Button className="flex-1" variant="danger" disabled={disabled} onClick={() => decide(r.request_ref, "reject")}>Reject</Button>
        </div>
        <Link href={`${href}#correct`} className="text-center text-[12px] text-zinc-500 hover:text-zinc-900">Correct details…</Link>
      </div>
    </div>
  );
}
