/**
 * How a permission request is put in front of a person.
 *
 * Separate from React for the same reason `hud-model` is: these are the rules
 * that decide whether a user understands what they are agreeing to, and they
 * should be testable without a DOM.
 *
 * The design problem here is narrower than it looks. The engine has already
 * decided the action is askable — nothing forbidden ever reaches this file. What
 * is left is a presentation question with a security consequence: **a dialog
 * that looks the same for every action trains the user to click Allow.** If
 * "open Notepad" and "delete 200 files in Documents" arrive in the same grey box
 * with the same two buttons, consent stops carrying information, and the whole
 * permission engine upstream is decoration.
 *
 * So three rules shape everything below.
 *
 * **Weight follows the level.** Colour, wording, and which button is the quiet
 * one all move with the risk, so a serious request cannot be dismissed with the
 * same reflex as a trivial one.
 *
 * **Deny is never the hard button.** It is always present, always enabled, and
 * never styled as the discouraged choice. The safe answer must be the easy one.
 *
 * **Every string is untrusted.** Titles and paths originate in a tool call that
 * may have been written by a web page Hermes just read (§52). They are truncated
 * and stripped of anything that could forge UI before they reach the DOM.
 */
import { sanitiseForDisplay } from "../permissions/risk-model";

/** What the runtime sends, as the renderer sees it. */
export interface PermissionRequestEvent {
  requestId: string;
  title: string;
  detail?: string;
  options: string[];
  risk?: { level: number; category: string; paths?: string[]; pathCount?: number };
}

export interface PermissionButton {
  decision: "allow_once" | "allow_always" | "deny";
  label: string;
  /**
   * `primary` gets visual weight, `quiet` gets the least. Deny is never quiet;
   * at higher levels it becomes the primary button instead.
   */
  emphasis: "primary" | "normal" | "quiet";
}

export interface PermissionView {
  requestId: string;
  title: string;
  detail: string;
  /** One word for the risk, for the badge. */
  levelLabel: string;
  /** Colour token for the badge and border. */
  accent: string;
  paths: string[];
  /** Present only when the list was truncated. */
  moreCount: number;
  buttons: PermissionButton[];
  /** Shown when the action cannot be undone, so the stakes are explicit. */
  warning: string | null;
}

const LEVELS: Record<number, { label: string; accent: string }> = {
  0: { label: "Read", accent: "#38bdf8" },
  1: { label: "Minor", accent: "#22d3ee" },
  2: { label: "Change", accent: "#fbbf24" },
  3: { label: "Destructive", accent: "#fb923c" },
  4: { label: "System", accent: "#f87171" },
};

/** Unknown levels are treated as the most serious, not the least. */
const UNKNOWN_LEVEL = { label: "Unknown", accent: "#f87171" };

function known(level: number | undefined): boolean {
  return level !== undefined && Number.isInteger(level) && level in LEVELS;
}

function levelStyle(level: number | undefined): { label: string; accent: string } {
  return known(level) ? LEVELS[level as number]! : UNKNOWN_LEVEL;
}

/**
 * Whether the dialog should carry its full weight.
 *
 * Shares `known` with the badge deliberately. When these two disagreed, a level
 * of `-1` rendered an "Unknown" badge above a cheerful primary Allow — the
 * colour said one thing and the buttons said another, which is worse than either
 * alone. Anything unrecognised is serious, the same way the classifier fails
 * closed on a tool name it does not know.
 */
export function isSerious(level: number | undefined): boolean {
  return !known(level) || (level as number) >= 3;
}

/**
 * Categories where "undo" is not a real offer.
 *
 * Deleting a file goes to the Recycle Bin and is genuinely reversible, which is
 * why `delete` is absent. Sending data out of the machine and running a command
 * are not: once a request leaves, it has left.
 */
const IRREVERSIBLE = new Set(["network", "execute", "credential", "security-control"]);

function warningFor(level: number | undefined, category: string | undefined): string | null {
  if (category && IRREVERSIBLE.has(category)) {
    return category === "network"
      ? "This leaves your machine. It cannot be taken back."
      : "This runs on your machine and cannot be undone.";
  }
  // `isSerious`, not `level >= 3`: an unrecognised level defaulting to 0 would
  // drop the warning on exactly the actions least understood.
  if (isSerious(level)) return "This cannot be undone automatically.";
  return null;
}

/**
 * Order and weight the buttons.
 *
 * Deny goes last at low levels, where it is the unusual answer, and first at
 * level 3+, where it is the one that should be reachable without thinking. The
 * "always" option is only offered when the engine offered it — it decides
 * whether an action is repeatable, not this file.
 */
export function buttonsFor(options: string[], level: number | undefined): PermissionButton[] {
  const serious = isSerious(level);
  const has = (d: string): boolean => options.includes(d);

  const allowOnce: PermissionButton = {
    decision: "allow_once",
    label: serious ? "Allow this once" : "Allow",
    emphasis: serious ? "quiet" : "primary",
  };
  const allowAlways: PermissionButton = {
    decision: "allow_always",
    label: "Always allow",
    emphasis: "quiet",
  };
  const deny: PermissionButton = {
    decision: "deny",
    label: serious ? "Don’t allow" : "Deny",
    emphasis: serious ? "primary" : "normal",
  };

  const out: PermissionButton[] = [];
  if (serious) out.push(deny);
  if (has("allow_once")) out.push(allowOnce);
  if (has("allow_always")) out.push(allowAlways);
  // Deny is present whether or not the runtime listed it. A request with no way
  // to refuse is not a request, and the engine treats an unanswered one as a
  // denial anyway — so the button always matches what silence would do.
  if (!serious) out.push(deny);
  return out;
}

/** Turn the wire event into everything the dialog needs, all of it safe to render. */
export function toPermissionView(e: PermissionRequestEvent): PermissionView {
  const { label, accent } = levelStyle(e.risk?.level);
  const paths = (e.risk?.paths ?? []).map((p) => sanitiseForDisplay(p, 120));
  const total = e.risk?.pathCount ?? paths.length;

  return {
    requestId: e.requestId,
    // Sanitised here too, not only in the runtime: this is the last point before
    // the string reaches the DOM, and defence that depends on another process
    // having done its job is not defence.
    title: sanitiseForDisplay(e.title, 120),
    detail: sanitiseForDisplay(e.detail ?? "", 240),
    levelLabel: label,
    accent,
    paths,
    moreCount: Math.max(0, total - paths.length),
    buttons: buttonsFor(e.options, e.risk?.level),
    warning: warningFor(e.risk?.level, e.risk?.category),
  };
}

/**
 * Which request to show when several are open.
 *
 * The oldest, because it is the one closest to timing out — answering the newest
 * first would let the earlier question expire unseen, and a silent expiry reads
 * to the user as Jarvis ignoring them.
 */
export function currentRequest(queue: readonly PermissionRequestEvent[]): PermissionRequestEvent | null {
  return queue[0] ?? null;
}
