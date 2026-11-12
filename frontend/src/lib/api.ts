export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";
export const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL ?? "https://horizon-testnet.stellar.org";

/** Does this address exist on Stellar? Accounts that were never funded don't (stellar.expert can't show them). */
export async function accountState(address: string): Promise<"exists" | "missing" | "invalid" | null> {
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${address}`);
    if (res.ok) return "exists";
    if (res.status === 404) return "missing";
    if (res.status === 400) return "invalid";
    return null;
  } catch {
    return null; // offline: just show the link
  }
}

export type Status =
  | "INVALID"
  | "PENDING_REVIEW"
  | "HELD"
  | "APPROVED"
  | "REJECTED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "CLAIMED"
  | "FAILED"
  | "UNKNOWN";

export const STATUSES: Status[] = [
  "INVALID", "PENDING_REVIEW", "HELD", "APPROVED", "REJECTED", "SUBMITTED", "CONFIRMED", "CLAIMED", "FAILED", "UNKNOWN",
];

export type ClaimStatus = "UNCLAIMED" | "CLAIMED" | "RECLAIMED";

export type ReconCategory = "MATCHED" | "PENDING_VERIFICATION" | "MISMATCH" | "NOT_EXECUTED";
export const RECON_CATEGORIES: ReconCategory[] = ["MATCHED", "PENDING_VERIFICATION", "MISMATCH", "NOT_EXECUTED"];

export interface AidEvent {
  kind: string;
  detail: string | null;
  at: string;
}

export interface AidRequest {
  request_ref: string;
  batch_id: string | null;
  payout_slot: string;
  beneficiary_id: string;
  wallet: string;
  amount: string;
  asset: string;
  created_at: string;
  status: Status;
  flags: string[];
  risk_score: number | null;
  method: "payment" | "claimable_balance" | null;
  tx_hash: string | null;
  submitted_at: string | null;
  reviewer: string | null;
  note: string | null;
  error: string | null;
  recon_status: ReconCategory | null;
  recon_reasons: string[] | null;
  recon_at: string | null;
  registry_key: string | null;
  registry_status: "RESERVED" | "PAID" | "RELEASED" | "BLOCKED" | null;
  balance_id: string | null;
  claim_status: ClaimStatus | null;
  claimed_at: string | null;
  updated_at: string;
  events?: AidEvent[];
}

export interface BatchSummary {
  batch_id: string | null;
  requests: number;
  confirmed: number;
  flagged: number;
  amount: number;
}

export interface DurationStats { n: number; median_s: number | null; max_s: number | null }

export interface Unclaimed {
  request_ref: string;
  batch_id: string | null;
  amount: string;
  asset: string;
  sent_at: string;
  waiting_hours: number;
  overdue: boolean;
  reclaim_from: string;
}

export interface Delivery {
  timing: {
    approved_to_chain: DurationStats;
    approved_to_hand: DurationStats;
    submitted_to_chain: DurationStats;
    not_in_hand_yet: number;
    /** median seconds per leg of the journey */
    legs?: { approve_to_send: number | null; send_to_chain: number | null; chain_to_hand: number | null };
  };
  unclaimed: Unclaimed[];
  /** where every paid-out amount is now */
  arrival?: { in_hand: number; waiting: number; overdue: number; returned: number };
  alert_hours: number;
}

export interface DeliveryCost {
  payouts: number;
  avg_fee_xlm?: number;
  avg_payment_fee_xlm?: number;
  avg_registry_fee_xlm?: number;
  avg_fee_usd?: number;
  cost_share?: number;
  xlm_usd?: number;
  benchmark?: number;
  target?: number;
}

/** A payout waiting for a wallet to claim it (from /public/claimable). */
export interface PublicClaimable {
  request_ref: string;
  batch_id: string | null;
  amount: string;
  asset: string;
  balance_id: string | null;
  paid_at: string | null;
  explorer: string | null;
}

export interface Summary {
  by_status: Record<Status, number>;
  pending_flagged: number;
  recon: Record<ReconCategory, number>;
  last_recon: string | null;
  batches: BatchSummary[];
  risk_histogram: number[];
  registry: {
    enabled: boolean;
    contract: string | null;
    explorer: string | null;
    program: string;
    PAID?: number;
    RESERVED?: number;
    RELEASED?: number;
    BLOCKED?: number;
  };
}

export interface Wallet {
  account: string;
  balances: Record<string, string>;
  explorer: string;
}

export interface UploadReport {
  received: number;
  accepted: number;
  flagged: string[];
  rejected: { line: number; request_ref: string | null; reasons: string[]; stored_as_invalid: boolean }[];
  invalid_stored: number;
}

export interface ClaimResult {
  request_ref: string;
  claim_status: ClaimStatus | null;
  claimed_at?: string | null;
  error?: string;
}

export type PublicStatus = "Received" | "Paid" | "In progress" | "Under review" | "Not paid";

export interface PublicPayment {
  request_ref: string;
  batch_id: string | null;
  amount: string;
  asset: string;
  status: PublicStatus;
  method: "payment" | "claimable_balance" | null;
  claim_status: ClaimStatus | null;
  claimed_at: string | null;
  paid_at: string | null;
  tx_hash: string | null;
  explorer: string | null;
  memo_hash: string;
  registry_status: string | null;
  reconciliation: ReconCategory | null;
}

export interface PublicBatch {
  batch_id: string | null;
  requests: number;
  paid: number;
  received: number;
  in_progress: number;
  amount_paid: number;
  reconciled: number;
  asset: string;
}

export interface PublicSummary {
  program: string;
  network: string;
  asset: string;
  totals: { requests: number; paid: number; received: number; in_progress: number; reconciled: number; amount_paid: number };
  batches: PublicBatch[];
  ngo_account: string;
  ngo_explorer: string;
  asset_issuer: string;
  registry_contract: string | null;
  registry_explorer: string | null;
  horizon_url: string;
}

/** Pay approved requests a few at a time, so the caller can refresh the table and show progress.
 *  Each payout is three Testnet transactions (register, pay, mark paid), roughly 15 s. */
export async function payAll(onChunk: (done: number) => void | Promise<void>, batch = "", chunk = 5): Promise<PayoutResult[]> {
  const all: PayoutResult[] = [];
  const q = batch ? `&batch=${encodeURIComponent(batch)}` : "";
  for (;;) {
    const r = await post<PayoutResult[]>(`/payouts/run?limit=${chunk}${q}`);
    all.push(...r);
    // Stop when nothing is left, or when nothing moved (registry unreachable leaves them APPROVED).
    if (!r.length || r.every((x) => x.status === "APPROVED")) break;
    await onChunk(all.length);
  }
  return all;
}

export interface PayoutResult {
  request_ref: string;
  method?: string;
  status: Status;
  error: string | null;
  tx_hash?: string;
  explorer?: string;
  registry?: string | null;
}

export interface VerifyResult {
  request_ref: string;
  chain: string;
  status: string;
}

export interface ChainOp {
  tx_hash: string;
  type: string;
  to: string;
  amount: string;
  asset: string;
  memo_hex: string | null;
}

export interface ReconResult {
  request_ref: string;
  category: ReconCategory;
  reasons: string[];
  internal: { status: Status; amount: string; wallet: string; asset: string; tx_hash: string | null };
  chain: ChainOp | null;
  chain_count: number;
}

export interface ReconReport {
  ran_at: string;
  chain_ops_checked: number;
  summary: Record<ReconCategory | "UNRECORDED_ON_CHAIN", number>;
  results: ReconResult[];
  unrecorded_on_chain: ChainOp[];
}

export interface ReconEval {
  records: number;
  chain_payouts: number;
  stray_payouts: number;
  category_accuracy: number;
  reason_accuracy: number;
  strays_found: number;
  by_scenario: Record<string, { count: number; correct: number }>;
  note: string;
}

export interface ModelSummary {
  precision: number;
  recall: number;
  flagged: number;
  false_alarms: number;
  false_positive_rate: number;
  review_share: number;
  workload_reduction: number;
  recall_by_type: Record<string, number>;
}

export interface MlMetrics {
  test_rows: number;
  anomalies: number;
  threshold: number;
  roc_auc: number;
  average_precision: number;
  ml: ModelSummary;
  rules: ModelSummary;
  rules_or_ml: ModelSummary;
  manual_all: ModelSummary;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, { cache: "no-store", ...init });
  } catch {
    throw new Error(`Can't reach the backend at ${API_URL}. Is uvicorn running?`);
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* keep statusText */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const get = <T,>(path: string) => request<T>(path);

export const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const uploadCsv = (file: File) => {
  const form = new FormData();
  form.append("file", file);
  return request<UploadReport>("/requests/upload", { method: "POST", body: form });
};

export const explorerTx = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
export const explorerAccount = (id: string) => `https://stellar.expert/explorer/testnet/account/${id}`;
