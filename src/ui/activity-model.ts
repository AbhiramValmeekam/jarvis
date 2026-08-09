/**
 * Presentation rules for the Activity view, separate from React so they can be
 * tested without a DOM — the same split as `hud-model` and `permission-model`.
 *
 * The Activity view is the answer to "what has this thing been doing on my
 * laptop all day?", and it is the only place a user can check Jarvis's account
 * of itself. Two rules follow from that, and everything here is one of them.
 *
 * **Absent is not success.** Jarvis grants permission for Hermes' tool calls but
 * does not run them, so most entries have no verified outcome and never will.
 * A view that renders blank-as-fine would report a clean day for work nobody
 * checked — the same false success the rest of Phase 5 is built to refuse.
 *
 * **Refusals are the headline.** A list where "deny" looks like "allow" hides
 * the thing the user most needs to see: what Jarvis was asked to do and said no
 * to. That is the evidence of an attack, not routine noise.
 */
import { isSerious } from "./permission-model";
import { sanitiseForDisplay } from "../permissions/risk-model";
import type { ActivityEntry } from "../ipc/contract";

/** Rows kept in the view. The runtime bounds its own log at 1000. */
export const MAX_ROWS = 200;

export interface ActivityRow {
  key: string;
  time: string;
  tool: string;
  /** "Allowed" / "Refused" — the user's words, not the engine's. */
  verdict: string;
  reason: string;
  level: number;
  /** What is known about the result, phrased so silence cannot read as fine. */
  outcome: string;
  /** True when this entry deserves to stand out: a refusal or a serious level. */
  notable: boolean;
  /** Colour token for the row accent. */
  tone: "refused" | "serious" | "ordinary";
}

/**
 * How the four outcomes read to a person, plus the fifth case: nothing checked.
 *
 * "not checked" is deliberately not blank and deliberately not "ok". The whole
 * point of `verified-action.ts` is that no-error and verified are different
 * claims, and this is where that distinction either survives to the screen or
 * quietly dies.
 */
export function outcomeLabel(outcome: ActivityEntry["outcome"]): string {
  switch (outcome) {
    case "verified":
      return "done, checked";
    case "unconfirmed":
      return "no error, but unconfirmed";
    case "failed":
      return "failed";
    case "unchecked":
      return "could not check";
    default:
      return "not checked";
  }
}

/**
 * Levels 3 and up are serious: destructive, outward-facing, or systemic.
 *
 * Imported from the consent dialog rather than restated. I wrote it out a second
 * time here first and got `-1` wrong — finite, integral, below 3, therefore
 * "ordinary" — so an unrecognised level would have been asked about as grave and
 * then filed as routine. That is the drift the dialog's own comment warns about,
 * and the fix is one rule in one place, not two that agree today.
 */
export { isSerious };

/** Local wall-clock, because "3 hours ago" is not what you check a log for. */
export function formatTime(at: number, locale?: string): string {
  if (!Number.isFinite(at)) return "—";
  return new Date(at).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function toRow(entry: ActivityEntry, index: number, locale?: string): ActivityRow {
  const refused = entry.verdict === "deny";
  const serious = isSerious(entry.level);
  return {
    // The index is part of the key because `at` is not unique: several decisions
    // can land in the same millisecond, and React would drop the duplicates.
    key: `${entry.at}-${index}`,
    time: formatTime(entry.at, locale),
    // Sanitised here, not in the component, for the same reason the permission
    // dialog re-sanitises: the tool name is a string a model produced, and the
    // runtime having cleaned it is not a reason for this side to assume it did.
    // Doing it in the model means the rule is covered by these tests rather than
    // by looking at the rendered page.
    tool: sanitiseForDisplay(entry.tool, 60),
    verdict: refused ? "Refused" : "Allowed",
    reason: sanitiseForDisplay(entry.reason, 160),
    level: entry.level,
    outcome: outcomeLabel(entry.outcome),
    notable: refused || serious,
    tone: refused ? "refused" : serious ? "serious" : "ordinary",
  };
}

/**
 * Newest first, bounded.
 *
 * The wire delivers oldest-first because that is the order things happened; the
 * view reverses it because the question being asked is "what just happened?".
 */
export function toRows(entries: readonly ActivityEntry[], locale?: string): ActivityRow[] {
  return entries
    .slice(-MAX_ROWS)
    .map((e, i) => toRow(e, i, locale))
    .reverse();
}

/**
 * Add a live entry to the list the view holds.
 *
 * Kept here rather than inline in the component so the bound is enforced in one
 * tested place: an always-on runtime emits these for weeks, and a list that only
 * grows is a leak in the window that is open longest.
 */
export function appendEntry(
  entries: readonly ActivityEntry[],
  entry: ActivityEntry,
): ActivityEntry[] {
  const next = [...entries, entry];
  return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next;
}

/**
 * Reconcile a freshly fetched backlog with what the view already holds.
 *
 * Needed because the two sources overlap. The view appends live `activity`
 * events, and it also re-fetches the whole log on reconnect — so a naive replace
 * loses any decision that arrived while the fetch was in flight, and a naive
 * concat shows every entry twice.
 *
 * The server's log is authoritative for everything up to the moment it answered,
 * so that list is taken whole; local entries are kept only if they are newer than
 * its last row. Dropping one of those would be the worse failure of the two: a
 * refusal that happened during a reconnect is exactly the entry someone is
 * looking for.
 */
export function mergeBacklog(
  local: readonly ActivityEntry[],
  fetched: readonly ActivityEntry[],
): ActivityEntry[] {
  if (fetched.length === 0) return [...local];
  const newest = fetched[fetched.length - 1]!.at;
  const tail = local.filter((e) => e.at > newest);
  const merged = [...fetched, ...tail];
  return merged.length > MAX_ROWS ? merged.slice(merged.length - MAX_ROWS) : merged;
}

/**
 * What the view says when it has nothing to show.
 *
 * Distinguishes "nothing has happened" from "we could not ask", because an empty
 * list under a broken link is not evidence of a quiet day. Reporting it as one
 * would be the same false-negative the outcome vocabulary exists to prevent.
 */
export function emptyMessage(connected: boolean): string {
  return connected
    ? "Nothing yet. Decisions Jarvis makes about tools will appear here."
    : "Not connected, so this list may be out of date.";
}

/** How many of these were refusals — the number worth surfacing at a glance. */
export function refusedCount(entries: readonly ActivityEntry[]): number {
  return entries.reduce((n, e) => (e.verdict === "deny" ? n + 1 : n), 0);
}
