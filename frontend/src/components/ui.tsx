"use client";

import { useEffect, useState } from "react";
import type { ReconCategory, Status } from "@/lib/api";
import { CLAIM_STYLE, describeFlag, RECON_STYLE, REGISTRY_STYLE, STATUS_STYLE } from "@/lib/format";

export function ClaimBadge({ method, status }: { method: string | null; status: string | null }) {
  if (method === "payment") return <span className="text-xs text-stone-500" title="Direct payment: in the wallet on arrival">In wallet</span>;
  if (!status) return <span className="text-xs text-stone-400">—</span>;
  const s = CLAIM_STYLE[status];
  return (
    <span title={s?.why} className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s?.className ?? ""}`}>
      {s?.label ?? status}
    </span>
  );
}

export function RegistryBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-xs text-stone-400">—</span>;
  const s = REGISTRY_STYLE[status];
  return (
    <span title={s?.why} className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s?.className ?? ""}`}>
      {s?.label ?? status}
    </span>
  );
}

export function ReconBadge({ category }: { category: ReconCategory | null }) {
  if (!category) return <span className="text-xs text-stone-400">Not reconciled</span>;
  const s = RECON_STYLE[category];
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s.className}`}>
      {s.label}
    </span>
  );
}

export function Card({ title, action, children, className = "" }: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`min-w-0 rounded-xl border border-stone-200 bg-white p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold text-stone-900">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, action }: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-stone-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Button({ variant = "primary", className = "", ...props }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  const styles = {
    primary: "bg-teal-700 text-white hover:bg-teal-800 disabled:bg-stone-300",
    secondary: "bg-white text-stone-800 ring-1 ring-stone-300 hover:bg-stone-50 disabled:text-stone-400",
    danger: "bg-white text-rose-700 ring-1 ring-rose-300 hover:bg-rose-50 disabled:text-stone-400",
    ghost: "text-stone-600 hover:bg-stone-100",
  }[variant];
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    />
  );
}

export function StatusBadge({ status }: { status: Status }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s.className}`}>
      {s.label}
    </span>
  );
}

/** Same-kind flags (e.g. three "same_batch_as:…") are merged into one chip listing every value. */
function groupFlags(flags: string[]): string[] {
  const order: string[] = [];
  const values: Record<string, string[]> = {};
  for (const f of flags) {
    const i = f.indexOf(":");
    const key = i < 0 ? f : f.slice(0, i);
    if (!(key in values)) { order.push(key); values[key] = []; }
    if (i >= 0) values[key].push(f.slice(i + 1));
  }
  return order.map((k) => (values[k].length ? `${k}:${values[k].join(", ")}` : k));
}

export function FlagChips({ flags, verbose = false }: { flags: string[]; verbose?: boolean }) {
  if (!flags.length) return <span className="text-xs text-stone-400">No flags</span>;
  return (
    <div className={verbose ? "flex flex-col gap-2" : "flex flex-wrap gap-1"}>
      {groupFlags(flags).map((f) => {
        const info = describeFlag(f);
        const tone = info.source === "ml"
          ? "bg-violet-50 text-violet-800 ring-violet-200"
          : "bg-amber-50 text-amber-900 ring-amber-200";
        return verbose ? (
          <div key={f} className={`rounded-lg px-3 py-2 ring-1 ring-inset ${tone}`}>
            <div className="text-sm font-medium">
              {info.label}
              <span className="ml-2 text-xs font-normal opacity-70">{info.source === "ml" ? "AI model" : "Rule"}</span>
            </div>
            <div className="text-xs opacity-80">{info.detail}</div>
          </div>
        ) : (
          <span key={f} title={info.detail}
            className={`rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}>
            {info.label}
          </span>
        );
      })}
    </div>
  );
}

export function RiskBar({ score, threshold = 0.9 }: { score: number | null; threshold?: number }) {
  if (score === null) return <span className="text-xs text-stone-400">—</span>;
  const color = score >= threshold ? "bg-violet-600" : score >= 0.7 ? "bg-violet-300" : "bg-stone-300";
  return (
    <div className="flex items-center gap-2 whitespace-nowrap" title={`Risk ${score.toFixed(3)}`}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-stone-100">
        <div className={`h-full ${color}`} style={{ width: `${Math.max(4, score * 100)}%` }} />
      </div>
      {/* Truncate, don't round: 0.886 shows as 0.88 so it never looks above a 0.89 threshold. */}
      <span className="w-8 text-xs tabular-nums text-stone-600">{(Math.floor(score * 100) / 100).toFixed(2)}</span>
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
      {error}
    </div>
  );
}

export function TxLink({ hash, label }: { hash: string | null; label?: string }) {
  if (!hash) return <span className="text-stone-400">—</span>;
  return (
    <a href={`https://stellar.expert/explorer/testnet/tx/${hash}`} target="_blank" rel="noreferrer"
      className="font-mono text-xs text-teal-700 underline-offset-2 hover:underline">
      {label ?? `${hash.slice(0, 8)}…`} ↗
    </a>
  );
}

/** Reviewer name, remembered in this browser only. */
export function useReviewer(): [string, (v: string) => void] {
  const [name, setName] = useState("");
  useEffect(() => {
    try {
      setName(localStorage.getItem("aidflow.reviewer") ?? "");
    } catch {
      /* storage unavailable */
    }
  }, []);
  const update = (v: string) => {
    setName(v);
    try {
      localStorage.setItem("aidflow.reviewer", v);
    } catch {
      /* storage unavailable */
    }
  };
  return [name, update];
}

export function ReviewerInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-stone-600">
      Reviewer
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="your name"
        className="w-36 rounded-lg border border-stone-300 px-2 py-1 text-sm text-stone-900 focus:border-teal-600 focus:outline-none" />
    </label>
  );
}
