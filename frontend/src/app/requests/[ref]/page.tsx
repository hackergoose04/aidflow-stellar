"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { explorerAccount, get, post, type AidRequest } from "@/lib/api";
import { CLAIM_STYLE, describeReason, formatAmount, formatTime, REGISTRY_STYLE } from "@/lib/format";
import {
  Button, Card, ClaimBadge, ErrorNote, FlagChips, ReconBadge, RegistryBadge, ReviewerInput, RiskBar, StatusBadge, TxLink,
  useReviewer,
} from "@/components/ui";

const FIELDS = [
  ["beneficiary_id", "Beneficiary ID"], ["wallet", "Wallet"], ["amount", "Amount"], ["batch_id", "Batch"],
  ["payout_slot", "Payout slot"],
  ["created_at", "Requested at (ISO)"],
] as const;
type Field = (typeof FIELDS)[number][0];

const METHOD_LABEL = {
  payment: "Direct payment (wallet already accepts AIDUSD)",
  claimable_balance: "Claimable balance (beneficiary claims it; NGO can reclaim after 30 days)",
};

export default function RequestDetail() {
  const { ref } = useParams<{ ref: string }>();
  const id = decodeURIComponent(ref);
  const [req, setReq] = useState<AidRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewer, setReviewer] = useReviewer();
  const [edit, setEdit] = useState<Record<Field, string> | null>(null);

  const load = useCallback(() => {
    get<AidRequest>(`/requests/${encodeURIComponent(id)}`)
      .then((r) => {
        setReq(r);
        // Beneficiary starts empty: only a token is stored; staff type the real ID to change it.
        setEdit({ beneficiary_id: "", wallet: r.wallet, amount: r.amount ? String(Number(r.amount) || r.amount) : "",
          batch_id: r.batch_id ?? "", payout_slot: r.payout_slot, created_at: r.created_at });
        setError(null);
      }, (e) => setError((e as Error).message));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function act(action: "approve" | "reject" | "hold" | "retry" | "correct") {
    setBusy(true);
    try {
      const changes = action === "correct" && edit
        ? Object.fromEntries(Object.entries(edit).filter(([, v]) => v.trim() !== ""))
        : {};
      await post(`/requests/${encodeURIComponent(id)}/${action}`, { reviewer, note: note || null, ...changes });
      setNote("");
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!req) {
    return <><ErrorNote error={error} />{!error && <p className="text-sm text-stone-500">Loading…</p>}</>;
  }
  const open = req.status === "PENDING_REVIEW" || req.status === "HELD";
  const invalid = req.status === "INVALID";
  const paid = req.status === "CONFIRMED" || req.status === "CLAIMED";

  return (
    <>
      <Link href="/requests" className="text-sm text-stone-500 hover:text-stone-800">← All requests</Link>
      <div className="mb-6 mt-2 flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-2xl font-semibold text-stone-900">{req.request_ref}</h1>
        <StatusBadge status={req.status} />
      </div>
      <ErrorNote error={error} />

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Request" className="md:col-span-2">
          <div className="mb-4 text-3xl font-semibold tabular-nums">
            {formatAmount(req.amount)} <span className="text-base font-normal text-stone-500">{req.asset}</span>
          </div>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-stone-500">Beneficiary</dt>
            <dd>
              <span className="font-mono text-xs">{req.beneficiary_id || "—"}</span>
              <span className="ml-2 text-xs text-stone-400">pseudonymous (HMAC of the real ID)</span>
            </dd>
            <dt className="text-stone-500">Batch</dt><dd>{req.batch_id ?? "—"}</dd>
            <dt className="text-stone-500">Payout slot</dt><dd>{req.payout_slot}</dd>
            <dt className="text-stone-500">Wallet</dt>
            <dd className="break-all font-mono text-xs">
              <a href={explorerAccount(req.wallet)} target="_blank" rel="noreferrer" className="text-teal-700 hover:underline">{req.wallet} ↗</a>
            </dd>
            <dt className="text-stone-500">Requested</dt><dd>{formatTime(req.created_at)}</dd>
            <dt className="text-stone-500">AI risk</dt><dd><RiskBar score={req.risk_score} /></dd>
            {req.reviewer && (<><dt className="text-stone-500">Reviewed by</dt><dd>{req.reviewer}{req.note && <span className="text-stone-500"> · “{req.note}”</span>}</dd></>)}
            {req.method && (<><dt className="text-stone-500">Paid as</dt><dd>{METHOD_LABEL[req.method]}</dd></>)}
            {req.tx_hash && (<><dt className="text-stone-500">Transaction</dt><dd><TxLink hash={req.tx_hash} label={req.tx_hash} /></dd></>)}
            {paid && (
              <>
                <dt className="text-stone-500">Delivery</dt>
                <dd>
                  <ClaimBadge method={req.method} status={req.claim_status} />
                  {req.claim_status && <span className="ml-2 text-xs text-stone-500">{CLAIM_STYLE[req.claim_status]?.why}</span>}
                  {req.claimed_at && <span className="ml-2 text-xs text-stone-400">{formatTime(req.claimed_at)}</span>}
                </dd>
              </>
            )}
            {req.error && (<><dt className="text-stone-500">Error</dt><dd className="text-rose-700">{req.error}</dd></>)}
            {req.registry_status && (
              <>
                <dt className="text-stone-500">On-chain registry</dt>
                <dd>
                  <RegistryBadge status={req.registry_status} />
                  <span className="ml-2 text-xs text-stone-500">{REGISTRY_STYLE[req.registry_status]?.why}</span>
                  {req.registry_key && (
                    <div className="mt-0.5 font-mono text-[11px] text-stone-400" title="HMAC(program | batch | beneficiary); reveals nothing about the person">
                      key {req.registry_key.slice(0, 16)}…
                    </div>
                  )}
                </dd>
              </>
            )}
            <dt className="text-stone-500">Reconciliation</dt>
            <dd>
              <ReconBadge category={req.recon_status} />
              {req.recon_reasons?.map((r) => <span key={r} className="ml-2 text-xs text-stone-600">{describeReason(r)}</span>)}
              {req.recon_at && <span className="ml-2 text-xs text-stone-400">checked {formatTime(req.recon_at)}</span>}
            </dd>
          </dl>
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="Why it was flagged"><FlagChips flags={req.flags} verbose /></Card>

          {(open || invalid || req.status === "FAILED") && (
            <Card title={invalid ? "Invalid record" : req.status !== "FAILED" ? "Decision" : req.registry_status === "BLOCKED" ? "Blocked by the registry" : "Retry"}>
              <div className="flex flex-col gap-2">
                <ReviewerInput value={reviewer} onChange={setReviewer} />
                {invalid ? (
                  <>
                    <p className="text-xs text-stone-600">This row failed validation at upload. Fix it below, or reject it.</p>
                    <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)}
                      className="rounded-lg border border-stone-300 px-2 py-1 text-sm focus:border-teal-600 focus:outline-none" />
                    <Button variant="danger" disabled={busy || !reviewer.trim()} onClick={() => act("reject")}>Reject</Button>
                  </>
                ) : open ? (
                  <>
                    {req.status === "HELD" && req.note && <p className="text-xs text-stone-500">Held: “{req.note}”</p>}
                    <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)}
                      className="rounded-lg border border-stone-300 px-2 py-1 text-sm focus:border-teal-600 focus:outline-none" />
                    <Button disabled={busy || !reviewer.trim()} onClick={() => act("approve")}>Approve</Button>
                    <div className="flex gap-2">
                      {req.status === "PENDING_REVIEW" && (
                        <Button className="flex-1" variant="secondary" disabled={busy || !reviewer.trim()} onClick={() => act("hold")}>Hold</Button>
                      )}
                      <Button className="flex-1" variant="danger" disabled={busy || !reviewer.trim()} onClick={() => act("reject")}>Reject</Button>
                    </div>
                  </>
                ) : req.registry_status === "BLOCKED" ? (
                  <p className="text-xs text-stone-600">
                    Nothing was sent. This beneficiary already has a registered payout in slot{" "}
                    <b>{req.payout_slot}</b> of batch <b>{req.batch_id}</b>.
                  </p>
                ) : (
                  <>
                    <p className="text-xs text-stone-500">The old transaction can no longer land, so sending a new one is safe.</p>
                    <Button disabled={busy || !reviewer.trim()} onClick={() => act("retry")}>Send back to approved</Button>
                  </>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      {(open || invalid) && edit && (
        <Card title="Correct details" className="mt-4">
          <div id="correct" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {FIELDS.map(([k, label]) => (
              <label key={k} className="flex flex-col gap-1 text-xs text-stone-500">
                {label}
                <input value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })}
                  placeholder={k === "beneficiary_id" ? "type the real ID to change" : undefined}
                  className={`h-9 rounded-lg border border-stone-300 px-2 text-sm text-stone-900 focus:border-teal-600 focus:outline-none ${k === "wallet" ? "font-mono" : ""}`} />
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-stone-500">
            The fix is validated, screened again from scratch, and logged with old and new values. It then needs a fresh decision.
            A beneficiary ID you type is stored only as its HMAC token.
          </p>
            <Button variant="secondary" disabled={busy || !reviewer.trim()} onClick={() => act("correct")}>Save correction</Button>
          </div>
        </Card>
      )}

      <Card title="Audit trail" className="mt-4">
        {req.events?.length ? (
          <ol className="relative ml-2 border-l border-stone-200">
            {req.events.map((e, i) => (
              <li key={i} className="mb-3 ml-4">
                <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-teal-600" />
                <div className="text-sm font-medium capitalize text-stone-800">{e.kind.replaceAll("_", " ")}</div>
                <div className="text-xs text-stone-500">{formatTime(e.at)}</div>
                {e.detail && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-stone-50 px-2 py-1 font-mono text-[11px] text-stone-600">{e.detail}</pre>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-stone-500">No events yet.</p>
        )}
      </Card>
    </>
  );
}
