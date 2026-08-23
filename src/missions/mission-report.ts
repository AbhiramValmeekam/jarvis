/**
 * What the mission actually did, in words, from the record.
 *
 * §47's final report. Every number in it is counted from the mission's own steps
 * and every sentence is composed here — nothing in this file takes prose from a
 * model, a tool's output or a file. That is the whole design constraint: a report
 * is the thing a person reads *instead of* watching, so it is the last place that
 * can afford to describe something that did not happen.
 *
 * Three consequences worth stating:
 *
 *  - **`done` is the only success.** The counts come from `stepCounts`, so a step
 *    that came back `unconfirmed` appears under what remains, with "nothing
 *    confirmed it" as its reason. A report that rounded those up would be the
 *    fake completion the rest of this layer is built to avoid.
 *  - **A recovery is visible.** A step that failed, was retried and then verified
 *    is counted as recovered rather than quietly reading as a first-time success —
 *    `attempt` and the kept `error` are what make that possible, which is why
 *    `retryStep` does not clear them.
 *  - **The recommendation is grounded.** `nextAction` is composed from a specific
 *    recorded fact — the step that stopped the mission, the question it is waiting
 *    on — or it is absent. It never guesses at a fix, because a guess in the
 *    report is indistinguishable from a diagnosis.
 */
import { sanitiseForDisplay } from "../permissions/risk-model.js";
import {
  isTerminal,
  stepCounts,
  type Mission,
  type MissionMemoryRef,
  type PlanStep,
  type StepCounts,
  type StepStatus,
} from "./mission-model.js";

const MAX_LINE = 200;

function line(text: string): string {
  return sanitiseForDisplay(text, MAX_LINE);
}

/** One step, as the report names it. */
export interface ReportEntry {
  readonly id: string;
  readonly title: string;
  readonly tool: string;
  /** What the tool reported, or why this one is outstanding. Display-safe. */
  readonly detail?: string;
  /** 1 unless it was retried, which is how a recovery reads in the list. */
  readonly attempt: number;
  /** True when the capability behind it was mocked or absent. Never hidden. */
  readonly simulated?: boolean;
}

/**
 * Per-tool arithmetic.
 *
 * `attempts` is summed from each step's recorded `attempt`, not from a counter a
 * tool kept, so it is exactly "how many times this plan says we tried" — the only
 * number this layer can honestly claim.
 */
export interface ToolUse {
  readonly tool: string;
  readonly attempts: number;
  readonly verified: number;
  readonly failed: number;
  readonly unverified: number;
}

export interface MissionReport {
  readonly missionId: string;
  readonly objective: string;
  /** The mission's own state word, unchanged. */
  readonly state: Mission["state"];
  /** One line a person can read on its own. */
  readonly headline: string;
  /** Null while a mission is still running and no clock was supplied. */
  readonly durationMs: number | null;
  readonly counts: StepCounts;
  readonly planner: Mission["planner"];
  readonly replans: number;
  /** Steps that failed or went unverified and then verified on a later attempt. */
  readonly recovered: readonly ReportEntry[];
  readonly verified: readonly ReportEntry[];
  /** Everything that is not `done`, each with a stated reason. */
  readonly outstanding: readonly ReportEntry[];
  readonly simulated: readonly ReportEntry[];
  readonly tools: readonly ToolUse[];
  /** What retrieval found before executing — including nothing. */
  readonly memory: readonly MissionMemoryRef[];
  /** Why it stopped, in the mission's own words, when it said. */
  readonly conclusion?: string;
  /** One concrete, recorded next move, or absent when there is nothing honest to say. */
  readonly nextAction?: string;
}

/**
 * Why a step is not `done`, in words, from its status.
 *
 * The step's own `error` wins when it has one — it is the same text the log and
 * the UI show, so the report cannot describe a failure differently from the way
 * it was recorded. The fallbacks say what the status means rather than dressing it
 * up: `pending` is "never attempted", and that is the true account of a step the
 * mission ended before reaching.
 */
function whyOutstanding(step: PlanStep): string {
  if (step.error !== undefined && step.error.trim() !== "") return line(step.error);
  switch (step.status) {
    case "unverified":
      return step.outcome === "unchecked"
        ? "it ran, and there was no way to check whether it worked"
        : "it ran, and nothing confirmed that it worked";
    case "pending":
      return "never attempted";
    case "awaiting_approval":
      return "waiting for you to allow it";
    case "running":
      return "still running when the mission ended";
    case "skipped":
      return "dropped, because a step it needed did not succeed";
    case "cancelled":
      return "stopped when the mission stopped";
    case "failed":
      return "it failed, and nothing recorded why";
    case "done":
      // Not reachable: `done` steps are not outstanding. Stated rather than
      // thrown, because a report is not the place to raise an exception.
      return "it worked";
  }
}

function entry(step: PlanStep, detail: string | undefined): ReportEntry {
  return {
    id: step.id,
    title: line(step.title),
    tool: step.tool,
    attempt: step.attempt,
    ...(detail !== undefined && detail !== "" ? { detail: line(detail) } : {}),
    ...(step.simulated ? { simulated: true } : {}),
  };
}

/** A step that took more than one attempt to get to `done`. */
function isRecovered(step: PlanStep): boolean {
  return step.status === "done" && step.attempt > 1;
}

function toolUse(mission: Mission): readonly ToolUse[] {
  const by = new Map<string, { attempts: number; verified: number; failed: number; unverified: number }>();
  for (const step of mission.steps) {
    const row = by.get(step.tool) ?? { attempts: 0, verified: 0, failed: 0, unverified: 0 };
    // Only steps that actually reached a tool count as attempts: an `outcome` is
    // the record that one ran, and a step still `pending` never called anything.
    if (step.outcome !== undefined) row.attempts += step.attempt;
    if (step.status === "done") row.verified += 1;
    if (step.status === "failed") row.failed += 1;
    if (step.status === "unverified") row.unverified += 1;
    by.set(step.tool, row);
  }
  return [...by.entries()]
    .map(([tool, row]) => ({ tool, ...row }))
    .sort((a, b) => b.attempts - a.attempts || a.tool.localeCompare(b.tool));
}

/** Spoken-sized, and exact where exactness is cheap. Missions run in seconds. */
export function describeDuration(ms: number): string {
  if (ms < 1_000) return "under a second";
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** How many of the steps that mattered are `done`, as a fraction to read out. */
function requiredTally(mission: Mission): { done: number; total: number } {
  const required = mission.steps.filter((s) => !s.optional);
  return { done: required.filter((s) => s.status === "done").length, total: required.length };
}

function headlineFor(mission: Mission, counts: StepCounts, durationMs: number | null): string {
  const tally = requiredTally(mission);
  const took = durationMs === null ? "" : ` in ${describeDuration(durationMs)}`;
  const of = `${tally.done} of ${tally.total} step${tally.total === 1 ? "" : "s"}`;
  switch (mission.state) {
    case "completed":
      return line(
        counts.failed + counts.skipped > 0
          ? `Done${took} — ${of} verified, and ${counts.failed + counts.skipped} optional step${counts.failed + counts.skipped === 1 ? "" : "s"} did not work out`
          : `Done${took} — ${of} verified`,
      );
    case "failed":
      return line(`Not finished${took} — ${of} verified, ${counts.failed} failed`);
    case "blocked":
      return line(`Waiting on you${took} — ${of} verified so far`);
    case "cancelled":
      return line(`Cancelled${took} — ${of} verified before it stopped`);
    default:
      return line(`Running — ${of} verified so far`);
  }
}

/**
 * The one recorded move to suggest, or nothing.
 *
 * Ordered by whose turn it is: a blocked mission is waiting on the user and says
 * what for, a failed one names the step it stopped at in that step's own recorded
 * words, and a mission that finished cleanly gets no recommendation at all —
 * inventing one would be filling space where there is no fact.
 */
function nextActionFor(mission: Mission, outstanding: readonly ReportEntry[]): string | undefined {
  if (mission.state === "blocked") {
    return line(
      mission.conclusion !== undefined && mission.conclusion.trim() !== ""
        ? mission.conclusion
        : "answer the question this mission stopped on, then start it again",
    );
  }
  if (mission.state === "cancelled") return "start it again if you still want it";
  if (!isTerminal(mission.state)) return undefined;

  const required = new Set(mission.steps.filter((s) => !s.optional).map((s) => s.id));
  const blocker = outstanding.find((e) => required.has(e.id));
  if (mission.state === "failed" && blocker !== undefined) {
    return line(
      blocker.detail === undefined
        ? `look at ${blocker.title.toLowerCase()} — it did not finish`
        : `look at ${blocker.title.toLowerCase()} — ${blocker.detail}`,
    );
  }
  const optional = outstanding[0];
  if (mission.state === "completed" && optional !== undefined) {
    return line(
      `the objective did not need it, but ${optional.title.toLowerCase()} did not work${optional.detail === undefined ? "" : ` — ${optional.detail}`}`,
    );
  }
  return undefined;
}

const ORDER: Readonly<Record<StepStatus, number>> = {
  failed: 0,
  unverified: 1,
  awaiting_approval: 2,
  running: 3,
  skipped: 4,
  pending: 5,
  cancelled: 6,
  done: 7,
};

/**
 * Build the report.
 *
 * `now` is only consulted for a mission that has not finished — a terminal
 * mission's duration comes from its own `finishedAt`, so the same mission produces
 * the same report tomorrow. Pure, like the rest of `missions/`: no clock of its
 * own, no disk, no config.
 */
export function buildReport(mission: Mission, now?: number): MissionReport {
  const counts = stepCounts(mission);
  const finishedAt = mission.finishedAt ?? (isTerminal(mission.state) ? undefined : now);
  const durationMs =
    finishedAt === undefined ? null : Math.max(0, finishedAt - mission.createdAt);

  const verified = mission.steps
    .filter((s) => s.status === "done")
    .map((s) => entry(s, s.result));
  const outstanding = mission.steps
    .filter((s) => s.status !== "done")
    .slice()
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.priority - b.priority)
    .map((s) => entry(s, whyOutstanding(s)));
  const recovered = mission.steps.filter(isRecovered).map((s) => entry(s, s.error));
  const simulated = mission.steps
    .filter((s) => s.simulated === true)
    .map((s) => entry(s, s.result ?? s.error));

  const headline = headlineFor(mission, counts, durationMs);
  const nextAction = nextActionFor(mission, outstanding);
  return {
    missionId: mission.id,
    objective: line(mission.objective),
    state: mission.state,
    headline,
    durationMs,
    counts,
    planner: mission.planner,
    replans: mission.replans,
    recovered,
    verified,
    outstanding,
    simulated,
    tools: toolUse(mission),
    memory: mission.memory,
    ...(mission.conclusion !== undefined ? { conclusion: line(mission.conclusion) } : {}),
    ...(nextAction !== undefined ? { nextAction } : {}),
  };
}

/**
 * The report as lines of text, for a probe, a log or a terminal.
 *
 * The UI does its own layout from the structured report; this exists so the
 * offline path can *show* the same facts without a renderer, and so a probe's
 * output is something a person can read rather than JSON to decode.
 *
 * `simulated` is called out in its own section rather than as a footnote, because
 * a mocked capability that reads like a real one is the one thing the build rules
 * name outright.
 */
export function formatReport(report: MissionReport): readonly string[] {
  const out: string[] = [
    report.headline,
    `objective: ${report.objective}`,
    `plan: ${report.counts.total} step${report.counts.total === 1 ? "" : "s"} from the ${report.planner} planner` +
      (report.counts.corrective > 0
        ? `, ${report.counts.corrective} added while it ran (${report.replans} replan${report.replans === 1 ? "" : "s"})`
        : ""),
  ];
  if (report.memory.length > 0) {
    out.push(`recalled first: ${report.memory.map((m) => `${m.source} — ${m.summary}`).join("; ")}`);
  }
  if (report.verified.length > 0) {
    out.push("verified:");
    for (const e of report.verified) {
      out.push(`  ${e.title}${e.detail === undefined ? "" : ` — ${e.detail}`}`);
    }
  }
  if (report.recovered.length > 0) {
    out.push("recovered:");
    for (const e of report.recovered) {
      out.push(`  ${e.title} — worked on attempt ${e.attempt}${e.detail === undefined ? "" : `, after ${e.detail}`}`);
    }
  }
  if (report.outstanding.length > 0) {
    out.push("outstanding:");
    for (const e of report.outstanding) {
      out.push(`  ${e.title} — ${e.detail ?? "no reason recorded"}`);
    }
  }
  if (report.simulated.length > 0) {
    out.push("SIMULATED — these ran against a mocked or absent capability:");
    for (const e of report.simulated) out.push(`  ${e.title}`);
  }
  if (report.tools.length > 0) {
    out.push(
      `tools: ${report.tools.map((t) => `${t.tool} ×${t.attempts}`).join(", ")}`,
    );
  }
  if (report.conclusion !== undefined) out.push(`why it stopped: ${report.conclusion}`);
  if (report.nextAction !== undefined) out.push(`next: ${report.nextAction}`);
  return out;
}
