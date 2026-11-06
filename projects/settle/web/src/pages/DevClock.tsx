import { useState } from "react";
import { api } from "../session";
import { day } from "../model";

/** The local network's clock. Dispute windows and reclaim deadlines run on it, so skipping ahead shows what time does. */
export function DevClock({ now, onMoved }: { now: number; onMoved?: (now: number) => void }) {
  const [busy, setBusy] = useState(false);
  const skip = async (days: number) => {
    setBusy(true);
    try {
      // Not `onMoved?.(await …)`: an optional call skips evaluating its arguments when there's no callback.
      const now = await api.advance(days * 86400);
      onMoved?.(now);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="devclock">
      <span className="devclock-label">Network date</span>
      <span className="devclock-date">{now ? day(now) : "…"}</span>
      <span className="devclock-skip">
        Skip ahead
        {[1, 7, 31].map((d) => (
          <button key={d} type="button" className="linkish small" disabled={busy} onClick={() => skip(d)}>
            {d === 1 ? "1 day" : `${d} days`}
          </button>
        ))}
      </span>
    </div>
  );
}
