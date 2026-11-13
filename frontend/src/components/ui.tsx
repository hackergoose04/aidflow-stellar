"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { explorerTx, type ReconCategory, type Status } from "@/lib/api";
import { CLAIM_STYLE, describeFlag, RECON_STYLE, REGISTRY_STYLE, STATUS_STYLE } from "@/lib/format";

/* ---------- badges: white pill, coloured dot, neutral text ---------- */

export function Badge({ label, dot, title }: { label: string; dot?: string; title?: string }) {
  return (
    <span title={title}
      className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-1.5 text-[12px] font-medium text-zinc-700">
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dot }} />}
      {label}
    </span>
  );
}

const Dash = () => <span className="text-[12px] text-zinc-300">—</span>;

export function StatusBadge({ status }: { status: Status }) {
  const s = STATUS_STYLE[status];
  return <Badge label={s.label} dot={s.dot} />;
}

export function ClaimBadge({ method, status }: { method: string | null; status: string | null }) {
  if (method === "payment") return <span className="text-[12px] text-zinc-500" title="Direct payment: in the wallet on arrival">Payment · in wallet</span>;
  if (!status) return <Dash />;
  const s = CLAIM_STYLE[status];
  return <Badge label={s?.label ?? status} dot={s?.dot} title={s?.why} />;
}

export function RegistryBadge({ status }: { status: string | null }) {
  if (!status) return <Dash />;
  const s = REGISTRY_STYLE[status];
  return <Badge label={s?.label ?? status} dot={s?.dot} title={s?.why} />;
}

export function ReconBadge({ category }: { category: ReconCategory | null }) {
  if (!category) return <span className="text-[12px] text-zinc-400">Not checked</span>;
  const s = RECON_STYLE[category];
  return <Badge label={s.label} dot={s.color} title={s.why} />;
}

/* ---------- layout ---------- */

export function Card({ title, action, children, className = "", flush = false }: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Content runs edge to edge (tables). */
  flush?: boolean;
}) {
  return (
    <section className={`min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] ${className}`}>
      {(title || action) && (
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-zinc-100 px-5 py-2.5">
          {title && <h2 className="text-[13px] font-semibold text-zinc-900">{title}</h2>}
          {action && <div className="text-[12px] text-zinc-500">{action}</div>}
        </div>
      )}
      <div className={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, action, eyebrow }: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  eyebrow?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-[13px] text-zinc-500">{eyebrow}</div>}
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-zinc-900">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-zinc-500">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

/** A row of key numbers in one bordered strip, split by hairlines. */
export function Stats({ items }: {
  items: { label: string; value: React.ReactNode; hint?: React.ReactNode; href?: string; tone?: string }[];
}) {
  return (
    <div className="mb-6 grid grid-cols-2 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] md:auto-cols-fr md:grid-flow-col md:grid-cols-none">
      {items.map((it, i) => {
        const cls = `block px-5 py-4 border-zinc-100 ${i % 2 ? "border-l" : ""} ${i > 0 ? "md:border-l" : "md:border-l-0"} ${i > 1 ? "border-t md:border-t-0" : ""} ${i === items.length - 1 && i % 2 === 0 ? "col-span-2 md:col-span-1" : ""} ${it.href ? "transition-colors hover:bg-zinc-50" : ""}`;
        const body = (
          <>
            <div className="text-[12px] text-zinc-500">{it.label}</div>
            <div className={`mt-1 text-[22px] font-semibold tracking-tight tabular-nums ${it.tone ?? "text-zinc-900"}`}>{it.value}</div>
            {it.hint && <div className="mt-0.5 text-[12px] text-zinc-400">{it.hint}</div>}
          </>
        );
        return it.href
          ? <Link key={it.label} href={it.href} className={cls}>{body}</Link>
          : <div key={it.label} className={cls}>{body}</div>;
      })}
    </div>
  );
}

export function Button({ variant = "primary", size = "md", className = "", ...props }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; size?: "sm" | "md" }) {
  const styles = {
    primary: "bg-zinc-900 text-white shadow-[0_1px_2px_rgba(0,0,0,0.15)] hover:bg-zinc-800 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none",
    secondary: "border border-zinc-200 bg-white text-zinc-800 shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:bg-zinc-50 disabled:text-zinc-400",
    danger: "border border-zinc-200 bg-white text-rose-600 shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:border-rose-200 hover:bg-rose-50 disabled:text-zinc-400",
    ghost: "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
  }[variant];
  const sizes = { sm: "h-7 px-2.5 text-[12px]", md: "h-8 px-3 text-[13px]" }[size];
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:cursor-not-allowed ${sizes} ${styles} ${className}`}
      {...props}
    />
  );
}

/* ---------- flags & risk ---------- */

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

function Source({ ml }: { ml: boolean }) {
  return ml
    ? <span className="rounded-[3px] bg-zinc-900 px-1 text-[10px] font-semibold leading-[14px] text-white">AI</span>
    : <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />;
}

export function FlagChips({ flags, verbose = false }: { flags: string[]; verbose?: boolean }) {
  if (!flags.length) return <span className="text-[12px] text-zinc-400">No flags</span>;
  const groups = groupFlags(flags);
  if (verbose) {
    return (
      <ul className="divide-y divide-zinc-100">
        {groups.map((f) => {
          const info = describeFlag(f);
          return (
            <li key={f} className="flex gap-3 py-2.5 first:pt-0 last:pb-0">
              <span className="mt-1 flex h-3.5 w-5 shrink-0 items-center justify-center"><Source ml={info.source === "ml"} /></span>
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-zinc-900">{info.label}</div>
                <div className="break-words text-[12px] text-zinc-500">{info.detail}</div>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {groups.map((f) => {
        const info = describeFlag(f);
        return (
          <span key={f} title={info.detail}
            className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-md bg-zinc-100 px-1.5 text-[12px] text-zinc-700">
            <Source ml={info.source === "ml"} />
            {info.label}
          </span>
        );
      })}
    </div>
  );
}

export function RiskBar({ score, threshold = 0.9 }: { score: number | null; threshold?: number }) {
  if (score === null) return <Dash />;
  const high = score >= threshold;
  return (
    <div className="flex items-center gap-2 whitespace-nowrap" title={`Risk ${score.toFixed(3)}`}>
      <div className="h-1 w-14 overflow-hidden rounded-full bg-zinc-100">
        <div className={`h-full rounded-full ${high ? "bg-rose-500" : score >= 0.7 ? "bg-amber-400" : "bg-zinc-300"}`}
          style={{ width: `${Math.max(4, score * 100)}%` }} />
      </div>
      {/* Truncate, don't round: 0.886 shows as 0.88 so it never looks above a 0.89 threshold. */}
      <span className={`w-8 font-mono text-[12px] tabular-nums ${high ? "font-medium text-rose-600" : "text-zinc-500"}`}>
        {(Math.floor(score * 100) / 100).toFixed(2)}
      </span>
    </div>
  );
}

/* ---------- messages ---------- */

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mb-4 flex gap-2 rounded-md border border-rose-200 bg-rose-50/60 px-3 py-2 text-[13px] text-rose-800">
      <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" />
      {error}
    </div>
  );
}

export function Notice({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "success" | "warning" }) {
  const dot = { neutral: "bg-accent", success: "bg-emerald-500", warning: "bg-amber-500" }[tone];
  return (
    <div className="mb-4 flex gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-[13px] text-zinc-700 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <div>{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-10 text-center text-[13px] text-zinc-500">{children}</div>;
}

export function TxLink({ hash, label }: { hash: string | null; label?: string }) {
  if (!hash) return <Dash />;
  return (
    <a href={explorerTx(hash)} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-0.5 break-all font-mono text-[12px] text-accent underline-offset-2 hover:underline">
      {label ?? `${hash.slice(0, 8)}…`}<span aria-hidden className="text-zinc-400">↗</span>
    </a>
  );
}

/* ---------- reviewer name (shared by sidebar and pages, kept in this browser) ---------- */

const KEY = "aidflow.reviewer";
const EVENT = "aidflow:reviewer";

export function useReviewer(): [string, (v: string) => void] {
  const [name, setName] = useState("");
  useEffect(() => {
    try {
      setName(localStorage.getItem(KEY) ?? "");
    } catch {
      /* storage unavailable */
    }
    const sync = (e: Event) => setName((e as CustomEvent<string>).detail);
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const update = (v: string) => {
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* storage unavailable */
    }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: v }));
  };
  return [name, update];
}

/** Inline reviewer field. The top bar always has one, so `compact` hides this copy. */
export function ReviewerInput({ value, onChange, compact = false }: { value: string; onChange: (v: string) => void; compact?: boolean }) {
  return (
    <label className={`flex items-center gap-2 text-[13px] text-zinc-500 ${compact ? "hidden" : ""}`}>
      Reviewing as
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Your name" className="input w-36" />
    </label>
  );
}

/* ---------- select: a styled replacement for the native <select> menu ---------- */

export interface SelectOption { value: string; label: string; dot?: string; hint?: string }

export function Select({ value, onChange, options, label, disabled = false, className = "" }: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  /** accessible name */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function openMenu() {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }
  function pick(i: number) {
    onChange(options[i].value);
    setOpen(false);
  }
  function onKey(e: React.KeyboardEvent) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); openMenu(); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(active); }
    else if (e.key === "Tab") setOpen(false);
  }

  return (
    <div ref={root} className={`relative ${className}`}>
      <button type="button" disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())} onKeyDown={onKey}
        className={`input inline-flex w-full items-center gap-2 pr-2 text-left disabled:cursor-not-allowed disabled:opacity-60 ${open ? "border-zinc-400 ring-2 ring-zinc-900/5" : ""}`}>
        {current?.dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: current.dot }} />}
        <span className="flex-1 truncate">{current?.label}</span>
        {current?.hint && <span className="text-[12px] tabular-nums text-zinc-400">{current.hint}</span>}
        <svg viewBox="0 0 16 16" aria-hidden className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && (
        <ul ref={list} role="listbox" aria-label={label}
          className="absolute left-0 z-30 mt-1 max-h-72 min-w-full overflow-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
          {options.map((o, i) => {
            const selected = o.value === value;
            return (
              <li key={o.value || "__all"} role="option" aria-selected={selected}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(i); }}
                className={`flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-[13px] ${
                  i === active ? "bg-zinc-100 text-zinc-900" : "text-zinc-700"}`}>
                <span className="w-3.5 shrink-0">
                  {selected && <svg viewBox="0 0 16 16" aria-hidden className="h-3.5 w-3.5 text-zinc-900" fill="none" stroke="currentColor"
                    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m3.5 8.5 3 3 6-7" /></svg>}
                </span>
                {o.dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: o.dot }} />}
                <span className={`flex-1 ${selected ? "font-medium" : ""}`}>{o.label}</span>
                {o.hint && <span className="pl-4 text-[12px] tabular-nums text-zinc-400">{o.hint}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
