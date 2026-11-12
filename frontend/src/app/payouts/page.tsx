"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { get, post, type AidRequest, type ClaimResult, type PayoutResult, type VerifyResult } from "@/lib/api";
import { formatAmount, formatTime } from "@/lib/format";
import { Button, Card, ClaimBadge, ErrorNote, PageHeader, RegistryBadge, StatusBadge, TxLink } from "@/components/ui";

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
        subtitle="Send approved payouts and verify their status. When enabled, the on-chain registry blocks repeat payments in the same payout slot."
        action={
          <div className="flex gap-2">
            <Button variant="secondary" disabled={!!busy} onClick={() => run("verify")}>
              {busy === "verify" ? "Checking…" : "Verify & check claims"}
            </Button>
            <Button disabled={!!busy || !approved} onClick={() => run("pay")}>
              {busy === "pay" ? "Paying…" : `Pay ${approved} approved`}
            </Button>
          </div>
        } />
      <ErrorNote error={error} />
      {message && <div className="mb-4 rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-900">{message}</div>}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[["CONFIRMED", "Confirmed (in wallet or awaiting claim)", "text-emerald-700"], ["CLAIMED", "Claimed by beneficiary", "text-teal-700"],
          ["SUBMITTED", "In flight", "text-indigo-700"], ["UNKNOWN", "Unclear", "text-orange-700"],
          ["FAILED", "Failed", "text-rose-700"]].map(([s, label, color]) => (
          <div key={s} className="rounded-xl border border-stone-200 bg-white px-4 py-3">
            <div className={`text-2xl font-semibold tabular-nums ${color}`}>{count(s)}</div>
            <div className="text-xs text-stone-500">{label}</div>
          </div>
        ))}
      </div>

      <Card>
        {rows === null && !error ? (
          <p className="text-sm text-stone-500">Loading…</p>
        ) : !rows?.length ? (
          <p className="text-sm text-stone-500">No payouts yet. Approve requests in <Link href="/review" className="text-teal-700 underline">Review</Link>, then pay them here.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-left text-sm [&_td]:pr-3">
              <thead className="text-xs text-stone-500">
                <tr>
                  <th className="py-2 font-medium">Ref</th>
                  <th className="font-medium">Beneficiary</th>
                  <th className="text-right font-medium">Amount</th>
                  <th className="pl-6 font-medium">Method</th>
                  <th className="font-medium">Status</th>
                  <th className="font-medium">Delivery</th>
                  <th className="font-medium">On-chain registry</th>
                  <th className="font-medium">Sent</th>
                  <th className="font-medium">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.request_ref} className="border-t border-stone-100 align-top">
                    <td className="whitespace-nowrap py-2 font-mono text-xs">
                      <Link href={`/requests/${encodeURIComponent(r.request_ref)}`} className="hover:underline">{r.request_ref}</Link>
                    </td>
                    <td className="whitespace-nowrap font-mono text-xs text-stone-600">{r.beneficiary_id}</td>
                    <td className="text-right tabular-nums">{formatAmount(r.amount)}</td>
                    <td className="whitespace-nowrap pl-6 text-xs text-stone-600">{r.method === "payment" ? "Payment" : r.method === "claimable_balance" ? "Claimable balance" : "—"}</td>
                    <td>
                      <StatusBadge status={r.status} />
                      {r.error && <div className="mt-1 max-w-xs text-xs text-rose-700">{r.error}</div>}
                    </td>
                    <td>{(r.status === "CONFIRMED" || r.status === "CLAIMED") ? <ClaimBadge method={r.method} status={r.claim_status} /> : <span className="text-xs text-stone-400">—</span>}</td>
                    <td><RegistryBadge status={r.registry_status} /></td>
                    <td className="whitespace-nowrap text-xs text-stone-500">{formatTime(r.submitted_at)}</td>
                    <td className="whitespace-nowrap"><TxLink hash={r.tx_hash} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
