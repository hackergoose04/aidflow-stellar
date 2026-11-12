"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { get, post, type AidRequest } from "@/lib/api";
import { formatAmount, formatTime, shortKey } from "@/lib/format";
import {
  Button, Card, ErrorNote, FlagChips, PageHeader, ReviewerInput, RiskBar, StatusBadge, useReviewer,
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
        subtitle="No money moves until a person approves. Approve, hold for checks, correct, or reject. Flagged requests are sorted by AI risk, highest first."
        action={<ReviewerInput value={reviewer} onChange={setReviewer} />} />
      <ErrorNote error={error} />
      {noReviewer && (
        <p className="mb-4 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900">Enter your name as reviewer to approve, hold or reject.</p>
      )}

      {items === null && !error && <p className="text-sm text-stone-500">Loading…</p>}
      {items?.length === 0 && (
        <Card><p className="text-sm text-stone-500">Nothing waiting for review. Upload requests on the <Link className="text-teal-700 underline" href="/">overview</Link>.</p></Card>
      )}

      {clean.length > 0 && (
        <Card className="mb-6" title={`${clean.length} requests with no flags`}
          action={<Button disabled={noReviewer || busy === "clean"} onClick={approveClean}>Approve all {clean.length}</Button>}>
          <p className="text-sm text-stone-500">Passed every rule and the AI model scored them as usual.</p>
        </Card>
      )}

      {([["invalid · correct or reject", invalid], ["held", held], ["flagged · decide one by one", flagged]] as const).map(([title, list]) =>
        list.length > 0 && (
          <section key={title} className="mb-6">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-stone-500">
              {list.length} {title}
            </h2>
            <div className="flex flex-col gap-3">
              {list.map((r) => (
                <ReviewCard key={r.request_ref} r={r} note={notes[r.request_ref] ?? ""}
                  setNote={(v) => setNotes({ ...notes, [r.request_ref]: v })}
                  disabled={noReviewer || busy === r.request_ref} decide={decide} />
              ))}
            </div>
          </section>
        ))}
    </>
  );
}

function ReviewCard({ r, note, setNote, disabled, decide }: {
  r: AidRequest;
  note: string;
  setNote: (v: string) => void;
  disabled: boolean;
  decide: (ref: string, action: "approve" | "reject" | "hold") => void;
}) {
  const href = `/requests/${encodeURIComponent(r.request_ref)}`;
  return (
          <div className="grid gap-4 rounded-xl border border-stone-200 bg-white p-4 md:grid-cols-[1fr_1.3fr_auto]">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Link href={href} className="font-mono text-sm font-medium text-stone-900 hover:underline">{r.request_ref}</Link>
                {(r.status === "HELD" || r.status === "INVALID") && <StatusBadge status={r.status} />}
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
                {formatAmount(r.amount)} <span className="text-sm font-normal text-stone-500">{r.asset}</span>
              </div>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-stone-500">
                <dt>Beneficiary</dt><dd className="text-stone-800">{r.beneficiary_id}</dd>
                <dt>Batch</dt><dd className="text-stone-800">{r.batch_id ?? "—"}</dd>
                <dt>Payout slot</dt><dd className="text-stone-800">{r.payout_slot}</dd>
                <dt>Wallet</dt><dd className="font-mono text-stone-800">{shortKey(r.wallet, 6)}</dd>
                <dt>Requested</dt><dd className="text-stone-800">{formatTime(r.created_at)}</dd>
                <dt>AI risk</dt><dd><RiskBar score={r.risk_score} /></dd>
              </dl>
            </div>
            <FlagChips flags={r.flags} verbose />
            <div className="flex flex-col gap-2 md:w-48">
              {r.status === "HELD" && r.note && <p className="text-xs text-stone-500">Held: “{r.note}”</p>}
              <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)}
                className="rounded-lg border border-stone-300 px-2 py-1 text-sm focus:border-teal-600 focus:outline-none" />
              {r.status !== "INVALID" && (
                <Button disabled={disabled} onClick={() => decide(r.request_ref, "approve")}>Approve</Button>
              )}
              <div className="flex gap-2">
                {r.status === "PENDING_REVIEW" && (
                  <Button className="flex-1" variant="secondary" disabled={disabled} onClick={() => decide(r.request_ref, "hold")}>Hold</Button>
                )}
                <Button className="flex-1" variant="danger" disabled={disabled} onClick={() => decide(r.request_ref, "reject")}>Reject</Button>
              </div>
              <Link href={`${href}#correct`} className="text-center text-xs text-teal-700 hover:underline">Correct details…</Link>
            </div>
          </div>
  );
}
