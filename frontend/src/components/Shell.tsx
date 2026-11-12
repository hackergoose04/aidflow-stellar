"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useReviewer } from "@/components/ui";

type IconName = "home" | "inbox" | "list" | "send" | "scale" | "globe" | "wallet";

const ICON_PATHS: Record<IconName, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  list: "M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01",
  send: "M22 2 11 13 M22 2l-7 20-4-9-9-4z",
  scale: "M16 3h5v5 M8 21H3v-5 M21 3l-7 7 M3 21l7-7",
  globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M2 12h20 M12 2a15 15 0 0 1 0 20 M12 2a15 15 0 0 0 0 20",
  wallet: "M20 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z M16 3H6a2 2 0 0 0-2 2v2 M16 14h.01",
};

function Icon({ name, className = "h-4 w-4" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round"
      strokeLinejoin="round" className={className} aria-hidden>
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

const OPS: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Overview", icon: "home" },
  { href: "/review", label: "Review", icon: "inbox" },
  { href: "/requests", label: "Requests", icon: "list" },
  { href: "/payouts", label: "Payouts", icon: "send" },
  { href: "/recon", label: "Reconciliation", icon: "scale" },
];

function Logo() {
  return (
    <span className="grid h-7 w-7 place-items-center rounded-md bg-zinc-900">
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="white" strokeWidth={1.8} strokeLinecap="round">
        <path d="M2 11c3 0 3-6 6-6s3 6 6 6" />
      </svg>
    </span>
  );
}

function NavLink({ href, label, icon, active }: { href: string; label: string; icon: IconName; active: boolean }) {
  return (
    <Link href={href}
      className={`dock-item flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-[color,background-color,transform] duration-200 ${
        active ? "bg-white font-medium text-zinc-900 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)]"
          : "text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900"}`}>
      <Icon name={icon} className={`h-4 w-4 ${active ? "text-zinc-900" : "text-zinc-400"}`} />
      {label}
    </Link>
  );
}

function ReviewerField() {
  const [name, setName] = useReviewer();
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-zinc-500">Reviewing as</span>
      <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-2 py-1">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-zinc-200 text-[10px] font-semibold uppercase text-zinc-600">
          {name.trim()[0] ?? "?"}
        </span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-900 placeholder:text-zinc-400 focus:outline-none" />
      </div>
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
            <span className="flex items-center gap-4">
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
    <div className="min-h-screen md:flex">
      <aside className="sticky top-0 z-20 border-b border-zinc-200 bg-zinc-100/80 backdrop-blur md:h-screen md:w-56 md:shrink-0 md:border-r md:border-b-0 md:bg-zinc-100/60">
        <div className="flex h-12 items-center justify-between px-4 md:h-14">
          <Link href="/" className="flex items-center gap-2.5 text-[15px] font-semibold text-zinc-900"><Logo /> AidFlow</Link>
          <span className="md:hidden"><NetworkPill /></span>
        </div>
        <nav className="dock-strip flex gap-1 overflow-x-auto px-3 pb-2 md:flex-col md:gap-0.5 md:overflow-visible md:pb-0">
          {OPS.map((l) => <NavLink key={l.href} {...l} active={isActive(l.href)} />)}
          <div className="hidden px-2 pt-5 pb-1 text-[11px] font-medium text-zinc-400 md:block">Public</div>
          <NavLink href="/donor" label="Donor view" icon="globe" active={false} />
          <NavLink href="/claim" label="Claim payout" icon="wallet" active={false} />
        </nav>
        <div className="absolute inset-x-0 bottom-0 hidden flex-col gap-3 border-t border-zinc-200 p-3 md:flex">
          <ReviewerField />
          <NetworkPill />
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8 md:py-8">{children}</div>
      </main>
    </div>
  );
}
