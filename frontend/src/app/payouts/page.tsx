"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import { get, post, type AidRequest, type ClaimResult, type PayoutResult, type VerifyResult } from "@/lib/api";
import { formatAmount, formatTime } from "@/lib/format";
import { Button, Card, ClaimBadge, Empty, ErrorNote, Notice, PageHeader, RegistryBadge, Stats, StatusBadge, TxLink } from "@/components/ui";

const PAID_STATES = new Set(["SUBMITTED", "CONFIRMED", "CLAIMED", "FAILED", "UNKNOWN"]);

export default function Payouts() {
  const [rows, setRows] = useState<AidRequest[] | null>(null);
  const [approved, setApproved] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await get<AidRequest[]>("/requests");
      setRows(all.filter((r) => PAID_STATES.has(r.status))
        .sort((a, b) => Date.parse(b.submitted_at ?? b.updated_at) - Date.parse(a.submitted_at ?? a.updated_at)));
      setApproved(all.filter((r) => r.status === "APPROVED").length);
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
        const r = await post<PayoutResult[]>("/payouts/run");
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

  return (
    <>
      <PageHeader title="Payouts"
        subtitle="Each payout is registered on chain first and its transaction hash saved before sending, so neither a human slip nor a network hiccup can pay someone twice."
        action={<>
          <Button variant="secondary" disabled={!!busy} onClick={() => run("verify")}>
            {busy === "verify" ? "Checking…" : "Verify & check claims"}
          </Button>
          <Button disabled={!!busy || !approved} onClick={() => run("pay")}>
            {busy === "pay" ? "Paying…" : `Pay ${approved} approved`}
          </Button>
        </>} />
      <ErrorNote error={error} />
      {message && <Notice tone="success">{message}</Notice>}

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
                    <td><StatusBadge status={r.status} /></td>
                    <td>{(r.status === "CONFIRMED" || r.status === "CLAIMED") ? <ClaimBadge method={r.method} status={r.claim_status} /> : <span className="text-[12px] text-zinc-300">—</span>}</td>
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
