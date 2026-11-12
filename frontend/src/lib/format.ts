import type { ReconCategory, Status } from "./api";

export const formatAmount = (amount: string | number) =>
  Number(amount).toLocaleString("en-US", { maximumFractionDigits: 7 });

export const formatTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-GB", {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
      })
    : "—";

export const shortKey = (key: string | null, n = 4) =>
  key ? `${key.slice(0, n)}…${key.slice(-n)}` : "—";

export const pct = (x: number) => `${Math.round(x * 100)}%`;

/** 4 s, 1 min 8 s, 3 h 20 min, 2 d 4 h */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  if (s < 86400) return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ""}`;
  return `${Math.floor(s / 86400)} d${Math.floor((s % 86400) / 3600) ? ` ${Math.floor((s % 86400) / 3600)} h` : ""}`;
}

export const formatHours = (h: number) => formatDuration(h * 3600);

export const STATUS_STYLE: Record<Status, { label: string; dot: string }> = {
  INVALID: { label: "Invalid", dot: "#dc2626" },
  PENDING_REVIEW: { label: "Pending review", dot: "#d97706" },
  HELD: { label: "Held", dot: "#71717a" },
  APPROVED: { label: "Approved", dot: "#2b59c3" },
  REJECTED: { label: "Rejected", dot: "#d4d4d8" },
  SUBMITTED: { label: "Submitted", dot: "#7c8cf8" },
  CONFIRMED: { label: "Confirmed", dot: "#16a34a" },
  CLAIMED: { label: "Claimed", dot: "#0d7a5f" },
  FAILED: { label: "Failed", dot: "#e11d48" },
  UNKNOWN: { label: "Unknown", dot: "#ea580c" },
};

export interface FlagInfo {
  label: string;
  detail: string;
  source: "rule" | "ml";
}

/** Turn a backend flag like "shared_wallet_with:BEN-005" into words a reviewer understands. */
export function describeFlag(flag: string): FlagInfo {
  const i = flag.indexOf(":");
  const key = i < 0 ? flag : flag.slice(0, i);
  const value = i < 0 ? undefined : flag.slice(i + 1);
  switch (key) {
    case "amount_above_limit":
      return { label: "Large amount", detail: `Above the ${value} limit`, source: "rule" };
    case "shared_wallet_with":
      return { label: "Shared wallet", detail: `Same wallet as ${value}`, source: "rule" };
    case "possible_duplicate_of":
      return { label: "Possible duplicate", detail: `Same person and amount within 24 h as ${value}`, source: "rule" };
    case "same_batch_as":
      return { label: "Repeat in batch", detail: `Same person already has a request in this batch: ${value}`, source: "rule" };
    case "wallet_changed":
      return { label: "Wallet changed", detail: "Earlier requests used a different wallet", source: "rule" };
    case "invalid":
      return { label: "Invalid record", detail: (value ?? "").replaceAll("_", " "), source: "rule" };
    case "ml_high_risk":
      return { label: "Unusual pattern", detail: `Model risk ${value}: stranger than most requests`, source: "ml" };
    default:
      return { label: key, detail: value ?? "", source: "rule" };
  }
}

export const RECON_STYLE: Record<ReconCategory, { label: string; color: string; why: string }> = {
  MATCHED: { label: "Matched", color: "#16a34a",
    why: "Confirmed on chain once, with the expected amount, wallet and asset." },
  PENDING_VERIFICATION: { label: "Pending verification", color: "#7c8cf8",
    why: "Submitted, but the final on-chain outcome isn't established yet." },
  MISMATCH: { label: "Mismatch", color: "#e11d48",
    why: "Our record and the chain disagree. Needs a person." },
  NOT_EXECUTED: { label: "Not executed", color: "#d4d4d8",
    why: "Invalid, held, rejected, not yet paid, or failed, and nothing was sent." },
};

const REASON_TEXT: Record<string, string> = {
  amount_differs: "Amount on chain differs",
  wallet_differs: "Paid to a different wallet",
  asset_differs: "Paid in a different asset",
  tx_hash_differs: "Chain transaction isn't the one we recorded",
  missing_on_chain: "Marked confirmed, but not found on chain",
  on_chain_but_never_submitted: "Money moved, but the request was never submitted",
  on_chain_but_marked_failed: "Marked failed, but the payment is on chain",
  found_on_chain_run_verify: "Found on chain: run Verify to confirm",
  submitted: "Submitted, awaiting result",
  unknown: "Submit outcome unclear",
  rejected: "Rejected by reviewer",
  held: "Held",
  invalid: "Invalid record",
  pending_review: "Waiting for review",
  approved: "Approved, not paid yet",
  failed: "Failed, nothing sent",
  registry_missing: "No entry in the on-chain registry",
  registry_held_by_other_request: "Registry entry belongs to another request",
  registry_not_marked_paid: "Registry entry not marked paid",
  registry_tx_differs: "Registry records a different transaction",
};

export const describeReason = (r: string) =>
  REASON_TEXT[r] ?? (/^paid_(\d+)_times$/.test(r) ? `Paid ${r.split("_")[1]} times` : r.replaceAll("_", " "));

export const REGISTRY_STYLE: Record<string, { label: string; dot: string; why: string }> = {
  RESERVED: { label: "Reserved", dot: "#7c8cf8",
    why: "Registered on chain before paying; waiting for the payment result." },
  PAID: { label: "Paid on chain", dot: "#16a34a",
    why: "The registry records this payout as made, with its transaction." },
  RELEASED: { label: "Released", dot: "#a1a1aa",
    why: "The payment failed, so the reservation was freed for a retry." },
  BLOCKED: { label: "Blocked on chain", dot: "#e11d48",
    why: "The registry refused: this person already has a payout in this batch." },
};

export const CLAIM_STYLE: Record<string, { label: string; dot: string; why: string }> = {
  UNCLAIMED: { label: "Waiting for claim", dot: "#d97706",
    why: "Sent as a claimable balance; the beneficiary hasn't picked it up yet." },
  CLAIMED: { label: "Received", dot: "#0d7a5f",
    why: "The beneficiary claimed the money into their wallet." },
  RECLAIMED: { label: "Returned to NGO", dot: "#a1a1aa",
    why: "Not claimed in time; the NGO took the money back." },
};
