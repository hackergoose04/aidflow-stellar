"use client";

import { useRef, useState } from "react";
import { get, post, type PolicyPreview, type ScreeningPolicy } from "@/lib/api";
import { Button, ErrorNote, Notice, ReviewerInput } from "@/components/ui";

export function ScreeningSettings({ asset, reviewer, onReviewerChange, editable, onSave }: {
  asset: string; reviewer: string; onReviewerChange: (name: string) => void; editable: boolean; onSave: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [policy, setPolicy] = useState<ScreeningPolicy | null>(null);
  const [preview, setPreview] = useState<PolicyPreview | null>(null);
  const [applyPending, setApplyPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const window = policy?.payment_window;

  async function open() {
    if (busy) return;
    setError(null);
    setSaved(null);
    setPreview(null);
    setApplyPending(false);
    setPolicy(null);
    dialog.current?.showModal();
    try {
      const current = await get<ScreeningPolicy>("/screening-policy");
      setPolicy(current);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function change(next: Partial<ScreeningPolicy>) {
    if (policy) setPolicy({ ...policy, ...next });
    setPreview(null);
    setSaved(null);
    setError(null);
  }

  async function submit(save: boolean) {
    if (!policy || (save && (!editable || !reviewer.trim()))) return;
    setBusy(true);
    setError(null);
    try {
      if (save) {
        const result = await post<{ pending: PolicyPreview | null }>("/screening-policy", { policy, reviewer, apply_pending: applyPending });
        setSaved(result.pending ? `Settings saved. ${result.pending.flagged.toLocaleString()} pending requests have flags.` : "Settings saved for future uploads.");
        setPreview(null);
        onSave();
      } else {
        setPreview(await post<PolicyPreview>("/screening-policy/preview", policy));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button className="h-11" variant="secondary" onClick={open} disabled={busy}>Screening settings</Button>
      <dialog ref={dialog} aria-labelledby="screening-title"
        className="m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-zinc-200 bg-white p-6 text-zinc-900 shadow-xl backdrop:bg-zinc-950/35">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id="screening-title" className="text-lg font-semibold">Screening settings</h2>
            <p className="mt-1 text-[13px] text-zinc-500">Set the amount and local-time rules for this program. Requests outside either range go to Review.</p>
          </div>
          <Button variant="ghost" onClick={() => dialog.current?.close()}>Close</Button>
        </div>
        <ErrorNote error={error} />
        {saved && <Notice tone="success">{saved}</Notice>}
        {policy ? (
          <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit(true); }}>
            <fieldset disabled={busy} className="space-y-3">
              <legend className="mb-2 text-[13px] font-semibold">Amount range ({asset})</legend>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1 text-[12px]">Minimum
                  <input className="input w-full" type="number" min="0" step="0.0000001" placeholder="No minimum"
                    value={policy.min_amount ?? ""} onChange={(e) => change({ min_amount: e.target.value || null })} />
                </label>
                <label className="grid gap-1 text-[12px]">Maximum
                  <input className="input w-full" type="number" min="0.0000001" step="0.0000001" placeholder="No maximum"
                    value={policy.max_amount ?? ""} onChange={(e) => change({ max_amount: e.target.value || null })} />
                </label>
              </div>
            </fieldset>
            <fieldset disabled={busy} className="space-y-3 border-t border-zinc-100 pt-3">
              <label className="flex items-center gap-2 text-[13px] font-semibold">
                <input type="checkbox" checked={!!window} onChange={(e) => change({ payment_window: e.target.checked
                  ? { start: "09:00", end: "17:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", weekdays_only: false } : null })} />
                Limit payment time
              </label>
              {window && <>
                <p className="text-[12px] text-zinc-500">Checks the timestamp in the uploaded request.</p>
                <div className="grid grid-cols-2 gap-3">
                  <label className="grid gap-1 text-[12px]">Start
                    <input className="input w-full" type="time" required value={window.start.slice(0, 5)} onChange={(e) => change({ payment_window: { ...window, start: e.target.value } })} />
                  </label>
                  <label className="grid gap-1 text-[12px]">End
                    <input className="input w-full" type="time" required value={window.end.slice(0, 5)} onChange={(e) => change({ payment_window: { ...window, end: e.target.value } })} />
                  </label>
                </div>
                <label className="grid gap-1 text-[12px]">Time zone
                  <input className="input w-full" required placeholder="America/Toronto" value={window.timezone}
                    onChange={(e) => change({ payment_window: { ...window, timezone: e.target.value } })} />
                </label>
                <label className="flex items-center gap-2 text-[12px]">
                  <input type="checkbox" checked={window.weekdays_only} onChange={(e) => change({ payment_window: { ...window, weekdays_only: e.target.checked } })} />
                  Weekdays only (Monday to Friday)
                </label>
              </>}
            </fieldset>
            <div className="space-y-3 border-t border-zinc-100 pt-3">
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" disabled={busy || !editable} checked={applyPending} onChange={(e) => setApplyPending(e.target.checked)} />
                Also apply to pending requests
              </label>
              <p className="text-[12px] text-zinc-500">Settings apply to future uploads. Check this box to update the rules on requests that are still pending.</p>
              {preview && <p className="rounded-md bg-zinc-50 px-3 py-2 text-[13px] tabular-nums">
                {preview.flagged.toLocaleString()} of {preview.pending.toLocaleString()} would have flags. {preview.newly_flagged.toLocaleString()} newly flagged, {preview.cleared.toLocaleString()} cleared. Amount rule: {preview.amount_flags.toLocaleString()}. Time rule: {preview.time_flags.toLocaleString()}.
              </p>}
              {editable ? (
                <div className="space-y-1">
                  <ReviewerInput value={reviewer} onChange={onReviewerChange} />
                  <p className="text-[12px] text-zinc-500">Your name is required for the audit log.</p>
                </div>
              ) : <p className="text-[12px] text-zinc-500">Settings are read-only on this instance.</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" disabled={busy}
                  onClick={(event) => { if (event.currentTarget.form?.reportValidity()) void submit(false); }}>Preview impact</Button>
                <Button type="submit" disabled={busy || !editable || !reviewer.trim()}>Save settings</Button>
              </div>
            </div>
          </form>
        ) : !error && <p className="text-[13px] text-zinc-500">Loading settings…</p>}
      </dialog>
    </>
  );
}
