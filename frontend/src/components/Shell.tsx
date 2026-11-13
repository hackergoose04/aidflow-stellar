"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { get, type Summary } from "@/lib/api";
import { useReviewer } from "@/components/ui";

const OPS: { href: string; label: string }[] = [
  { href: "/", label: "Home" },
  { href: "/review", label: "Review" },
  { href: "/requests", label: "Requests" },
  { href: "/payouts", label: "Payments" },
  { href: "/recon", label: "Reconciliation" },
  { href: "/evaluation", label: "Evaluation" },
];

function Logo() {
  return (
    <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent">
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="white" strokeWidth={1.8} strokeLinecap="round">
        <path d="M2 11c3 0 3-6 6-6s3 6 6 6" />
      </svg>
    </span>
  );
}

function NavLink({ href, label, active, badge }: { href: string; label: string; active: boolean; badge?: number }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[14px] transition-colors ${
        active ? "bg-zinc-100 font-medium text-zinc-900" : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"}`}>
      {label}
      {!!badge && <span className="rounded-full bg-amber-100 px-1.5 text-[11px] font-medium tabular-nums text-amber-800">{badge}</span>}
    </Link>
  );
}

function ReviewerField() {
  const [name, setName] = useReviewer();
  return (
    <label className="flex h-8 items-center gap-2 rounded-full border border-zinc-200 bg-white pr-3 pl-1" title="Your name is recorded on every decision">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-zinc-200 text-[11px] font-semibold uppercase text-zinc-700">
        {name.trim()[0] ?? "?"}
      </span>
      <span className="sr-only">Reviewing as</span>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name"
        className="w-24 bg-transparent text-[13px] text-zinc-900 placeholder:text-zinc-400 focus:outline-none" />
    </label>
  );
}

function NetworkPill() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      Stellar Testnet
    </span>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  // Requests waiting for a person, shown on the Review tab. Refreshed on every navigation.
  const [toReview, setToReview] = useState(0);
  useEffect(() => {
    get<Summary>("/summary").then(
      (s) => setToReview((s.pending_flagged ?? 0) + (s.by_status.HELD ?? 0) + (s.by_status.INVALID ?? 0)),
      () => setToReview(0));
  }, [path]);

  // Donor and claim pages are public: no operator navigation, their own simple header.
  if (path.startsWith("/donor") || path.startsWith("/claim")) {
    return (
      <div className="min-h-screen bg-white">
        <header className="border-b border-zinc-100">
          <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
            <Link href="/" aria-label="AidFlow home"
              className="flex items-center gap-2 rounded-sm text-[14px] font-semibold text-zinc-900 hover:text-zinc-600 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-zinc-900">
              <Logo /> AidFlow
            </Link>
            <span className="flex items-center gap-4 text-[13px]">
              <NetworkPill />
              <Link href={path.startsWith("/claim") ? "/donor" : "/claim"} className="text-zinc-500 hover:text-zinc-900">
                {path.startsWith("/claim") ? "Donor report" : "Claim a payout"}
              </Link>
              <Link href="/" className="text-zinc-500 hover:text-zinc-900">Operator console →</Link>
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">{children}</main>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-zinc-200/80 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-6 px-4 sm:px-6">
          <Link href="/" className="flex h-14 items-center gap-2.5 text-[15px] font-semibold text-zinc-900"><Logo /> AidFlow</Link>
          <nav aria-label="Main" className="-mx-1 order-last flex w-full gap-1 overflow-x-auto px-1 pb-2 md:order-none md:w-auto md:pb-0">
            {OPS.map((l) => <NavLink key={l.href} {...l} active={isActive(l.href)} badge={l.href === "/review" ? toReview : undefined} />)}
          </nav>
          <div className="ml-auto flex h-14 items-center gap-4">
            <Link href="/donor" className="hidden text-[13px] text-zinc-500 hover:text-zinc-900 lg:inline">Donor view</Link>
            <Link href="/claim" className="hidden text-[13px] text-zinc-500 hover:text-zinc-900 lg:inline">Claim page</Link>
            <span className="hidden sm:inline-flex"><NetworkPill /></span>
            <ReviewerField />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1200px] px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
