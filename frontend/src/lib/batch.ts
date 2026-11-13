"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AidRequest } from "@/lib/api";
import type { SelectOption } from "@/components/ui";

/**
 * Which batch the operator is working on, shared by Home, Review and Payouts.
 *
 * By default it follows the newest batch, so each upload starts on a clean page while older
 * batches stay in the database. Picking a batch (or "All batches") sticks across pages until a
 * new file is uploaded, which goes back to following the newest one.
 */
const KEY = "aidflow.batch";
const LATEST = "__latest";
const EVENT = "aidflow-batch";

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? LATEST;
  } catch {
    return LATEST;
  }
}

function write(v: string) {
  try {
    if (v === LATEST) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch { /* storage blocked: the choice just won't persist */ }
  window.dispatchEvent(new Event(EVENT));
}

/** Call after an upload so every page jumps to the batch that was just added. */
export const followLatestBatch = () => write(LATEST);

/** Batches newest first; "newest" is the one whose latest request was created most recently. */
export function batchesNewestFirst(rows: AidRequest[]): string[] {
  const latest = new Map<string, string>();
  for (const r of rows) {
    const b = r.batch_id;  // requests without a batch only show under "All batches"
    if (b && (latest.get(b) ?? "") < r.created_at) latest.set(b, r.created_at);
  }
  return [...latest.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([b]) => b);
}

export function useBatch(rows: AidRequest[] | null) {
  const [stored, setStored] = useState(LATEST);
  useEffect(() => {
    const sync = () => setStored(read());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const batches = useMemo(() => batchesNewestFirst(rows ?? []), [rows]);
  // A stored batch that no longer exists (e.g. after a reset) falls back to the newest.
  const batch = stored === LATEST || (stored && !batches.includes(stored)) ? (batches[0] ?? "") : stored;
  const setBatch = useCallback((v: string) => write(v), []);
  const inBatch = useCallback((r: AidRequest) => !batch || (r.batch_id ?? "") === batch, [batch]);

  /** Options for <Select>; `count` gives the number shown next to each batch. */
  const options = useCallback((count: (b: string) => number): SelectOption[] => [
    ...batches.map((b, i) => ({ value: b, label: b, hint: i === 0 ? `newest · ${count(b)}` : String(count(b)) })),
    { value: "", label: "All batches", hint: String(count("")) },
  ], [batches]);

  return { batch, setBatch, inBatch, batches, options };
}
