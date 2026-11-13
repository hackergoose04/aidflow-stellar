"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useState } from "react";
import { accountState, explorerAccount, get, post, type AidRequest } from "@/lib/api";
import { CLAIM_STYLE, describeReason, formatAmount, formatTime, REGISTRY_STYLE } from "@/lib/format";
import {
  Button, Card, ClaimBadge, ErrorNote, FlagChips, PageHeader, ReconBadge, RegistryBadge, ReviewerInput, RiskBar, StatusBadge, TxLink,
  useReviewer,
} from "@/components/ui";

const FIELDS = [
  ["beneficiary_id", "Beneficiary ID"], ["wallet", "Wallet"], ["amount", "Amount"], ["batch_id", "Batch"],
  ["payout_slot", "Payout slot"], ["installment", "Reported installment (optional)"],
  ["benefit_month", "Benefit month (YYYY-MM, optional)"],
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
  const [walletState, setWalletState] = useState<Awaited<ReturnType<typeof accountState>>>(null);

  const load = useCallback(() => {
    get<AidRequest>(`/requests/${encodeURIComponent(id)}`)
      .then((r) => {
        setReq(r);
        // Beneficiary starts empty: only a token is stored; staff type the real ID to change it.
        setEdit({ beneficiary_id: "", wallet: r.wallet, amount: r.amount ? String(Number(r.amount) || r.amount) : "",
          batch_id: r.batch_id ?? "", payout_slot: r.payout_slot,
          installment: String(r.installment ?? ""), benefit_month: r.benefit_month ?? "", created_at: r.created_at });
        setError(null);
      }, (e) => setError((e as Error).message));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (req?.wallet) accountState(req.wallet).then(setWalletState);
  }, [req?.wallet]);

  async function act(action: "approve" | "reject" | "hold" | "retry" | "correct") {
    setBusy(true);
    try {
      const changes = action === "correct" && edit
        ? Object.fromEntries(Object.entries(edit).filter(([key, value]) => {
          if (key === "installment" || key === "benefit_month") {
            return value.trim() !== String(req?.[key] ?? "");
          }
          return value.trim() !== "";
        }))
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
    return <><ErrorNote error={error} />{!error && <p className="text-[13px] text-zinc-500">Loading…</p>}</>;
  }
  const open = req.status === "PENDING_REVIEW" || req.status === "HELD";
  const invalid = req.status === "INVALID";
  const paid = req.status === "CONFIRMED" || req.status === "CLAIMED";

  const decisionTitle = invalid ? "Invalid record" : req.status !== "FAILED" ? "Decision"
    : req.registry_status === "BLOCKED" ? "Blocked by the registry" : "Retry";

  return (
    <>
      <PageHeader
        eyebrow={<><Link href="/requests" className="hover:text-zinc-900">Requests</Link><span className="mx-1.5 text-zinc-300">/</span>{req.batch_id ?? "No batch"}</>}
        title={<span className="flex flex-wrap items-center gap-3"><span className="font-mono">{req.request_ref}</span><StatusBadge status={req.status} /></span>}
        action={
          <div className="text-right">
            <div className="text-[28px] font-semibold leading-none tracking-tight tabular-nums text-zinc-900">{formatAmount(req.amount)}</div>
            <div className="mt-1 text-[12px] text-zinc-500">{req.asset}</div>
          </div>
        } />
      <ErrorNote error={error} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <Card title="Request">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-[9rem_1fr]">
              <Row label="Beneficiary">
                <span className="font-mono text-[12px]">{req.beneficiary_id || "—"}</span>
                <span className="ml-2 text-[12px] text-zinc-400">pseudonymous token</span>
              </Row>
              <Row label="Payout slot">{req.payout_slot}</Row>
              <Row label="Reported installment">{req.installment ?? "—"}</Row>
              <Row label="Benefit month">{req.benefit_month ?? "—"}</Row>
              <Row label="Wallet">
                {walletState === "missing" || walletState === "invalid" ? (
                  <>
                    <span className="break-all font-mono text-[12px] text-zinc-800">{req.wallet}</span>
                    <div className="mt-0.5 text-[12px] text-zinc-500">
                      {walletState === "invalid"
                        ? "Not a valid Stellar address."
                        : "Not on Stellar yet: never funded, so explorers can't show it. A payout waits as a claimable balance until the owner opens the account and claims."}
                    </div>
                  </>
                ) : (
                  <a href={explorerAccount(req.wallet)} target="_blank" rel="noreferrer" className="link break-all font-mono text-[12px]">{req.wallet} ↗</a>
                )}
              </Row>
              <Row label="Requested">{formatTime(req.created_at)}</Row>
              <Row label="AI risk"><RiskBar score={req.risk_score} mlFlagged={req.flags.some((flag) => flag.startsWith("ml_high_risk:"))} /></Row>
              {req.reviewer && <Row label="Reviewed by">{req.reviewer}{req.note && <span className="text-zinc-500"> · “{req.note}”</span>}</Row>}
            </dl>
          </Card>

          <Card title="On Stellar">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-[9rem_1fr]">
              <Row label="Paid as">{req.method ? METHOD_LABEL[req.method] : <span className="text-zinc-400">Not paid yet</span>}</Row>
              {req.tx_hash && <Row label="Transaction"><TxLink hash={req.tx_hash} label={req.tx_hash} /></Row>}
              {paid && req.method === "claimable_balance" && (
                <Row label="Delivery">
                  <ClaimBadge method={req.method} status={req.claim_status} />
                  {req.claim_status && <span className="ml-2 text-[12px] text-zinc-500">{CLAIM_STYLE[req.claim_status]?.why}</span>}
                  {req.claimed_at && <span className="ml-2 text-[12px] text-zinc-400">{formatTime(req.claimed_at)}</span>}
                </Row>
              )}
              {req.error && <Row label="Error"><span className="text-rose-600">{req.error}</span></Row>}
              {req.registry_status && (
                <Row label="Registry">
                  <RegistryBadge status={req.registry_status} />
                  <span className="ml-2 text-[12px] text-zinc-500">{REGISTRY_STYLE[req.registry_status]?.why}</span>
                  {req.registry_key && (
                    <div className="mt-1 font-mono text-[11px] text-zinc-400" title="Hashed registry key for this payout slot">
                      key {req.registry_key.slice(0, 16)}…
                    </div>
                  )}
                </Row>
              )}
              <Row label="Reconciliation">
                <ReconBadge category={req.recon_status} />
                {req.recon_reasons?.map((r) => <span key={r} className="ml-2 text-[12px] text-zinc-600">{describeReason(r)}</span>)}
                {req.recon_at && <span className="ml-2 text-[12px] text-zinc-400">checked {formatTime(req.recon_at)}</span>}
              </Row>
            </dl>
          </Card>

          {(open || invalid) && edit && (
            <Card title="Correct details" action="Re-screened from scratch and logged with old and new values">
              <div id="correct" className="grid gap-3 sm:grid-cols-2">
                {FIELDS.map(([k, label]) => (
                  <label key={k} className="flex flex-col gap-1 text-[12px] text-zinc-500">
                    {label}
                    <input value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })}
                      placeholder={k === "beneficiary_id" ? "Type the real ID to change" : undefined}
                      inputMode={k === "installment" ? "numeric" : undefined}
                      className={`input h-9 ${k === "wallet" ? "font-mono" : ""}`} />
                  </label>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[12px] text-zinc-500">It then needs a fresh decision. A typed beneficiary ID is stored only as its HMAC token.</p>
                <Button variant="secondary" disabled={busy || !reviewer.trim()} onClick={() => act("correct")}>Save correction</Button>
              </div>
            </Card>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {(open || invalid || req.status === "FAILED") && (
            <Card title={decisionTitle}>
              <div className="flex flex-col gap-2">
                {req.registry_status !== "BLOCKED" && <ReviewerInput value={reviewer} onChange={setReviewer} compact />}
                {invalid ? (
                  <>
                    <p className="text-[12px] text-zinc-500">This row failed validation at upload. Fix it, or reject it.</p>
                    <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="input" />
                    <Button variant="danger" disabled={busy || !reviewer.trim()} onClick={() => act("reject")}>Reject</Button>
                  </>
                ) : open ? (
                  <>
                    {req.status === "HELD" && req.note && <p className="text-[12px] text-zinc-500">Held: “{req.note}”</p>}
                    <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="input" />
                    <Button disabled={busy || !reviewer.trim()} onClick={() => act("approve")}>Approve</Button>
                    <div className="flex gap-2">
                      {req.status === "PENDING_REVIEW" && (
                        <Button className="flex-1" variant="secondary" disabled={busy || !reviewer.trim()} onClick={() => act("hold")}>Hold</Button>
                      )}
                      <Button className="flex-1" variant="danger" disabled={busy || !reviewer.trim()} onClick={() => act("reject")}>Reject</Button>
                    </div>
                  </>
                ) : req.registry_status === "BLOCKED" ? (
                  <p className="text-[13px] leading-relaxed text-zinc-600">
                    Nothing was sent. This beneficiary already has a registered payout in slot{" "}
                    <b className="font-medium">{req.payout_slot}</b> of batch <b className="font-medium">{req.batch_id}</b>.
                  </p>
                ) : (
                  <>
                    <p className="text-[12px] text-zinc-500">The old transaction can no longer land, so sending a new one is safe.</p>
                    <Button disabled={busy || !reviewer.trim()} onClick={() => act("retry")}>Send back to approved</Button>
                  </>
                )}
                {!reviewer.trim() && req.registry_status !== "BLOCKED" && <p className="text-[12px] text-amber-600">Enter your name under Reviewing as first.</p>}
              </div>
            </Card>
          )}

          <Card title="Flags"><FlagChips flags={req.flags} riskSignals={req.risk_signals} payment={req} verbose /></Card>

          <Card title="Activity">
            {req.events?.length ? (
              <ol className="relative">
                {req.events.map((e, i) => (
                  <li key={i} className="relative pb-4 pl-5 last:pb-0">
                    {i < (req.events?.length ?? 0) - 1 && <span className="absolute top-3 bottom-0 left-[3px] w-px bg-zinc-200" />}
                    <span className="absolute top-[7px] left-0 h-[7px] w-[7px] rounded-full border border-zinc-400 bg-white" />
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] font-medium capitalize text-zinc-800">{e.kind.replaceAll("_", " ")}</span>
                      <span className="shrink-0 text-[11px] text-zinc-400">{formatTime(e.at)}</span>
                    </div>
                    <EventDetail detail={e.detail} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[13px] text-zinc-500">No events yet.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

/** Event detail as readable lines instead of raw JSON; a correction shows "field: old → new". */
function EventDetail({ detail }: { detail: string | null }) {
  if (!detail) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(detail);
  } catch {
    return <div className="mt-1 break-all font-mono text-[11px] text-zinc-500">{detail}</div>;
  }
  const lines: [string, string][] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined || v === "" || k === "stored_as_invalid") continue;
    if (k === "changes" && typeof v === "object") {
      for (const [field, pair] of Object.entries(v as Record<string, [unknown, unknown]>)) {
        lines.push([field.replaceAll("_", " "), `${pair[0] ?? "—"} → ${pair[1] ?? "—"}`]);
      }
    } else if (Array.isArray(v)) {
      lines.push([k.replaceAll("_", " "), v.map((x) => String(x).replaceAll("_", " ")).join(", ")]);
    } else if (typeof v === "object") {
      lines.push([k.replaceAll("_", " "), JSON.stringify(v)]);
    } else {
      lines.push([k.replaceAll("_", " "), String(v)]);
    }
  }
  if (!lines.length) return null;
  return (
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
      {lines.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-zinc-400">{k}</dt>
          <dd className={`break-all text-zinc-600 ${/hash|key|tx|balance/.test(k) ? "font-mono" : ""}`}>{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}
