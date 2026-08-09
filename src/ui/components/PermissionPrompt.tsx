import { toPermissionView, type PermissionRequestEvent } from "../permission-model";

/**
 * The action preview.
 *
 * Every decision about what this looks like lives in `permission-model`, which is
 * tested without a DOM; this file only renders the result. The split matters here
 * more than elsewhere — the rules about which button gets weight and what counts
 * as irreversible are security-relevant, and they should not be buried in JSX
 * where the only way to check them is to look at pixels.
 *
 * The dialog is modal on purpose. A permission question that can be scrolled past
 * while the action waits is one the user will answer by accident.
 */
export function PermissionPrompt({
  request,
  onDecide,
  disabled,
}: {
  request: PermissionRequestEvent;
  onDecide: (requestId: string, decision: "allow_once" | "allow_always" | "deny") => void;
  /** True while the runtime link is down — the answer could not be delivered. */
  disabled?: boolean;
}) {
  const v = toPermissionView(request);

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/60 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="perm-title"
        aria-describedby="perm-detail"
        className="no-drag mx-4 w-full max-w-sm rounded-2xl border bg-[#070b13] p-4 shadow-2xl"
        style={{ borderColor: `${v.accent}55` }}
      >
        <div className="flex items-center gap-2">
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{ background: `${v.accent}22`, color: v.accent }}
          >
            {v.levelLabel}
          </span>
          <span className="text-[10px] text-slate-500">Jarvis wants to</span>
        </div>

        <h2 id="perm-title" className="mt-2 break-words text-sm font-medium text-slate-100">
          {v.title}
        </h2>
        {v.detail && (
          <p id="perm-detail" className="mt-1 break-words text-xs leading-relaxed text-slate-400">
            {v.detail}
          </p>
        )}

        {v.paths.length > 0 && (
          <ul className="mt-3 space-y-1 rounded-lg bg-black/40 p-2 font-mono text-[10px] text-slate-400">
            {v.paths.map((p) => (
              <li key={p} className="truncate" title={p}>
                {p}
              </li>
            ))}
            {v.moreCount > 0 && (
              <li className="text-slate-500">
                and {v.moreCount} more{v.moreCount === 1 ? " path" : " paths"}
              </li>
            )}
          </ul>
        )}

        {v.warning && (
          <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300">
            {v.warning}
          </p>
        )}

        {disabled && (
          <p className="mt-3 text-[11px] text-red-300">
            Not connected to the runtime — this answer cannot be delivered.
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {v.buttons.map((b) => (
            <button
              key={b.decision}
              disabled={disabled}
              onClick={() => onDecide(v.requestId, b.decision)}
              className={`rounded-full px-3 py-1.5 text-xs transition disabled:opacity-40 ${
                b.emphasis === "primary"
                  ? "font-medium text-slate-950"
                  : b.emphasis === "quiet"
                    ? "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                    : "border border-slate-600/60 text-slate-300 hover:bg-white/5"
              }`}
              style={
                b.emphasis === "primary"
                  ? { background: b.decision === "deny" ? "#e2e8f0" : v.accent }
                  : undefined
              }
            >
              {b.label}
            </button>
          ))}
        </div>

        <p className="mt-3 text-[10px] text-slate-600">
          {/* Stating the default is part of the consent: walking away is a
              refusal, and the user should know that without discovering it. */}
          No answer means no. This request is refused if left unanswered.
        </p>
      </div>
    </div>
  );
}
