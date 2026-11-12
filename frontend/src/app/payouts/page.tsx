"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import { get, payAll, post, type AidRequest, type ClaimResult, type Delivery, type VerifyResult } from "@/lib/api";
import { formatAmount, formatHours, formatTime, STATUS_STYLE } from "@/lib/format";
import { Button, Card, ClaimBadge, Empty, ErrorNote, Notice, PageHeader, RegistryBadge, Select, Stats, TxLink } from "@/components/ui";

const PAID_STATES = new Set(["SUBMITTED", "CONFIRMED", "CLAIMED", "FAILED", "UNKNOWN"]);

function PaymentStatus({ request }: { request: AidRequest }) {
  const tone = request.status === "CONFIRMED" || request.status === "CLAIMED"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : request.status === "FAILED"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : request.status === "UNKNOWN"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-indigo-200 bg-indigo-50 text-indigo-800";
  return (
    <span className={`inline-flex h-[22px] items-center whitespace-nowrap rounded-md border px-1.5 text-[12px] font-medium ${tone}`}>
      {STATUS_STYLE[request.status].label}
    </span>
  );
}

export default function Payouts() {
  const [rows, setRows] = useState<AidRequest[] | null>(null);
  const [approvedRows, setApprovedRows] = useState<AidRequest[]>([]);
  const [batch, setBatch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [progress, setProgress] = useState("");

  const load = useCallback(async () => {
    try {
      const all = await get<AidRequest[]>("/requests");
      setRows(all.filter((r) => PAID_STATES.has(r.status))
        .sort((a, b) => Date.parse(b.submitted_at ?? b.updated_at) - Date.parse(a.submitted_at ?? a.updated_at)));
      setApprovedRows(all.filter((r) => r.status === "APPROVED"));
      get<Delivery>("/delivery").then(setDelivery, () => setDelivery(null));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run(kind: "pay" | "verify") {
    setBusy(kind);
    setMessage(null);
    try {
      if (kind === "pay") {
        const total = approved;
        setProgress(`0 of ${total}`);
        const r = await payAll(async (done) => { setProgress(`${Math.min(done, total)} of ${total}`); await load(); }, batch);
        const ok = r.filter((x) => x.status === "CONFIRMED").length;
        setMessage(r.length ? `Sent ${r.length} payouts: ${ok} confirmed, ${r.length - ok} need attention.` : "Nothing approved to pay.");
      } else {
        const r = await post<VerifyResult[]>("/payouts/verify");
        const c = await post<ClaimResult[]>("/payouts/claims");
        const claimed = c.filter((x) => x.claim_status === "CLAIMED").length;
        setMessage(`${r.length ? `Checked ${r.length} unclear transactions on chain.` : "No unclear transactions."} `
          + `${claimed} of ${c.length} claimable balances picked up by beneficiaries.`);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      load();
    }
  }

  const count = (s: string) => rows?.filter((r) => r.status === s).length ?? 0;
  const batches = [...new Set(approvedRows.map((r) => r.batch_id ?? ""))].sort().reverse();  // newest batch first
  const approved = approvedRows.filter((r) => !batch || r.batch_id === batch).length;
  const waiting = new Map(delivery?.unclaimed.map((u) => [u.request_ref, u]) ?? []);
  const overdue = delivery?.unclaimed.filter((u) => u.overdue) ?? [];

  return (
    <>
      <PageHeader title="Payouts"
        subtitle="Send approved payouts and verify their status. When enabled, the on-chain registry blocks repeat payments in the same payout slot."
        action={<>
          {batches.length > 1 && (
            <Select label="Batch to pay" className="w-56" value={batch} onChange={setBatch} disabled={!!busy}
              options={[{ value: "", label: "All batches", hint: String(approvedRows.length) },
                ...batches.map((b) => ({ value: b, label: b, hint: String(approvedRows.filter((r) => (r.batch_id ?? "") === b).length) }))]} />
          )}
          <Button variant="secondary" disabled={!!busy} onClick={() => run("verify")}>
            {busy === "verify" ? "Checking…" : "Verify & check claims"}
          </Button>
          <Button disabled={!!busy || !approved} onClick={() => run("pay")}>
            {busy === "pay" ? `Paying ${progress}…` : `Pay ${approved} approved`}
          </Button>
        </>} />
      <ErrorNote error={error} />
      {message && <Notice tone="success">{message}</Notice>}
      {overdue.length > 0 && (
        <Notice tone="warning">
          {overdue.length} payout{overdue.length > 1 ? "s have" : " has"} waited over {formatHours(delivery!.alert_hours)} without being claimed.
          Contact the beneficiary: the money arrived but hasn&apos;t reached them.
        </Notice>
      )}

      <Stats items={[
        { label: "Confirmed", value: count("CONFIRMED"), hint: "in wallet or awaiting claim" },
        { label: "Claimed", value: count("CLAIMED"), hint: "picked up by beneficiary" },
        { label: "In flight", value: count("SUBMITTED"), hint: "submitted, no result yet" },
        { label: "Unclear", value: count("UNKNOWN"), hint: "run Verify", tone: count("UNKNOWN") ? "text-amber-600" : undefined },
        { label: "Failed", value: count("FAILED"), hint: "nothing sent", tone: count("FAILED") ? "text-rose-600" : undefined },
      ]} />

      <Card flush>
        {rows === null && !error ? (
          <Empty>Loading…</Empty>
        ) : !rows?.length ? (
          <Empty>No payouts yet. Approve requests in <Link href="/review" className="link">Review</Link>, then pay them here.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[1000px]">
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Beneficiary</th>
                  <th className="text-right">Amount</th>
                  <th>Status</th>
                  <th>Delivery</th>
                  <th>Registry</th>
                  <th>Sent</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.request_ref}>
                  <tr className={r.error ? "[&>td]:border-b-0" : ""}>
                    <td className="whitespace-nowrap font-mono text-[12px] font-medium">
                      <Link href={`/requests/${encodeURIComponent(r.request_ref)}`} className="hover:underline">{r.request_ref}</Link>
                    </td>
                    <td className="whitespace-nowrap font-mono text-[12px] text-zinc-500">{r.beneficiary_id}</td>
                    <td className="text-right font-medium tabular-nums">{formatAmount(r.amount)}</td>
                    <td><PaymentStatus request={r} /></td>
                    <td className="whitespace-nowrap">
                      {(r.status === "CONFIRMED" || r.status === "CLAIMED") ? <ClaimBadge method={r.method} status={r.claim_status} /> : <span className="text-[12px] text-zinc-300">—</span>}
                      {waiting.get(r.request_ref) && (
                        <span className={`ml-2 text-[12px] tabular-nums ${waiting.get(r.request_ref)!.overdue ? "font-medium text-rose-600" : "text-zinc-400"}`}>
                          {formatHours(waiting.get(r.request_ref)!.waiting_hours)}
                        </span>
                      )}
                    </td>
                    <td><RegistryBadge status={r.registry_status} /></td>
                    <td className="whitespace-nowrap text-[12px] text-zinc-500">{formatTime(r.submitted_at)}</td>
                    <td className="whitespace-nowrap"><TxLink hash={r.tx_hash} /></td>
                  </tr>
                  {r.error && (
                    <tr><td colSpan={8} className="!pt-0 text-[12px] text-rose-600">{r.error}</td></tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
