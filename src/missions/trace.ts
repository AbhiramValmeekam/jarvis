/**
 * The Agent Trace: what Jarvis did, in order, and what each line is attributed to.
 *
 * This is the page the master prompt asks for when it says explain the actions and
 * **not** the chain of thought, and the distinction is enforceable here rather than
 * merely intended, because of what this file is built from. Its whole input is
 * `MissionStore.history()` — the append-only log a mission wrote about itself while it
 * ran. That log holds timestamps, states, events, steps, tools, outcomes, attempts,
 * classifications, and one sanitised line per transition. It has never held a token, a
 * prompt, a completion or a model's reasoning, so there is no reasoning in this file to
 * leak: the trace cannot show chain-of-thought the same way `mission-view.ts` cannot show
 * a step's arguments — the field does not exist upstream.
 *
 * Two consequences worth being explicit about, because both are easy to get wrong in the
 * direction that flatters the system.
 *
 *  - **The one exception is marked.** A replan diagnosis from `llm-replanner.ts` really is
 *    a model's own sentence, and it really does reach the log as a note. It arrives here
 *    with `voice: "model"` on the line and leaves with `voice: "model"` on the entry, so
 *    a page can say whose words those are. It is a *conclusion* the model published, not
 *    its deliberation, and this file neither hides it nor dresses it up as a fact Jarvis
 *    counted (§43).
 *  - **`because` is a reason, not a rationalisation.** Every one of them is either the
 *    line's own recorded note or a sentence composed from that line's own fields. There
 *    is no branch here that explains *why the model chose* anything, because nothing in
 *    the record knows and inventing it is the failure mode this project is about.
 *
 * The log is the source rather than the snapshot on purpose. A snapshot holds the mission
 * as it ended, so a trace built from it would show every step in its final status and
 * lose the order things actually happened in — which is the only thing a trace is for.
 */
import {
  attributeLine,
  roleEngagement,
  type AgentRole,
  type RoleEngagement,
} from "../agents/roles.js";
import type { LoggedStep, MissionLogLine } from "./mission-store.js";
import type { Mission } from "./mission-model.js";

/**
 * How many entries one trace may carry.
 *
 * The log's own ceiling is 512 KB, which is thousands of lines — far more than a pane
 * can show and more than one IPC message should carry. Trimming is head-and-tail rather
 * than tail-only because the beginning of a mission is where the plan is, and a trace
 * that opened in the middle of a retry loop would be missing the thing it explains.
 */
export const MAX_TRACE_ENTRIES = 200;

/** How much of that ceiling is spent on the opening. The rest is the most recent. */
export const TRACE_HEAD = 40;

export interface TraceRisk {
  readonly level: number;
  readonly category: string;
}

/** One thing that happened, as the trace tells it. */
export interface TraceEntry {
  /** Position in the whole log, counted before any trimming, so a gap is visible. */
  readonly seq: number;
  readonly at: number;
  readonly role: AgentRole;
  /**
   * What happened, in this file's words.
   *
   * Composed from the line's `event`, `state` and step, never from prose off disk. It is
   * fixed text per case, which is what makes it checkable: the same recorded line always
   * produces the same sentence.
   */
  readonly action: string;
  /**
   * Why the entry is here: the line's own note when it had one, otherwise a sentence
   * built from the line's own fields. Never a motive, and never an inference.
   */
  readonly because: string;
  /** Set when the line was about a step, so the page can group a retry with its first try. */
  readonly stepId?: string;
  readonly stepTitle?: string;
  readonly tool?: string;
  readonly outcome?: string;
  readonly attempt?: number;
  readonly risk?: TraceRisk;
  /** `"model"` when `because` is a language model's own sentence. See the header. */
  readonly voice?: "model";
  readonly simulated?: boolean;
}

export interface Trace {
  readonly missionId: string;
  readonly objective: string;
  readonly state: string;
  readonly entries: readonly TraceEntry[];
  /**
   * The seven roles and what each did here, counted over *every* line rather than the
   * entries that survived trimming — a truncated trace must not understate engagement.
   */
  readonly roles: readonly RoleEngagement[];
  /** How many lines the log held. */
  readonly lines: number;
  /** How many entries the middle lost to `MAX_TRACE_ENTRIES`. Zero when nothing was cut. */
  readonly omitted: number;
}

/** What the whole trace says about itself when there is no log to read. */
export interface TraceGap {
  readonly reason: string;
}

/**
 * What a mission event is, as one sentence.
 *
 * A fixed table, so an event this build does not know produces no sentence rather than
 * its own identifier shown at a user. Each entry is a verb phrase in the past tense
 * with Jarvis as the implied subject, because the trace answers "what did it do".
 */
const ACTIONS: Readonly<Record<string, string>> = {
  planned: "decomposed the objective into a plan",
  plan_empty: "could not turn the objective into a single step",
  retrieved: "gathered what it already knew",
  verify: "checked what the step actually changed",
  step_ok: "confirmed the step did what it said",
  step_bad: "could not confirm the step",
  need_approval: "stopped to ask permission",
  approved: "was cleared to run the step",
  denied: "accepted your refusal and stopped the step",
  replanned: "changed the plan",
  replan_exhausted: "ran out of ways to fix it",
  ask_user: "handed the question back to you",
  finish: "finished, with every required step verified",
  give_up: "stopped, short of the objective",
  cancel: "stopped because you cancelled it",
  error: "stopped on a fault of its own",
};

/**
 * Why an event happened, when the line carried no note of its own.
 *
 * Only for the events whose reason is structural — `step_ok` happens because a verifier
 * returned `verified`, and that is true every time. Events whose reason is particular to
 * the mission (`replanned`, `give_up`, `error`) are absent here, because a general
 * sentence in their place would read as an explanation and be nothing of the kind. When
 * neither a note nor this table answers, `reasonFor` falls back to the state.
 */
const REASONS: Readonly<Record<string, string>> = {
  plan_empty: "nothing in the objective matched a tool this build has",
  retrieved: "the plan runs against what Jarvis knows, so it is read before anything acts",
  verify: "a step acted, and acting is not the same as succeeding",
  step_ok: "its check reported the world had changed",
  step_bad: "its check did not report the world had changed",
  need_approval: "the step classified high enough that only you can allow it",
  approved: "you allowed it, or a grant you had already given covered it",
  denied: "you turned it down, which is an answer and not a fault",
  finish: "every step the objective required came back verified",
  cancel: "you asked for it to stop",
};

function reasonFor(line: MissionLogLine): string {
  if (line.note !== undefined && line.note !== "") return line.note;
  if (line.event !== undefined) {
    const known = REASONS[line.event];
    if (known !== undefined) return known;
  }
  return `the mission was ${line.state.replace(/_/g, " ")} at this point`;
}

/** The fields a step contributes to an entry, and nothing else it happens to carry. */
function fromStep(step: LoggedStep): Partial<TraceEntry> {
  return {
    stepId: step.id,
    stepTitle: step.title,
    tool: step.tool,
    ...(step.outcome !== undefined ? { outcome: step.outcome } : {}),
    attempt: step.attempt,
    ...(step.risk !== undefined
      ? { risk: { level: step.risk.level, category: step.risk.category } }
      : {}),
    ...(step.simulated === true ? { simulated: true } : {}),
  };
}

/**
 * One line as one entry.
 *
 * The three shapes the orchestrator writes are all handled here, and the order of the
 * checks is the priority: an event outranks a step, because `step_ok` is a line about
 * *checking* and only incidentally about the command that was checked.
 */
function toEntry(line: MissionLogLine, seq: number): TraceEntry {
  const { role } = attributeLine(line);
  const step = line.step;
  const base = {
    seq,
    at: line.at,
    role,
    because: reasonFor(line),
    ...(line.voice === "model" ? { voice: "model" as const } : {}),
    ...(step !== undefined ? fromStep(step) : {}),
  };

  if (line.event !== undefined) {
    const known = ACTIONS[line.event];
    return {
      ...base,
      // An unrecognised event still gets an entry, and says only what it can stand
      // behind. Dropping the line would make a hand-edited log look shorter than it is.
      action: known ?? "recorded something this build does not have a name for",
    };
  }
  if (step !== undefined) {
    // The one line written when a step begins, and the only place research, computer and
    // coding show up as themselves. Named after the tool because that is what the plan
    // committed to; whether it worked is two lines further down.
    return {
      ...base,
      action: `started ${step.title}`,
      because:
        line.note !== undefined && line.note !== ""
          ? line.note
          : step.origin === "replan"
            ? `a replan added this step, to be run with ${step.tool}`
            : `the plan named ${step.tool} for this`,
    };
  }
  return { ...base, action: "opened the mission" };
}

/**
 * Cut the middle out of an over-long trace.
 *
 * The count of what went is returned rather than logged, so the page can say a number:
 * a trace that silently showed 200 of 900 lines would be the "no silent caps" failure in
 * a pane whose entire job is to be complete about what happened.
 */
function trim(entries: readonly TraceEntry[]): {
  readonly kept: readonly TraceEntry[];
  readonly omitted: number;
} {
  if (entries.length <= MAX_TRACE_ENTRIES) return { kept: entries, omitted: 0 };
  const tail = MAX_TRACE_ENTRIES - TRACE_HEAD;
  return {
    kept: [...entries.slice(0, TRACE_HEAD), ...entries.slice(entries.length - tail)],
    omitted: entries.length - MAX_TRACE_ENTRIES,
  };
}

/**
 * Build the trace.
 *
 * The mission supplies only its identity — id, objective, final state. Everything a
 * reader is shown about *what happened* comes from `lines`, which is why an empty log
 * produces an empty trace rather than one reconstructed from the snapshot. A mission
 * whose log was lost is a mission Jarvis cannot account for, and saying so is the honest
 * answer; inventing the account from the final state is not.
 */
export function buildTrace(mission: Mission, lines: readonly MissionLogLine[]): Trace {
  // Lines belonging to another mission are dropped rather than trusted. `history()`
  // reads one file, so this only fires on a file that was edited or renamed by hand —
  // in which case the id in the line is the one that knows what it belongs to.
  const mine = lines.filter((l) => l.mission === mission.id);
  const entries = mine.map(toEntry);
  const { kept, omitted } = trim(entries);
  return {
    missionId: mission.id,
    objective: mission.objective,
    state: mission.state,
    entries: kept,
    roles: roleEngagement(mine),
    lines: mine.length,
    omitted,
  };
}

/**
 * What to say when a mission has no trace.
 *
 * Separated from `buildTrace` so the two cases cannot be confused: a mission with an
 * empty log is not a mission that did nothing, and the sentence has to distinguish them.
 */
export function traceGap(mission: Mission, lines: readonly MissionLogLine[]): TraceGap | null {
  if (lines.length > 0) return null;
  return {
    reason:
      mission.steps.length > 0
        ? `this mission's log is empty, so Jarvis cannot account for the ${mission.steps.length} step(s) its snapshot records`
        : "this mission wrote no log, so there is nothing to account for",
  };
}

/** Every role that did at least one thing, for a one-line summary. */
export function engagedRoles(trace: Trace): readonly RoleEngagement[] {
  return trace.roles.filter((r) => r.engaged);
}
