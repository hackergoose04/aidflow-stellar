"use client";

import { useCallback, useEffect, useState } from "react";
import { get, post, type ClaimResult, type PublicClaimable, type PublicSummary } from "@/lib/api";
import { formatAmount, formatTime, shortKey } from "@/lib/format";
import { Button, Card, ErrorNote, Notice, TxLink } from "@/components/ui";

const TESTNET = "Test SDF Network ; September 2015";

/** Stellar Wallets Kit: one connect button for every Stellar wallet. Loaded in the browser only. */
type Kit = typeof import("@creit.tech/stellar-wallets-kit/sdk").StellarWalletsKit;
let kitPromise: Promise<Kit> | null = null;
function loadKit(): Promise<Kit> {
  if (!kitPromise) {
    kitPromise = (async () => {
      const [{ StellarWalletsKit }, { defaultModules }] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit/sdk"),
        import("@creit.tech/stellar-wallets-kit/modules/utils"),
      ]);
      type Networks = Parameters<typeof StellarWalletsKit.setNetwork>[0];
      StellarWalletsKit.init({ modules: defaultModules(), network: TESTNET as Networks });
      return StellarWalletsKit;
    })();
  }
  return kitPromise;
}

interface ChainBalance { id: string; amount: string; asset: string; last_modified_time: string }
interface AccountInfo { exists: boolean; sequence: string; hasTrustline: boolean }

async function readAccount(horizon: string, address: string, asset: string, issuer: string): Promise<AccountInfo> {
  const res = await fetch(`${horizon}/accounts/${address}`);
  if (res.status === 404) return { exists: false, sequence: "0", hasTrustline: false };
  if (!res.ok) throw new Error(`Horizon ${res.status}`);
  const a = await res.json();
  const hasTrustline = (a.balances as { asset_code?: string; asset_issuer?: string }[])
    .some((b) => b.asset_code === asset && b.asset_issuer === issuer);
  return { exists: true, sequence: a.sequence, hasTrustline };
}

async function readBalances(horizon: string, address: string, asset: string, issuer: string): Promise<ChainBalance[]> {
  const res = await fetch(`${horizon}/claimable_balances?claimant=${address}&asset=${asset}:${issuer}&limit=50`);
  if (!res.ok) throw new Error(`Horizon ${res.status}`);
  return (await res.json())._embedded.records;
}

export default function ClaimPage() {
  const [summary, setSummary] = useState<PublicSummary | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [balances, setBalances] = useState<ChainBalance[] | null>(null);
  const [labels, setLabels] = useState<PublicClaimable[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: string; amount: number } | null>(null);

  useEffect(() => {
    get<PublicSummary>("/public/summary").then(setSummary, (e) => setError((e as Error).message));
    // Always start disconnected: the beneficiary picks their wallet each visit (the page may be on a
    // shared phone or kiosk, and it makes the demo start clean). Forget whatever the kit remembered.
    loadKit().then((kit) => kit.disconnect()).catch(() => { /* nothing remembered */ });
  }, []);

  const refresh = useCallback(async (addr: string) => {
    if (!summary) return;
    setBusy("read");
    try {
      const [acct, bals, lab] = await Promise.all([
        readAccount(summary.horizon_url, addr, summary.asset, summary.asset_issuer),
        readBalances(summary.horizon_url, addr, summary.asset, summary.asset_issuer),
        get<PublicClaimable[]>(`/public/claimable?wallet=${addr}`).catch(() => [] as PublicClaimable[]),
      ]);
      setAccount(acct);
      setBalances(bals);
      setLabels(lab);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [summary]);

  useEffect(() => { if (address) refresh(address); }, [address, refresh]);

  async function connect() {
    setBusy("connect");
    setError(null);
    try {
      const kit = await loadKit();
      const { address } = await kit.authModal();
      setDone(null);
      setAddress(address);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (!/closed the modal/i.test(msg)) setError(msg || "Wallet connection cancelled.");  // closing the picker is not an error
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    try { (await loadKit()).disconnect(); } catch { /* not connected */ }
    setAddress(null); setAccount(null); setBalances(null); setLabels([]); setDone(null);
  }

  async function fund() {
    if (!address) return;
    setBusy("fund");
    try {
      const res = await fetch(`https://friendbot.stellar.org?addr=${address}`);
      if (!res.ok) throw new Error("Friendbot refused; the account may already exist.");
      await refresh(address);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /** One transaction, signed by the beneficiary's own wallet: trustline if needed, then every claim. */
  async function claim() {
    if (!address || !summary || !account || !balances?.length) return;
    setBusy("claim");
    setError(null);
    try {
      const { Account, Asset, BASE_FEE, Operation, TransactionBuilder } = await import("@stellar/stellar-sdk");
      const asset = new Asset(summary.asset, summary.asset_issuer);
      const builder = new TransactionBuilder(new Account(address, account.sequence), { fee: BASE_FEE, networkPassphrase: TESTNET });
      if (!account.hasTrustline) builder.addOperation(Operation.changeTrust({ asset }));
      for (const b of balances) builder.addOperation(Operation.claimClaimableBalance({ balanceId: b.id }));
      const tx = builder.setTimeout(120).build();

      const kit = await loadKit();
      const { signedTxXdr } = await kit.signTransaction(tx.toXDR(), { address, networkPassphrase: TESTNET });

      const res = await fetch(`${summary.horizon_url}/transactions`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `tx=${encodeURIComponent(signedTxXdr)}`,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`Stellar rejected it: ${JSON.stringify(body.extras?.result_codes ?? body.detail ?? body.title)}`);

      setDone({ hash: body.hash, amount: balances.reduce((n, b) => n + Number(b.amount), 0) });
      await post<ClaimResult[]>("/payouts/claims").catch(() => null); // let the NGO's records catch up
      await refresh(address);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const labelFor = (b: ChainBalance) =>
    labels.find((l) => l.balance_id === b.id) ?? labels.find((l) => !l.balance_id && Number(l.amount) === Number(b.amount));
  const total = balances?.reduce((n, b) => n + Number(b.amount), 0) ?? 0;

  return (
    <>
      <section className="mb-10">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-zinc-500">
          <span className="rounded-full border border-zinc-200 px-2 py-0.5 font-medium text-zinc-700">For beneficiaries</span>
          {summary && <span>{summary.program} · {summary.network}</span>}
        </div>
        <h1 className="max-w-2xl text-[34px] font-semibold leading-[1.15] tracking-[-0.02em] text-zinc-900 sm:text-[40px]">
          Claim your payout
        </h1>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-zinc-500">
          Connect the Stellar wallet you gave the programme. Anything waiting for you is shown here, and you
          claim it with your own key: nobody else can sign for you, and the programme never sees your key.
        </p>
      </section>
      <ErrorNote error={error} />
      {done && (
        <Notice tone="success">
          Received {formatAmount(done.amount)} {summary?.asset} into your wallet. <TxLink hash={done.hash} label="See the transaction" />
        </Notice>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <Card title="1 · Your wallet" className="lg:col-span-2">
          {!address ? (
            <>
              <Button onClick={connect} disabled={busy === "connect" || !summary} className="h-9 w-full">
                {busy === "connect" ? "Opening wallet…" : "Connect wallet"}
              </Button>
              <p className="mt-3 text-[12px] leading-relaxed text-zinc-500">
                Works with Freighter, Lobstr, xBull, Albedo and other Stellar wallets. On Testnet, set your wallet
                to <b className="font-medium">Test Net</b> first.
              </p>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <a href={`https://stellar.expert/explorer/testnet/account/${address}`} target="_blank" rel="noreferrer"
                  className="link break-all font-mono text-[12px]">{shortKey(address, 8)} ↗</a>
                <Button size="sm" variant="ghost" onClick={disconnect}>Disconnect</Button>
              </div>
              <dl className="mt-4 divide-y divide-zinc-100 border-y border-zinc-100 text-[13px]">
                <div className="flex items-center justify-between py-2">
                  <dt className="text-zinc-500">Account on Stellar</dt>
                  <dd>{account === null ? "…" : account.exists ? "Active" : (
                    <Button size="sm" variant="secondary" onClick={fund} disabled={busy === "fund"}>
                      {busy === "fund" ? "Funding…" : "Activate on Testnet"}
                    </Button>
                  )}</dd>
                </div>
                <div className="flex items-center justify-between py-2">
                  <dt className="text-zinc-500">Accepts {summary?.asset}</dt>
                  <dd className="text-zinc-700">{account === null ? "…" : account.hasTrustline ? "Yes" : "Not yet · added when you claim"}</dd>
                </div>
              </dl>
            </>
          )}
        </Card>

        <Card title="2 · Waiting for you" className="lg:col-span-3" flush
          action={address && <button className="link" onClick={() => refresh(address)} disabled={busy === "read"}>{busy === "read" ? "Reading Stellar…" : "Refresh"}</button>}>
          {!address ? (
            <div className="px-5 py-10 text-center text-[13px] text-zinc-500">Connect a wallet to see payouts waiting for it.</div>
          ) : balances === null ? (
            <div className="px-5 py-10 text-center text-[13px] text-zinc-500">Reading Stellar…</div>
          ) : balances.length === 0 ? (
            <div className="px-5 py-10 text-center text-[13px] text-zinc-500">
              Nothing waiting for this wallet{done ? ": you have claimed it all." : "."}
            </div>
          ) : (
            <>
              <table className="data-table">
                <thead><tr><th>Payment</th><th>Batch</th><th>Sent</th><th className="text-right">Amount</th></tr></thead>
                <tbody>
                  {balances.map((b) => {
                    const l = labelFor(b);
                    return (
                      <tr key={b.id}>
                        <td className="font-mono text-[12px]">{l?.request_ref ?? <span className="text-zinc-400">—</span>}</td>
                        <td className="text-[12px] text-zinc-500">{l?.batch_id ?? "—"}</td>
                        <td className="whitespace-nowrap text-[12px] text-zinc-500">{formatTime(b.last_modified_time)}</td>
                        <td className="text-right font-medium tabular-nums">{formatAmount(b.amount)} <span className="text-[11px] font-normal text-zinc-400">{summary?.asset}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 px-5 py-4">
                <div>
                  <div className="text-[20px] font-semibold tracking-tight tabular-nums">{formatAmount(total)} <span className="text-[12px] font-normal text-zinc-400">{summary?.asset}</span></div>
                  <div className="text-[12px] text-zinc-500">one transaction, signed in your wallet{account && !account.hasTrustline ? " · adds the trustline first" : ""}</div>
                </div>
                <Button className="h-9" onClick={claim} disabled={!!busy || !account?.exists}
                  title={account && !account.exists ? "Activate the account first" : undefined}>
                  {busy === "claim" ? "Waiting for your wallet…" : `Claim ${formatAmount(total)} ${summary?.asset ?? ""}`}
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>

      <p className="mt-12 border-t border-zinc-100 pt-6 text-[12px] text-zinc-400">
        Unclaimed payouts stay on Stellar for 30 days, then return to the programme. This page reads the chain
        directly and never holds your key.
      </p>
    </>
  );
}
