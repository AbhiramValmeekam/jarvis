/**
 * Missions, projected onto the wire.
 *
 * The model's types are internal and free to change; `ipc/contract.ts`'s are a
 * contract. This is the one place that turns one into the other, and it is a file
 * of its own — not a method on the runtime — because what it *omits* is a security
 * property and a property is worth being able to test without a pipe.
 *
 * What it omits, and why:
 *
 *  - **`args` never travel.** A step's arguments are where a path, a command line
 *    and (in Phase 14, from a model) an arbitrary string live. A plan graph needs
 *    the title, the tool and the status to draw itself; nothing in a renderer needs
 *    the payload, and a view that quoted it would eventually quote something that
 *    should not have left this process (§53).
 *  - **Nothing is added.** Every field here is copied or counted from the mission's
 *    own record. There is no "probably fine", no derived success, and no default
 *    that would make an unfinished mission read as a finished one (§43).
 *
 * The strings are already display-safe when they arrive: the model requires it of
 * `title` and `objective`, the registry sanitises tool output, and the report
 * composes its own text. They are passed through `sanitiseForDisplay` again here
 * anyway, because "already safe" is an argument about upstream code and this is the
 * last function before the pipe.
 */
import type {
  MissionCountsView,
  MissionDetailView,
  MissionMemoryView,
  MissionReportEntryView,
  MissionReportView,
  MissionStepView,
  MissionView,
  TraceEntryView,
  TraceView,
  VisionProposalView,
} from "../ipc/contract.js";
import { redactSecrets } from "../context/window-facts.js";
import { sanitiseForDisplay } from "../permissions/risk-model.js";
import { isTerminal, stepCounts, type Mission, type PlanStep } from "./mission-model.js";
import { MAX_OBSERVED, type VisionOutcome } from "./vision-objective.js";
import { buildReport, type MissionReport, type ReportEntry } from "./mission-report.js";
import type { Trace, TraceEntry, TraceGap } from "./trace.js";

/** Same ceiling the report uses. One line, in a pane that is not a log viewer. */
const MAX_LINE = 200;

/**
 * One flat line, screened first.
 *
 * Nearly everything projected through here is program output — a step's `detail` is a
 * command's stderr tail, a mission's conclusion is the reason a step stopped — so a build
 * that printed a token would otherwise send it to every attached window. Redaction
 * runs before `sanitiseForDisplay` for the reason `toWindowFacts` gives: truncating or
 * stripping first can rejoin a key that was split, and then no pattern matches it.
 *
 * It is best-effort, and the rest of the design says so: arguments never cross at all,
 * and a secret shaped like a sentence survives this.
 */
function line(text: string, max: number = MAX_LINE): string {
  return sanitiseForDisplay(redactSecrets(text).text, max);
}

/**
 * One step, without its arguments.
 *
 * `detail` is the result or the error — whichever the record holds — because a
 * step has at most one of them and the view shows one line either way. Which of
 * the two it is stays legible from `status` and `outcome`, so collapsing them
 * loses nothing a reader needs.
 */
export function toMissionStepView(step: PlanStep): MissionStepView {
  const detail = step.error !== undefined && step.error.trim() !== "" ? step.error : step.result;
  return {
    id: step.id,
    title: line(step.title),
    tool: step.tool,
    status: step.status,
    attempt: step.attempt,
    origin: step.origin,
    priority: step.priority,
    optional: step.optional,
    dependsOn: [...step.dependsOn],
    ...(step.outcome !== undefined ? { outcome: step.outcome } : {}),
    ...(detail !== undefined && detail.trim() !== "" ? { detail: line(detail) } : {}),
    ...(step.simulated === true ? { simulated: true } : {}),
    ...(step.risk !== undefined
      ? { risk: { level: step.risk.level, category: line(step.risk.category) } }
      : {}),
    ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
    ...(step.finishedAt !== undefined ? { finishedAt: step.finishedAt } : {}),
  };
}

function toCounts(mission: Mission): MissionCountsView {
  const c = stepCounts(mission);
  return {
    total: c.total,
    done: c.done,
    unverified: c.unverified,
    failed: c.failed,
    skipped: c.skipped,
    cancelled: c.cancelled,
    pending: c.pending,
    running: c.running,
    awaitingApproval: c.awaitingApproval,
    corrective: c.corrective,
    simulated: c.simulated,
  };
}

function toMemory(mission: Mission): MissionMemoryView[] {
  return mission.memory.map((m) => ({
    source: m.source,
    summary: line(m.summary),
    ...(m.method === undefined ? {} : { method: m.method }),
  }));
}

export function toMissionView(mission: Mission): MissionView {
  return {
    id: mission.id,
    objective: line(mission.objective),
    state: mission.state,
    // Sent rather than left to the client to work out from `state`. Two clients
    // deriving "is it over" from a string list would be two places that have to
    // learn about a new state, and one of them would not.
    terminal: isTerminal(mission.state),
    createdAt: mission.createdAt,
    planner: mission.planner,
    replans: mission.replans,
    counts: toCounts(mission),
    steps: mission.steps.map(toMissionStepView),
    memory: toMemory(mission),
    ...(mission.finishedAt !== undefined ? { finishedAt: mission.finishedAt } : {}),
    ...(mission.conclusion !== undefined ? { conclusion: line(mission.conclusion) } : {}),
  };
}

function toReportEntry(entry: ReportEntry): MissionReportEntryView {
  return {
    id: entry.id,
    title: line(entry.title),
    tool: entry.tool,
    attempt: entry.attempt,
    ...(entry.detail !== undefined ? { detail: line(entry.detail) } : {}),
    ...(entry.simulated === true ? { simulated: true } : {}),
  };
}

export function toMissionReportView(report: MissionReport): MissionReportView {
  return {
    missionId: report.missionId,
    objective: line(report.objective),
    state: report.state,
    headline: line(report.headline),
    durationMs: report.durationMs,
    counts: { ...report.counts },
    planner: report.planner,
    replans: report.replans,
    recovered: report.recovered.map(toReportEntry),
    verified: report.verified.map(toReportEntry),
    outstanding: report.outstanding.map(toReportEntry),
    simulated: report.simulated.map(toReportEntry),
    tools: report.tools.map((t) => ({ ...t })),
    memory: report.memory.map((m) => ({ source: m.source, summary: line(m.summary) })),
    ...(report.conclusion !== undefined ? { conclusion: line(report.conclusion) } : {}),
    ...(report.nextAction !== undefined ? { nextAction: line(report.nextAction) } : {}),
  };
}

/**
 * A mission and its report in one answer.
 *
 * They travel together because they are one question — "show me that mission" —
 * and because building the report here rather than in the renderer keeps the
 * arithmetic in the one place that has the record. `now` is only consulted for a
 * mission that has not finished; a terminal one reports the same duration
 * tomorrow.
 */
export function toMissionDetailView(mission: Mission, now?: number): MissionDetailView {
  return {
    mission: toMissionView(mission),
    report: toMissionReportView(buildReport(mission, now)),
  };
}

/**
 * A trace, projected onto the wire.
 *
 * The same discipline as everything above, and one addition worth naming: `voice` is
 * carried rather than resolved. It would be simpler to prefix a model-authored `because`
 * with "the model said" here and drop the flag, and it would be wrong — the renderer
 * would then have no way to tell a quotation from a sentence that happened to begin with
 * those words, and the marking would be a string a future edit could lose. A flag can be
 * checked; a prefix can only be read.
 *
 * `gap` and `entries` are mutually exclusive in practice but not in the type, because the
 * honest shape of a truncated-and-empty log is both a count and a reason.
 */
export function toTraceView(trace: Trace, gap?: TraceGap | null): TraceView {
  return {
    missionId: trace.missionId,
    objective: line(trace.objective),
    state: trace.state,
    entries: trace.entries.map(toTraceEntry),
    roles: trace.roles.map((r) => ({
      role: r.role,
      label: r.label,
      purpose: r.purpose,
      actions: r.actions,
      engaged: r.engaged,
    })),
    lines: trace.lines,
    omitted: trace.omitted,
    ...(gap ? { gap: line(gap.reason) } : {}),
  };
}

function toTraceEntry(entry: TraceEntry): TraceEntryView {
  return {
    seq: entry.seq,
    at: entry.at,
    role: entry.role,
    action: line(entry.action),
    because: line(entry.because),
    ...(entry.stepId !== undefined ? { stepId: entry.stepId } : {}),
    ...(entry.stepTitle !== undefined ? { stepTitle: line(entry.stepTitle) } : {}),
    ...(entry.tool !== undefined ? { tool: entry.tool } : {}),
    ...(entry.outcome !== undefined ? { outcome: entry.outcome } : {}),
    ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
    ...(entry.risk !== undefined
      ? { risk: { level: entry.risk.level, category: entry.risk.category } }
      : {}),
    ...(entry.voice !== undefined ? { voice: entry.voice } : {}),
    ...(entry.simulated !== undefined ? { simulated: entry.simulated } : {}),
  };
}

/**
 * One look at the screen, projected onto the wire.
 *
 * Here rather than in `vision-objective.ts` for the reason this whole file exists: the
 * projection is where the omissions live, and the omission that matters is a big one.
 * `VisionOutcome` is produced from a screenshot of the user's desktop, and what crosses
 * is a model's two sentences about it — the picture is dropped inside `proposeFromScreen`
 * and there is no frame in the protocol that could carry it.
 *
 * Both strings go through `line`, which redacts before it flattens. That is not
 * belt-and-braces here the way it is for a mission title: `observed` is a description of
 * whatever was visible, so an API key in an editor or a token in a terminal is not an
 * unlikely thing for it to contain — it is the most likely secret in this system to be
 * written down, because a screenshot does not care what window was open. `oneLine` in
 * `vision-objective.ts` has already redacted it once, before the objective was ever
 * stored; this runs on the way out, which is where the guarantee has to hold.
 *
 * `observed` keeps its own ceiling rather than the 200 the rest of this file uses. It is
 * the field a person reads to decide whether the model looked at the right window, and a
 * proposal checked against two thirds of a description is checked against less than was
 * seen.
 */
export function toVisionProposalView(
  outcome: VisionOutcome,
  source: "voice" | "window",
  at: number,
): VisionProposalView {
  if (outcome.kind === "refused") {
    return { kind: "refused", at, source, refusal: outcome.refusal, speech: line(outcome.speech) };
  }
  return {
    kind: "proposed",
    at,
    source,
    observed: line(outcome.proposal.observed, MAX_OBSERVED),
    objective: line(outcome.proposal.objective),
    model: line(outcome.model, 60),
    ms: outcome.ms,
    bytes: outcome.bytes,
  };
}
