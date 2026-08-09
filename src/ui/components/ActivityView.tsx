import { toRows, emptyMessage, refusedCount } from "../activity-model";
import type { ActivityEntry } from "../../ipc/contract";

/**
 * The record of what Jarvis decided.
 *
 * This is the only screen where a user can audit an always-on assistant that
 * has been making permission decisions while they were doing something else, so
 * it is a panel over the conversation rather than a tab beside it: it must be
 * reachable in one click and readable without scrolling past chat.
 *
 * All the judgement lives in `activity-model`, which is tested without a DOM —
 * including which rows count as notable and how an absent outcome reads. This
 * file renders that and adds nothing of its own.
 */
export function ActivityView({
  entries,
  connected,
  onClose,
}: {
  entries: readonly ActivityEntry[];
  /** False means this list may be stale; the empty state says so. */
  connected: boolean;
  onClose: () => void;
}) {
  const rows = toRows(entries);
  const refused = refusedCount(entries);

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-[#05070d]/95 backdrop-blur-sm">
      <div className="no-drag flex items-center justify-between border-b border-[#12304a] px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
            Activity
          </span>
          {/* The refusal count leads, because it is the number that tells you
              something was asked for and stopped. Zero is not shown: a "0
              refused" badge reads as a reassurance nobody verified. */}
          {refused > 0 && (
            <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-300">
              {refused} refused
            </span>
          )}
        </div>
        <button
          className="rounded px-2 text-slate-500 hover:bg-white/5 hover:text-slate-200"
          onClick={onClose}
          aria-label="Close activity"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {rows.length === 0 ? (
          <p className="pt-8 text-center text-xs text-slate-600">{emptyMessage(connected)}</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((r) => (
              <li
                key={r.key}
                className={`rounded-lg border-l-2 px-2 py-1.5 ${
                  r.tone === "refused"
                    ? "border-red-400/70 bg-red-500/[0.07]"
                    : r.tone === "serious"
                      ? "border-amber-400/60 bg-amber-500/[0.05]"
                      : "border-slate-700/60"
                }`}
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[10px] text-slate-600">{r.time}</span>
                  <span
                    className={`text-[10px] font-semibold uppercase tracking-wide ${
                      r.tone === "refused" ? "text-red-300" : "text-slate-500"
                    }`}
                  >
                    {r.verdict}
                  </span>
                  <span className="truncate font-mono text-[11px] text-slate-300" title={r.tool}>
                    {r.tool}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-slate-600">L{r.level}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[11px] text-slate-500">{r.reason}</span>
                  {/* Always rendered, never conditional. A column that vanishes
                      when nothing checked the result is a column that reports a
                      clean day for work nobody looked at. */}
                  <span className="text-[10px] italic text-slate-600">{r.outcome}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="border-t border-[#12304a] px-4 py-2 text-[10px] text-slate-600">
        {/* Said plainly, because the alternative is a user reading this list as
            proof that everything above it worked. */}
        Jarvis approves tool calls; Hermes runs them. Entries marked “not checked” were never
        verified from here.
      </p>
    </div>
  );
}
