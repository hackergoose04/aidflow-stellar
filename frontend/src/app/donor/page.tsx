"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { get, type PublicBatch, type PublicPayment, type PublicSummary } from "@/lib/api";
import { formatAmount, formatTime, pct, shortKey } from "@/lib/format";
import { Badge, Button, Card, Empty, ErrorNote } from "@/components/ui";

const STATUS_DOT: Record<string, string> = {
  Received: "#0d7a5f",
  Paid: "#16a34a",
  "In progress": "#7c8cf8",
  "Under review": "#d97706",
  "Not paid": "#d4d4d8",
};

function PublicBadge({ status }: { status: string }) {
  return <Badge label={status} dot={STATUS_DOT[status]} />;
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
      <section className="mb-10">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-zinc-500">
          <span className="rounded-full border border-zinc-200 px-2 py-0.5 font-medium text-zinc-700">Public report</span>
          {summary && <span>{summary.program} · {summary.network}</span>}
        </div>
        <h1 className="max-w-2xl text-[34px] font-semibold leading-[1.15] tracking-[-0.02em] text-zinc-900 sm:text-[40px]">
          Where the aid went
        </h1>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-zinc-500">
          Every payout is a public Stellar transaction. This page shows amounts and outcomes, never who received them,
          and you can check any payment yourself: your browser reads it straight from the chain.
        </p>
      </section>
      <ErrorNote error={error} />

      {t && summary && (
        <div className="mb-12 grid grid-cols-2 gap-x-6 gap-y-8 border-y border-zinc-100 py-8 md:grid-cols-4">
          <Figure value={formatAmount(t.amount_paid)} unit={summary.asset} label="Paid out" />
          <Figure value={`${t.paid}`} unit={`of ${t.requests}`} label="Requests paid" />
          <Figure value={t.paid ? pct(t.received / t.paid) : "—"} label="Reached the beneficiary's wallet" />
          <Figure value={t.paid ? pct(t.reconciled / t.paid) : "—"} label="Matched to records on chain" />
        </div>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <Card title="Verify a payment" className="lg:col-span-2">
          <form onSubmit={(e) => { e.preventDefault(); lookup(ref); }} className="flex gap-2">
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Payment reference"
              className="input h-9 min-w-0 flex-1 font-mono" />
            <Button className="h-9" disabled={busy || !ref.trim()}>{busy ? "Checking…" : "Verify"}</Button>
          </form>
          {!payment && <p className="mt-3 text-[12px] text-zinc-500">Pick a batch on the right, or paste a reference from a receipt.</p>}
          {payment && (
            <div className="mt-5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[12px] text-zinc-500">{payment.request_ref}</span>
                <PublicBadge status={payment.status} />
              </div>
              <div className="mt-1 text-[28px] font-semibold tracking-tight tabular-nums">
                {formatAmount(payment.amount)} <span className="text-[13px] font-normal text-zinc-400">{payment.asset}</span>
              </div>
              <div className="text-[12px] text-zinc-500">
                Batch {payment.batch_id}{payment.paid_at && ` · paid ${formatTime(payment.paid_at)}`}
                {payment.claimed_at && ` · received ${formatTime(payment.claimed_at)}`}
              </div>
              {checks && (
                <ul className="mt-5 divide-y divide-zinc-100 border-y border-zinc-100">
                  {checks.map((c) => (
                    <li key={c.label} className="flex gap-3 py-2.5">
                      <CheckMark ok={c.ok} />
                      <div className="min-w-0">
                        <div className="text-[13px] text-zinc-800">{c.label}</div>
                        <div className="break-all font-mono text-[11px] text-zinc-400">{c.detail}</div>
                      </div>
                    </li>
                  ))}
                  {payment.registry_status === "PAID" && summary?.registry_explorer && (
                    <li className="flex gap-3 py-2.5">
                      <CheckMark ok />
                      <div>
                        <div className="text-[13px] text-zinc-800">Recorded in the on-chain payout registry</div>
                        <a href={summary.registry_explorer} target="_blank" rel="noreferrer" className="link font-mono text-[11px]">
                          contract {shortKey(summary.registry_contract, 6)} ↗
                        </a>
                      </div>
                    </li>
                  )}
                </ul>
              )}
              {payment.explorer && (
                <a href={payment.explorer} target="_blank" rel="noreferrer" className="link mt-4 inline-block text-[13px]">
                  View on stellar.expert ↗
                </a>
              )}
            </div>
          )}
        </Card>

        <Card title="Payout batches" className="lg:col-span-3" flush
          action={summary && <a href={summary.ngo_explorer} target="_blank" rel="noreferrer" className="link font-mono">NGO wallet {shortKey(summary.ngo_account, 4)} ↗</a>}>
          {summary?.batches.length ? (
            <div className="overflow-x-auto">
              <table className="data-table min-w-[480px]">
                <thead>
                  <tr>
                    <th>Batch</th>
                    <th className="text-right">Requests</th>
                    <th className="text-right">Paid</th>
                    <th className="text-right">Received</th>
                    <th className="text-right">Amount paid</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {summary.batches.map((b) => (
                    <tr key={b.batch_id ?? "none"} onClick={() => openBatch(b)}
                      className={`cursor-pointer transition-colors hover:bg-zinc-50 ${batch?.id === b.batch_id ? "bg-zinc-50" : ""}`}>
                      <td className="whitespace-nowrap font-mono text-[12px] font-medium">{b.batch_id}</td>
                      <td className="text-right">{b.requests}</td>
                      <td className="text-right">{b.paid}</td>
                      <td className="text-right">{b.received}</td>
                      <td className="text-right font-medium">{formatAmount(b.amount_paid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty>No batches yet.</Empty>}
        </Card>
      </div>

      {batch && (
        <Card className="mt-6" flush
          title={<>Batch {batch.id} <span className="ml-1 font-normal tabular-nums text-zinc-400">{batch.rows.length}</span></>}>
          <div className="overflow-x-auto">
            <table className="data-table min-w-[560px]">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th className="text-right">Amount</th>
                  <th>Status</th>
                  <th>Transaction</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {batch.rows.map((p) => (
                  <tr key={p.request_ref}>
                    <td className="whitespace-nowrap font-mono text-[12px]">{p.request_ref}</td>
                    <td className="text-right font-medium tabular-nums">{formatAmount(p.amount)}</td>
                    <td><PublicBadge status={p.status} /></td>
                    <td>
                      {p.explorer
                        ? <a href={p.explorer} target="_blank" rel="noreferrer" className="link font-mono text-[12px]">{p.tx_hash?.slice(0, 10)}… ↗</a>
                        : <span className="text-[12px] text-zinc-300">—</span>}
                    </td>
                    <td className="text-right">
                      {p.tx_hash && (
                        <Button size="sm" variant="secondary"
                          onClick={() => { setRef(p.request_ref); lookup(p.request_ref); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                          Verify
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="mt-12 border-t border-zinc-100 pt-6 text-[12px] text-zinc-400">
        Beneficiaries are never named here. Amounts, timing and outcomes come from our records; every paid figure can be checked against Stellar.
      </p>
    </>
  );
}

function Figure({ value, unit, label }: { value: string; unit?: string; label: string }) {
  return (
    <div>
      <div className="text-[28px] font-semibold tracking-tight tabular-nums text-zinc-900">
        {value}{unit && <span className="ml-1.5 text-[13px] font-normal text-zinc-400">{unit}</span>}
      </div>
      <div className="mt-1 text-[13px] text-zinc-500">{label}</div>
    </div>
  );
}

function CheckMark({ ok }: { ok: boolean | null }) {
  const tone = ok === null ? "bg-zinc-100 text-zinc-400" : ok ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600";
  return (
    <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold ${tone}`}>
      {ok === null ? "·" : ok ? "✓" : "✕"}
    </span>
  );
}

export default function DonorPage() {
  return (
    <Suspense fallback={<p className="text-[13px] text-zinc-500">Loading…</p>}>
      <DonorView />
    </Suspense>
  );
}
