/**
 * Presentation rules for the Agent Trace, separate from React so they can be tested
 * without a DOM — the same split as `mission-model` and `hud-model`.
 *
 * The trace answers one question: what did Jarvis do, in what order, and on whose
 * account. Three rules make that answer worth reading, and each of them is a thing this
 * file declines to do:
 *
 * **A model's sentence is marked as one.** `voice: "model"` reaches here from the
 * runtime, and it becomes a visible attribution on the row rather than being folded into
 * the prose. Every other `because` was composed from the mission's own record. A page
 * that read both in the same voice would be presenting a diagnosis as a measurement.
 *
 * **A trimmed trace says so, with a number.** `omitted` is rendered as its own row in
 * the middle of the list. Showing 200 of 900 lines silently is the "no silent caps"
 * failure in the one pane whose whole job is to be complete about what happened.
 *
 * **A role that did nothing is still shown, with a zero.** The roster is "the seven, and
 * what each of them did here". Hiding the idle ones would turn a mission that never
 * touched the web into a Jarvis that cannot, which is a different and much larger claim.
 *
 * There is no chain of thought to hide here, and that is a property of the input rather
 * than a filter in this file: a trace is built from the mission log, which holds
 * timestamps, states, events, steps, tools, outcomes and classifications, and has never
 * held a prompt or a completion.
 */
import { sanitiseForDisplay } from "../permissions/risk-model";
import type { TraceEntryView, TraceRoleView, TraceView } from "../ipc/contract";

const MAX_TEXT = 200;

/**
 * How each role reads on the page.
 *
 * The label and the purpose come over the wire, so this table is only the colour and
 * the glyph. A role name this build has no entry for keeps the wire's own label and
 * draws in the neutral tone: an unknown role is a build mismatch, and the honest
 * rendering of one is a row that still counts its actions.
 */
export type RoleTone = "plan" | "read" | "recall" | "act" | "code" | "check" | "gate";

const ROLE_TONES: Record<string, RoleTone> = {
  planner: "plan",
  research: "read",
  memory: "recall",
  computer: "act",
  coding: "code",
  verify: "check",
  security: "gate",
};

export function roleTone(role: string): RoleTone | null {
  return ROLE_TONES[role] ?? null;
}

/** One role in the roster beside the trace. */
export interface RoleRow {
  role: string;
  label: string;
  purpose: string;
  actions: number;
  engaged: boolean;
  tone: RoleTone | null;
}

/**
 * The roster, in the wire's order.
 *
 * Not re-sorted by how busy each role was. The order is the canonical one from
 * `agents/roles.ts` — plan, gather, recall, act, code, check, gate — which is roughly
 * the order work moves through them, and a roster that reshuffled itself per mission
 * would make two traces harder to compare rather than easier.
 */
export function roleRows(roles: readonly TraceRoleView[]): RoleRow[] {
  return roles.map((r) => ({
    role: sanitiseForDisplay(r.role, 20),
    label: sanitiseForDisplay(r.label, 30),
    purpose: sanitiseForDisplay(r.purpose, MAX_TEXT),
    actions: Number.isFinite(r.actions) && r.actions > 0 ? Math.floor(r.actions) : 0,
    engaged: r.engaged === true,
    tone: roleTone(r.role),
  }));
}

/** How the `because` line was arrived at, in the words the row shows. */
export type Attribution =
  /** Composed by the runtime from the mission's own record. */
  | "recorded"
  /** A language model's own sentence about a failure it was shown. */
  | "model";

/** One line of the trace, already display-safe. */
export interface TraceRow {
  /** Stable across refetches: the log position, which never changes for a line. */
  key: string;
  seq: number;
  time: string;
  role: string;
  tone: RoleTone | null;
  action: string;
  because: string;
  attribution: Attribution;
  /**
   * What the row says about a model's sentence, when it is one.
   *
   * A phrase rather than a boolean, because the point is that a reader sees it
   * without having to know what a badge colour means.
   */
  quoted?: string;
  stepTitle?: string;
  tool?: string;
  /** Short flags: simulated first, then the risk, then the attempt. Same order as a step. */
  badges: readonly string[];
  outcome?: string;
}

/**
 * The one sentence used whenever `because` came from a model.
 *
 * Fixed text, so it cannot drift into sounding like a verdict. "Jarvis' own diagnosis"
 * would be the wrong words: the model produced the sentence, the record produced
 * everything else on the row, and the reader is entitled to know which is which (§43).
 */
export const MODEL_VOICE_NOTE = "the planning model's own words, not a measurement";

/**
 * The outcome words, spelled the way `mission-model.ts` spells them.
 *
 * Deliberately the same phrasing as the step panel: the same `unconfirmed` outcome
 * described two ways on two panes of one window would let a reader pick whichever
 * reading they preferred.
 */
const OUTCOMES: Record<string, string> = {
  verified: "verified",
  unconfirmed: "ran, nothing confirmed it",
  failed: "failed",
  unchecked: "not checked",
};

function outcomeWords(outcome: string): string {
  return OUTCOMES[outcome] ?? sanitiseForDisplay(outcome, 40);
}

function badgesOf(entry: TraceEntryView): string[] {
  const badges: string[] = [];
  // First and unsuppressable, as everywhere else: a mocked capability drawn as a real
  // one is the failure the build rules name outright.
  if (entry.simulated === true) badges.push("simulated");
  // Only when something had classified the call by that point in the log. The line a
  // step *starts* with is written before classification, so an absent `risk` there is
  // the truth about that moment rather than a missing field.
  if (entry.risk !== undefined) {
    badges.push(`level ${entry.risk.level} ${sanitiseForDisplay(entry.risk.category, 20)}`);
  }
  if (entry.attempt !== undefined && entry.attempt > 1) badges.push(`attempt ${entry.attempt}`);
  return badges;
}

function formatTime(at: number, locale?: string): string {
  if (!Number.isFinite(at)) return "—";
  return new Date(at).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function traceRow(entry: TraceEntryView, locale?: string): TraceRow {
  const model = entry.voice === "model";
  return {
    key: `t${entry.seq}`,
    seq: entry.seq,
    time: formatTime(entry.at, locale),
    role: sanitiseForDisplay(entry.role, 20),
    tone: roleTone(entry.role),
    action: sanitiseForDisplay(entry.action, MAX_TEXT),
    because: sanitiseForDisplay(entry.because, MAX_TEXT),
    attribution: model ? "model" : "recorded",
    ...(model ? { quoted: MODEL_VOICE_NOTE } : {}),
    ...(entry.stepTitle !== undefined
      ? { stepTitle: sanitiseForDisplay(entry.stepTitle, MAX_TEXT) }
      : {}),
    ...(entry.tool !== undefined ? { tool: sanitiseForDisplay(entry.tool, 60) } : {}),
    badges: badgesOf(entry),
    ...(entry.outcome !== undefined ? { outcome: outcomeWords(entry.outcome) } : {}),
  };
}

/** The row standing in for a cut middle. Never rendered when nothing was cut. */
export interface OmissionRow {
  key: string;
  /** Where the cut sits, so it draws between the entries it replaced. */
  afterSeq: number;
  text: string;
}

export interface TraceScreen {
  missionId: string;
  objective: string;
  rows: readonly TraceRow[];
  roles: readonly RoleRow[];
  /** Present only when the trace was trimmed. */
  omission: OmissionRow | null;
  /** How many lines the mission logged, whether or not they are all shown. */
  lines: number;
  /**
   * Why there is nothing to show, when there is nothing to show.
   *
   * Distinct from `rows` being empty for any other reason: this is the runtime saying
   * it cannot account for the mission, which is a statement and not an absence.
   */
  gap: string | null;
}

/**
 * The whole pane, from one `get_trace` answer.
 *
 * `null` — the runtime was not reachable, or the page has not asked yet — produces a
 * screen that says so through `gap`, because "we could not ask" and "it did nothing"
 * are different facts and a blank list would merge them.
 */
export function traceScreen(view: TraceView | null, locale?: string): TraceScreen {
  if (view === null) {
    return {
      missionId: "",
      objective: "",
      rows: [],
      roles: [],
      omission: null,
      lines: 0,
      gap: "Jarvis could not be asked for this trace.",
    };
  }
  const rows = view.entries.map((e) => traceRow(e, locale));
  return {
    missionId: view.missionId,
    objective: sanitiseForDisplay(view.objective, MAX_TEXT),
    rows,
    roles: roleRows(view.roles),
    omission: omissionOf(view, rows),
    lines: Number.isFinite(view.lines) && view.lines > 0 ? Math.floor(view.lines) : 0,
    gap: view.gap !== undefined && view.gap !== "" ? sanitiseForDisplay(view.gap, MAX_TEXT) : null,
  };
}

/**
 * The sentence for a trimmed trace.
 *
 * Anchored to the last shown opening entry rather than to a count, so it draws in the
 * place the lines actually went missing from. It names both numbers: how many are gone
 * and how many the mission wrote, because either alone lets a reader guess wrongly
 * about the other.
 */
function omissionOf(view: TraceView, rows: readonly TraceRow[]): OmissionRow | null {
  if (view.omitted <= 0 || rows.length === 0) return null;
  const cut = Math.floor(view.omitted);
  // The seq of the last entry before the gap. Entries carry their pre-trim position,
  // so this is the log's own numbering rather than an index into what survived.
  let afterSeq = rows[0]?.seq ?? 0;
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const here = rows[i];
    if (prev !== undefined && here !== undefined && here.seq > prev.seq + 1) {
      afterSeq = prev.seq;
      break;
    }
  }
  return {
    key: `omitted-${afterSeq}`,
    afterSeq,
    text: `${cut} line(s) not shown — this mission logged ${view.lines} in total.`,
  };
}

/** Roles that actually did something, for a one-line summary above the list. */
export function engagedRoleRows(screen: TraceScreen): readonly RoleRow[] {
  return screen.roles.filter((r) => r.engaged);
}

/**
 * The summary sentence over the roster.
 *
 * Counted from the rows, never characterised: "Research and Computer did most of the
 * work" would be this file inventing an emphasis the record does not support.
 */
export function describeEngagement(screen: TraceScreen): string {
  const engaged = engagedRoleRows(screen);
  if (engaged.length === 0) return "No role recorded an action.";
  const names = engaged.map((r) => `${r.label} (${r.actions})`).join(", ");
  return `${engaged.length} of ${screen.roles.length} roles acted: ${names}.`;
}
