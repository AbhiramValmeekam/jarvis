/**
 * Translating between Hermes' permission vocabulary and Jarvis' own.
 *
 * Three vocabularies meet at this file and none of them agree:
 *
 * - ACP offers five outcome ids (`allow_once`, `allow_session`, `allow_always`,
 *   `deny`, `deny_always`).
 * - The permission engine has four consent choices — no `allow_session`,
 *   because a grant that lasts "the session" is unbounded on a machine that
 *   never reboots.
 * - The IPC contract exposes three to the UI, since a HUD button for
 *   "deny always" is a footgun the user cannot easily undo.
 *
 * Mapping them by hand in each call site is how one of them silently drifts, so
 * the conversions live here and are tested as a unit.
 *
 * The interesting part is `toActionDescriptor`. An ACP tool call does not
 * reliably carry a tool *name*: it carries a `kind` (`read`, `edit`, `delete`,
 * `execute`, …), sometimes a name, and a `rawInput` blob. Feeding the wrong one
 * to the classifier is a downgrade waiting to happen — a call named
 * `read_and_delete` classifies as a read, because `family()` matches `read`
 * first. So this picks whichever candidate classifies *worst* rather than
 * whichever appears first, and keeps every candidate in the arguments so the
 * forbidden rules still see all of the text.
 */
import { classify, type ActionDescriptor, type Classification } from "./risk-model.js";
import type { ConsentChoice, Verdict } from "./permission-engine.js";
import type { PermissionDecision } from "../ipc/contract.js";

/** ACP's own outcome ids, restated here so this file does not depend on the adapter. */
export type OutcomeId =
  | "allow_once"
  | "allow_session"
  | "allow_always"
  | "deny"
  | "deny_always";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Which of two classifications should win.
 *
 * `forbidden` beats everything; after that, the higher level. Deliberately not
 * "the first one that matched": the whole point is that a benign-looking name
 * must not be able to mask a dangerous `kind`, or the other way round.
 */
function worse(a: Classification, b: Classification): boolean {
  if (a.forbidden !== b.forbidden) return a.forbidden;
  return a.level > b.level;
}

/**
 * Build a descriptor the classifier can judge from an ACP tool call.
 *
 * Every candidate name is tried and the harshest verdict wins. `args` keeps the
 * whole original record — including `kind` and `title` — because the forbidden
 * rules match on flattened arguments and a payload is exactly where an
 * injected instruction hides.
 */
export function toActionDescriptor(toolCall: unknown): ActionDescriptor {
  if (!isRecord(toolCall)) {
    // Unparseable is not harmless. An empty tool name reaches the classifier's
    // fail-closed default and asks.
    return { tool: "", args: toolCall };
  }

  const args =
    toolCall.rawInput ??
    toolCall.input ??
    toolCall.arguments ??
    toolCall.args ??
    toolCall;

  const candidates = [
    str(toolCall.name),
    str(toolCall.toolName),
    str(toolCall.tool),
    str(toolCall.kind),
  ].filter((c): c is string => c !== null);

  // The args go into every trial classification, so a forbidden payload is
  // caught no matter which candidate name ends up winning.
  let best: { tool: string; c: Classification } | null = null;
  for (const tool of candidates) {
    const c = classify({ tool, args });
    if (!best || worse(c, best.c)) best = { tool, c };
  }

  const title = str(toolCall.title);
  return {
    tool: best?.tool ?? "",
    args,
    ...(title === null ? {} : { title }),
  };
}

/**
 * The engine's answer, in the vocabulary Hermes expects.
 *
 * Only ever `allow_once` or `deny`, and the narrow return type is the point.
 *
 * It is tempting to forward the user's "always" to Hermes, since that is
 * literally what they clicked. It would be a mistake. `allow_always` tells
 * Hermes to stop asking, and every guarantee this subsystem makes depends on
 * Hermes asking every single time:
 *
 * - the 24-hour grant expiry only expires grants the engine holds;
 * - "forget what I allowed" can only forget the same;
 * - the audit log can only record calls that reach it.
 *
 * Hand the decision to Hermes once and all three quietly stop being true, with
 * no failing test and no visible symptom. So Jarvis keeps the whole ledger and
 * answers one call at a time; `fromGrant` is reported to the *user*, not to the
 * agent.
 */
export function toOutcomeId(verdict: Verdict): Extract<OutcomeId, "allow_once" | "deny"> {
  return verdict === "deny" ? "deny" : "allow_once";
}

/** What the UI can say, widened to what the engine understands. */
export function fromIpcDecision(decision: PermissionDecision): ConsentChoice {
  switch (decision) {
    case "allow_once":
      return "allow_once";
    case "allow_always":
      return "allow_always";
    default:
      // Anything unrecognised lands here too, and denying is the safe default.
      return "deny";
  }
}

/** The engine's options, narrowed to what the UI has buttons for. */
export function toIpcOptions(options: readonly ConsentChoice[]): PermissionDecision[] {
  const out: PermissionDecision[] = [];
  for (const o of options) {
    if (o === "allow_once" || o === "allow_always" || o === "deny") out.push(o);
  }
  // `deny` is always offered. A dialog with no way to refuse is not consent.
  if (!out.includes("deny")) out.push("deny");
  return out;
}
