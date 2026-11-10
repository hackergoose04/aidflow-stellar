"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { get, type PublicBatch, type PublicPayment, type PublicSummary } from "@/lib/api";
import { formatAmount, formatTime, pct, shortKey } from "@/lib/format";
import { Button, Card, ErrorNote } from "@/components/ui";

const STATUS_TONE: Record<string, string> = {
  Received: "bg-teal-50 text-teal-800 ring-teal-300",
  Paid: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  "In progress": "bg-indigo-50 text-indigo-800 ring-indigo-200",
  "Under review": "bg-amber-50 text-amber-800 ring-amber-200",
  "Not paid": "bg-stone-100 text-stone-600 ring-stone-200",
};

function PublicBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_TONE[status] ?? ""}`}>
      {status}
    </span>
  );
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const b64ToHex = (b64: string) => [...atob(b64)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");

interface Check { label: string; ok: boolean | null; detail: string }

/** Re-check a payment against Stellar directly from the browser, without trusting our server. */
async function verifyOnChain(p: PublicPayment, s: PublicSummary): Promise<Check[]> {
  const checks: Check[] = [];
  const memo = await sha256Hex(p.request_ref);
  if (!p.tx_hash) return [{ label: "Payment on Stellar", ok: null, detail: "Not paid yet, so there is no transaction to check." }];
  const tx = await (await fetch(`${s.horizon_url}/transactions/${p.tx_hash}`)).json();
  checks.push({ label: "Transaction succeeded on Stellar", ok: tx.successful === true,
    detail: `Ledger ${tx.ledger}, ${formatTime(tx.created_at)}` });
  const chainMemo = tx.memo_type === "hash" ? b64ToHex(tx.memo) : null;
  checks.push({ label: "Memo = SHA-256 of the reference (computed in your browser)", ok: chainMemo === memo,
    detail: `${memo.slice(0, 16)}… vs on chain ${chainMemo ? chainMemo.slice(0, 16) + "…" : "none"}` });
  const ops = (await (await fetch(`${s.horizon_url}/transactions/${p.tx_hash}/operations`)).json())._embedded.records;
  const op = ops.find((o: { type: string }) => o.type === "payment" || o.type === "create_claimable_balance");
  if (op) {
    checks.push({ label: "Amount on chain matches", ok: Number(op.amount) === Number(p.amount),
      detail: `${formatAmount(op.amount)} on chain, ${formatAmount(p.amount)} reported` });
    const issuer = op.type === "payment" ? op.asset_issuer : String(op.asset).split(":")[1];
    const from = op.type === "payment" ? op.from : op.source_account;
    checks.push({ label: `Paid in ${s.asset} from the NGO's wallet`, ok: issuer === s.asset_issuer && from === s.ngo_account,
      detail: `asset issuer ${shortKey(issuer)}, sender ${shortKey(from)}` });
  }
  return checks;
}

function DonorView() {
  const params = useSearchParams();
  const [summary, setSummary] = useState<PublicSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<{ id: string; rows: PublicPayment[] } | null>(null);
  const [ref, setRef] = useState(params.get("ref") ?? "");
  const [payment, setPayment] = useState<PublicPayment | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<PublicSummary>("/public/summary").then(setSummary, (e) => setError((e as Error).message));
  }, []);

  const lookup = useCallback(async (r: string) => {
    if (!r.trim() || !summary) return;
    setBusy(true);
    setChecks(null);
    try {
      const p = await get<PublicPayment>(`/public/payments/${encodeURIComponent(r.trim())}`);
      setPayment(p);
      setError(null);
      setChecks(await verifyOnChain(p, summary));
    } catch (e) {
      setPayment(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [summary]);

  useEffect(() => {
    const r = params.get("ref");
    if (r && summary) lookup(r);
  }, [params, summary, lookup]);

  async function openBatch(b: PublicBatch) {
    if (!b.batch_id) return;
    try {
      setBatch({ id: b.batch_id, rows: await get<PublicPayment[]>(`/public/batches/${encodeURIComponent(b.batch_id)}`) });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const t = summary?.totals;
  return (
    <>
      <div className="mb-6">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-800 ring-1 ring-teal-200">Public · for donors</span>
          {summary && <span className="text-xs text-stone-500">{summary.program} · {summary.network}</span>}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900">Where the aid went</h1>
        <p className="mt-1 max-w-2xl text-sm text-stone-500">
          Every payout is a public Stellar transaction. This page shows amounts and outcomes only, never who received
          them. You can check any payment yourself: your browser reads it straight from Stellar.
        </p>
      </div>
      <ErrorNote error={error} />

      {t && summary && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile value={`${formatAmount(t.amount_paid)} ${summary.asset}`} label="Paid out" />
          <Tile value={`${t.paid} / ${t.requests}`} label="Requests paid" />
          <Tile value={t.paid ? pct(t.received / t.paid) : "—"} label="Reached the beneficiary's wallet" />
          <Tile value={t.paid ? pct(t.reconciled / t.paid) : "—"} label="Matched to our records on chain" />
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-5">
        <Card title="Check a payment" className="md:col-span-2">
          <form onSubmit={(e) => { e.preventDefault(); lookup(ref); }} className="flex gap-2">
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Payment reference, e.g. LIVE-…-1"
              className="min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-1.5 font-mono text-sm focus:border-teal-600 focus:outline-none" />
            <Button disabled={busy || !ref.trim()}>{busy ? "Checking…" : "Check"}</Button>
          </form>
          {payment && (
            <div className="mt-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">{payment.request_ref}</span>
                <PublicBadge status={payment.status} />
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">
                {formatAmount(payment.amount)} <span className="text-sm font-normal text-stone-500">{payment.asset}</span>
              </div>
              <div className="text-xs text-stone-500">
                Batch {payment.batch_id}{payment.paid_at && ` · paid ${formatTime(payment.paid_at)}`}
                {payment.claimed_at && ` · received ${formatTime(payment.claimed_at)}`}
              </div>
              {checks && (
                <ul className="mt-3 flex flex-col gap-2">
                  {checks.map((c) => (
                    <li key={c.label} className="flex gap-2 text-sm">
                      <span className={c.ok === null ? "text-stone-400" : c.ok ? "text-emerald-600" : "text-rose-600"}>
                        {c.ok === null ? "○" : c.ok ? "✓" : "✗"}
                      </span>
                      <div>
                        <div className="text-stone-800">{c.label}</div>
                        <div className="font-mono text-[11px] text-stone-500">{c.detail}</div>
                      </div>
                    </li>
                  ))}
                  {payment.registry_status === "PAID" && summary?.registry_explorer && (
                    <li className="flex gap-2 text-sm">
                      <span className="text-emerald-600">✓</span>
                      <div>
                        <div className="text-stone-800">Recorded in the on-chain payout registry</div>
                        <a href={summary.registry_explorer} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-teal-700 hover:underline">
                          contract {shortKey(summary.registry_contract, 6)} ↗
                        </a>
                      </div>
                    </li>
                  )}
                </ul>
              )}
              {payment.explorer && (
                <a href={payment.explorer} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm text-teal-700 hover:underline">
                  See the transaction on stellar.expert ↗
                </a>
              )}
            </div>
          )}
        </Card>

        <Card title="Payout batches" className="md:col-span-3">
          {summary?.batches.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-sm">
                <thead className="text-xs text-stone-500">
                  <tr>
                    <th className="py-1 font-medium">Batch</th>
                    <th className="text-right font-medium">Requests</th>
                    <th className="text-right font-medium">Paid</th>
                    <th className="text-right font-medium">Received</th>
                    <th className="text-right font-medium">Amount paid</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.batches.map((b) => (
                    <tr key={b.batch_id ?? "none"} onClick={() => openBatch(b)}
                      className={`cursor-pointer border-t border-stone-100 hover:bg-stone-50 ${batch?.id === b.batch_id ? "bg-teal-50/60" : ""}`}>
                      <td className="whitespace-nowrap py-2 font-mono text-xs">{b.batch_id}</td>
                      <td className="text-right tabular-nums">{b.requests}</td>
                      <td className="text-right tabular-nums">{b.paid}</td>
                      <td className="text-right tabular-nums">{b.received}</td>
                      <td className="text-right tabular-nums">{formatAmount(b.amount_paid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-sm text-stone-500">No batches yet.</p>}
          {summary && (
            <p className="mt-3 text-xs text-stone-500">
              NGO wallet{" "}
              <a href={summary.ngo_explorer} target="_blank" rel="noreferrer" className="font-mono text-teal-700 hover:underline">{shortKey(summary.ngo_account, 6)} ↗</a>
              {" "}· every payout leaves from here and is public on Stellar.
            </p>
          )}
        </Card>
      </div>

      {batch && (
        <Card className="mt-4" title={`Batch ${batch.id} · ${batch.rows.length} payments`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-xs text-stone-500">
                <tr>
                  <th className="py-1 font-medium">Reference</th>
                  <th className="text-right font-medium">Amount</th>
                  <th className="pl-6 font-medium">Status</th>
                  <th className="font-medium">Transaction</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {batch.rows.map((p) => (
                  <tr key={p.request_ref} className="border-t border-stone-100">
                    <td className="whitespace-nowrap py-2 font-mono text-xs">{p.request_ref}</td>
                    <td className="text-right tabular-nums">{formatAmount(p.amount)}</td>
                    <td className="pl-6"><PublicBadge status={p.status} /></td>
                    <td>
                      {p.explorer
                        ? <a href={p.explorer} target="_blank" rel="noreferrer" className="font-mono text-xs text-teal-700 hover:underline">{p.tx_hash?.slice(0, 10)}… ↗</a>
                        : <span className="text-xs text-stone-400">—</span>}
                    </td>
                    <td className="text-right">
                      {p.tx_hash && (
                        <button onClick={() => { setRef(p.request_ref); lookup(p.request_ref); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                          className="text-xs text-teal-700 hover:underline">Check</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums text-stone-900">{value}</div>
      <div className="text-xs text-stone-500">{label}</div>
    </div>
  );
}

export default function DonorPage() {
  return (
    <Suspense fallback={<p className="text-sm text-stone-500">Loading…</p>}>
      <DonorView />
    </Suspense>
  );
}
