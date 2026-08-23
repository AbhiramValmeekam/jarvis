/**
 * The mission model: an objective that outlives a sentence.
 *
 * Everything above this file was turn-shaped — one utterance routed to a local
 * intent or to a single agent turn, and the turn ended. A mission is the
 * opposite: a stated outcome, a plan that is allowed to be wrong, steps that are
 * allowed to fail, and a record of which of those actually happened.
 *
 * Three rules this encodes, and they are why it is a separate file from the
 * orchestrator that drives it:
 *
 *  1. **A step is finished only when something observed it.** `settleStep` takes
 *     an `ActionOutcome` from `runVerified()`, never a boolean, so "the tool
 *     returned" and "the world changed" stay different facts. `unconfirmed` and
 *     `unchecked` land in their own status — `unverified` — which satisfies no
 *     dependency and hands the mission to the replanner. Rounding either up to
 *     `done` is the fake completion this project exists to avoid.
 *  2. **Illegal transitions are reported, not thrown.** Mission events arrive
 *     from a loop racing a cancel button, a permission dialog and a wall-clock
 *     ceiling, so a late `step_ok` after a cancel is ordinary traffic.
 *     `transition` returns a rejection the caller can log, exactly as
 *     `runtime/state-machine.ts` does for conversation state.
 *  3. **Nothing here reads a clock, a disk or a config.** Every timestamp is
 *     passed in. That is what makes an eight-step plan with a failure and a
 *     replan assertable in a unit test rather than only in a probe.
 */
import type { ActionOutcome } from "../permissions/verified-action.js";

/** Where a mission is, as one word. Every mission starts in `planning`. */
export type MissionState =
  | "planning"          // decomposing the objective into steps
  | "retrieving"        // pulling the memory and world facts the plan needs
  | "executing"         // running whichever steps are runnable
  | "verifying"         // a step has acted; its check is running
  | "replanning"        // a step did not verify; deciding what to do instead
  | "waiting_approval"  // a step needs consent the user has not given yet
  | "completed"
  | "failed"
  | "blocked"           // stopped for a reason only the user can clear
  | "cancelled";

/**
 * Mission-level events.
 *
 * Step *starts* are deliberately absent: beginning a step does not change what
 * the mission as a whole is doing, and routing it through the table would make
 * every healthy run emit a self-transition nobody reads.
 */
export type MissionEvent =
  | "planned"           // planning → retrieving, with at least one step
  | "plan_empty"        // nothing could be decomposed — a failure, not a success
  | "retrieved"
  | "verify"            // a step acted; its verifier is running
  | "step_ok"           // that verifier returned `verified`
  | "step_bad"          // it returned anything else
  | "need_approval"
  | "approved"
  | "denied"
  | "replanned"         // corrective steps exist; carry on
  | "replan_exhausted"
  | "ask_user"          // only the user can clear this — not a failure
  | "finish"            // every required step verified
  | "give_up"           // no runnable step left and the objective is not met
  | "cancel"
  | "error";

/**
 * What one step is doing.
 *
 * `unverified` is the status this whole layer is built around: the tool ran, it
 * did not throw, and the check either disagreed (`unconfirmed`) or could not run
 * (`unchecked`). It is neither `done` nor `failed`, it unblocks nothing, and it
 * is displayed in its own words — see `settleStep`.
 */
export type StepStatus =
  | "pending"
  | "awaiting_approval"
  | "running"
  | "done"
  | "unverified"
  | "failed"
  | "skipped"           // a dependency never produced what this step needed
  | "cancelled";

/** Statuses that will never change again without an explicit retry. */
const SETTLED: ReadonlySet<StepStatus> = new Set<StepStatus>([
  "done",
  "unverified",
  "failed",
  "skipped",
  "cancelled",
]);

/** The only status that satisfies a dependency. Nothing weaker counts. */
export function satisfiesDependency(status: StepStatus): boolean {
  return status === "done";
}

export function isStepSettled(status: StepStatus): boolean {
  return SETTLED.has(status);
}

/**
 * One unit of work.
 *
 * `tool` is a registry key, never a command line: what actually runs is decided
 * by `tools/registry.ts` from that key, so a planner — deterministic today, a
 * model in Phase 14 — can name a capability and has no way to name an
 * executable.
 *
 * `args` is not validated here, on purpose. The registry validates against the
 * tool's own schema at call time; a second check in the model would be a second
 * place for a shape to drift.
 */
export interface PlanStep {
  readonly id: string;
  /**
   * One line, already display-safe. Producers that take text from a model, a
   * file or a tool result pass it through `sanitiseForDisplay` first — this
   * field reaches both the log and the renderer.
   */
  readonly title: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Step ids that must be `done` before this one may run. */
  readonly dependsOn: readonly string[];
  /** Lower runs first among the steps runnable at the same moment. */
  readonly priority: number;
  /** A step whose failure the mission survives — a nice-to-have, not the objective. */
  readonly optional: boolean;
  /** `replan` marks a step the replanner added, so the report can count recoveries. */
  readonly origin: "plan" | "replan";
  readonly status: StepStatus;
  /** 1 on the first run. Raised by `retryStep`, and bounded by the orchestrator. */
  readonly attempt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  /** The verifier's verdict. Absent until the step has actually run. */
  readonly outcome?: ActionOutcome;
  /** A short, display-safe account of what the tool produced. Never raw output. */
  readonly result?: string;
  readonly error?: string;
  /**
   * True when the capability behind this step is mocked or absent.
   *
   * It travels with the step onto the wire and into the UI, because a simulated
   * success that looks like a real one is precisely the thing the build rules
   * forbid. Nothing infers this: a tool adapter declares it.
   */
  readonly simulated?: boolean;
  /**
   * What this call classified as, once something has classified it.
   *
   * Absent until the step is prepared, and never filled in with a guess: a level
   * shown before `classify()` computed one would be the field a user weighs a
   * consent decision with, holding a number nothing stands behind. It is recorded
   * here rather than only passed to the permission engine so that the plan graph,
   * the report and the stored record all show the same level the engine judged —
   * one classification, read in four places.
   */
  readonly risk?: { readonly level: number; readonly category: string };
}

/** A fact the mission retrieved before executing, as shown on the retrieval card. */
export interface MissionMemoryRef {
  readonly source: "memory" | "project" | "skill" | "window" | "task" | "profile" | "episode";
  /** Display-safe, and short: this is a citation, not the content. */
  readonly summary: string;
  /**
   * How it was found: `keyword`, `vector`, `both`, `profile`, `recent`.
   *
   * Optional because the older sources (`project`, `window`, `task`) are gathered
   * rather than ranked, and labelling one of those `keyword` would be inventing a
   * search that did not happen.
   */
  readonly method?: string;
}

export interface Mission {
  readonly id: string;
  /** The objective as the user stated it, display-safe. */
  readonly objective: string;
  readonly createdAt: number;
  readonly state: MissionState;
  readonly steps: readonly PlanStep[];
  readonly memory: readonly MissionMemoryRef[];
  /**
   * How the plan was produced. `deterministic` is a first-class answer rather
   * than a degraded one — the offline pipeline runs the same loop, and says so.
   */
  readonly planner: "deterministic" | "llm";
  /** Replans spent across the whole mission, against the orchestrator's ceiling. */
  readonly replans: number;
  readonly finishedAt?: number;
  /** Why a `completed`/`failed`/`blocked`/`cancelled` mission stopped, in words. */
  readonly conclusion?: string;
}

// --- state machine ---------------------------------------------------------

/** Legal transitions. Anything absent is rejected and reported. */
const TRANSITIONS: Record<MissionState, Partial<Record<MissionEvent, MissionState>>> = {
  planning: {
    planned: "retrieving",
    // An objective nothing could be decomposed from fails here rather than
    // running to `completed` with an empty plan, which would report success for
    // having understood nothing.
    plan_empty: "failed",
    cancel: "cancelled",
    error: "failed",
  },
  retrieving: {
    retrieved: "executing",
    cancel: "cancelled",
    error: "failed",
  },
  executing: {
    verify: "verifying",
    // A step can be settled badly without a verifier ever running: the registry
    // rejects the call for its arguments, or names no such tool. Routing that
    // through `verify` would claim a check happened, so it goes straight to
    // `replanning` — which is also what lets a Phase 14 replanner repair
    // arguments rather than the loop discarding the step here.
    step_bad: "replanning",
    need_approval: "waiting_approval",
    finish: "completed",
    give_up: "failed",
    cancel: "cancelled",
    error: "failed",
  },
  verifying: {
    // Deliberately no `finish`: a verified last step returns to `executing`,
    // where the loop re-reads the plan and decides. One place decides that the
    // objective is met, and it is not the step that happened to be last.
    step_ok: "executing",
    step_bad: "replanning",
    cancel: "cancelled",
    error: "failed",
  },
  replanning: {
    replanned: "executing",
    replan_exhausted: "failed",
    // The replanner concluded that the next move is the user's: which project it
    // was, or a `git config` line only they can run. `blocked` is that state, and
    // reporting it as `failed` would say the mission cannot be finished when what
    // is true is that it cannot be finished *alone*.
    ask_user: "blocked",
    give_up: "failed",
    cancel: "cancelled",
    error: "failed",
  },
  waiting_approval: {
    approved: "executing",
    // A refusal is an outcome, not an error. `blocked` says the mission stopped
    // for a reason only the user can clear.
    denied: "blocked",
    cancel: "cancelled",
    error: "failed",
  },
  completed: {},
  failed: {},
  blocked: {},
  cancelled: {},
};

export const TERMINAL_STATES: ReadonlySet<MissionState> = new Set<MissionState>([
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);

export function isTerminal(state: MissionState): boolean {
  return TERMINAL_STATES.has(state);
}

export type TransitionResult =
  | {
      readonly ok: true;
      readonly mission: Mission;
      readonly from: MissionState;
      readonly to: MissionState;
      readonly event: MissionEvent;
    }
  | {
      readonly ok: false;
      readonly mission: Mission;
      readonly from: MissionState;
      readonly event: MissionEvent;
      readonly reason: string;
    };

/**
 * Apply a mission event, returning a new mission or a rejection.
 *
 * The rejected case carries the mission back unchanged, so a caller that logs
 * the reason and carries on cannot accidentally drop the state it was holding.
 *
 * Reaching a terminal state closes out the steps that were still moving:
 * `running` and `awaiting_approval` become `cancelled`, because a step shown as
 * running after its mission stopped is a lie the UI would keep telling. Steps
 * still `pending` are left alone — "never attempted" is the true account of
 * them, and the report says so.
 */
export function transition(
  mission: Mission,
  event: MissionEvent,
  detail: { readonly at: number; readonly conclusion?: string },
): TransitionResult {
  const from = mission.state;
  const to = TRANSITIONS[from][event];
  if (to === undefined) {
    const reason = isTerminal(from)
      ? `mission is already ${from}`
      : `${event} is not legal in ${from}`;
    return { ok: false, mission, from, event, reason };
  }

  const steps = isTerminal(to)
    ? mission.steps.map((s) =>
        s.status === "running" || s.status === "awaiting_approval"
          ? { ...s, status: "cancelled" as StepStatus, finishedAt: detail.at }
          : s,
      )
    : mission.steps;

  const next: Mission = {
    ...mission,
    state: to,
    steps,
    ...(isTerminal(to) ? { finishedAt: detail.at } : {}),
    ...(detail.conclusion !== undefined ? { conclusion: detail.conclusion } : {}),
  };
  return { ok: true, mission: next, from, to, event };
}

// --- constructors ----------------------------------------------------------

export interface StepInput {
  readonly id: string;
  readonly title: string;
  readonly tool: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly dependsOn?: readonly string[];
  readonly priority?: number;
  readonly optional?: boolean;
  readonly origin?: "plan" | "replan";
  readonly simulated?: boolean;
}

/** A pending step with the defaults filled in. The only way steps are made. */
export function makeStep(input: StepInput): PlanStep {
  return {
    id: input.id,
    title: input.title,
    tool: input.tool,
    args: input.args ?? {},
    dependsOn: input.dependsOn ?? [],
    priority: input.priority ?? 100,
    optional: input.optional ?? false,
    origin: input.origin ?? "plan",
    status: "pending",
    attempt: 1,
    ...(input.simulated ? { simulated: true } : {}),
  };
}

export function createMission(input: {
  readonly id: string;
  readonly objective: string;
  readonly at: number;
  readonly planner?: "deterministic" | "llm";
}): Mission {
  return {
    id: input.id,
    objective: input.objective,
    createdAt: input.at,
    state: "planning",
    steps: [],
    memory: [],
    planner: input.planner ?? "deterministic",
    replans: 0,
  };
}

/** Install the plan. Called once, while the mission is still `planning`. */
export function setPlan(mission: Mission, steps: readonly PlanStep[]): Mission {
  return { ...mission, steps };
}

/** Record what retrieval found — including nothing, which is also a fact. */
export function setMemory(mission: Mission, memory: readonly MissionMemoryRef[]): Mission {
  return { ...mission, memory };
}

// --- step reducers ---------------------------------------------------------

/**
 * Replace one step, by id.
 *
 * A missing id returns the mission untouched rather than throwing. Step ids come
 * from a planner, and in Phase 14 that planner is a model; a corrective step
 * naming an id that no longer exists must be a no-op the orchestrator can notice
 * and report, not a crash in the always-on process.
 */
function mapStep(
  mission: Mission,
  id: string,
  fn: (step: PlanStep) => PlanStep,
): Mission {
  let touched = false;
  const steps = mission.steps.map((s) => {
    if (s.id !== id) return s;
    touched = true;
    return fn(s);
  });
  return touched ? { ...mission, steps } : mission;
}

export function findStep(mission: Mission, id: string): PlanStep | undefined {
  return mission.steps.find((s) => s.id === id);
}

/** `pending` or `awaiting_approval` → `running`. Anything else is left alone. */
export function startStep(mission: Mission, id: string, at: number): Mission {
  return mapStep(mission, id, (s) =>
    s.status === "pending" || s.status === "awaiting_approval"
      ? { ...s, status: "running", startedAt: at }
      : s,
  );
}

/** The step is parked on a consent dialog. It holds no CPU while it waits. */
export function awaitApproval(mission: Mission, id: string): Mission {
  return mapStep(mission, id, (s) =>
    s.status === "pending" || s.status === "running"
      ? { ...s, status: "awaiting_approval" }
      : s,
  );
}

/**
 * Record what a step classified as.
 *
 * Write-once per attempt, and the classification is taken whole from the caller
 * rather than assembled here: this file has no risk model and must not grow one,
 * or there would be two answers to "how dangerous is this" and the harmless one
 * would be the one on screen. A retry re-classifies, because a corrective step
 * may have changed what the arguments now point at.
 */
export function classifyStep(
  mission: Mission,
  id: string,
  risk: { readonly level: number; readonly category: string },
): Mission {
  return mapStep(mission, id, (s) => ({
    ...s,
    risk: { level: risk.level, category: risk.category },
  }));
}

/**
 * The status an outcome earns. This mapping is the whole point of the file.
 *
 * Only `verified` is `done`. `failed` is the action failing. `unconfirmed` and
 * `unchecked` are two different ways of not knowing, and both land in
 * `unverified`, which satisfies no dependency — so a plan cannot advance on the
 * strength of a step nobody confirmed.
 */
export function statusForOutcome(outcome: ActionOutcome): StepStatus {
  switch (outcome) {
    case "verified":
      return "done";
    case "failed":
      return "failed";
    case "unconfirmed":
    case "unchecked":
      return "unverified";
  }
}

export interface StepResult {
  readonly outcome: ActionOutcome;
  readonly at: number;
  /** Short and display-safe. The tool's own account, trimmed by the adapter. */
  readonly result?: string;
  readonly error?: string;
  readonly simulated?: boolean;
}

/** Settle a step from a verifier's verdict. The only way a step becomes `done`. */
export function applyStepResult(mission: Mission, id: string, r: StepResult): Mission {
  return mapStep(mission, id, (s) => ({
    ...s,
    status: statusForOutcome(r.outcome),
    outcome: r.outcome,
    finishedAt: r.at,
    ...(s.startedAt === undefined ? { startedAt: r.at } : {}),
    ...(r.result !== undefined ? { result: r.result } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
    ...(r.simulated ? { simulated: true } : {}),
  }));
}

/**
 * Put a settled-but-unsuccessful step back in the queue, one attempt later.
 *
 * The previous `error` and `outcome` are kept, not cleared: the report counts
 * recoveries, and a retry that erased the failure it recovered from would leave
 * a mission that looks as though it went right the first time.
 */
export function retryStep(mission: Mission, id: string): Mission {
  return mapStep(mission, id, (s) =>
    s.status === "failed" || s.status === "unverified"
      ? { ...s, status: "pending", attempt: s.attempt + 1 }
      : s,
  );
}

/** Give up on one step without failing the mission. Records why, in words. */
export function skipStep(mission: Mission, id: string, reason: string, at: number): Mission {
  return mapStep(mission, id, (s) =>
    isStepSettled(s.status)
      ? s
      : { ...s, status: "skipped", finishedAt: at, error: reason },
  );
}

/**
 * Append corrective steps and charge the mission one replan.
 *
 * The counter lives on the mission rather than being derived from
 * `origin === "replan"`, because a replan that produced *no* usable step is
 * still a replan spent — and that is exactly the case the ceiling exists to
 * stop from looping.
 */
export function addCorrectiveSteps(mission: Mission, steps: readonly PlanStep[]): Mission {
  return {
    ...mission,
    replans: mission.replans + 1,
    steps: [...mission.steps, ...steps.map((s) => ({ ...s, origin: "replan" as const }))],
  };
}

// --- queries ---------------------------------------------------------------

/**
 * The steps that could run right now, best first.
 *
 * A dependency counts only when it is `done` — `unverified` does not unblock
 * anything, which is what stops a plan from building on a step nobody confirmed.
 * A dependency id that matches no step blocks its dependant for good; see
 * `unreachableSteps`, which is where that shows up as a reportable condition
 * rather than as a step that silently never runs.
 *
 * Ordered by `priority` and then by position in the plan, so a plan is executed
 * in the order it reads. Ties are not broken arbitrarily: a stable order is what
 * makes a probe's output the same twice.
 */
export function nextRunnableSteps(mission: Mission): readonly PlanStep[] {
  const done = new Set(
    mission.steps.filter((s) => satisfiesDependency(s.status)).map((s) => s.id),
  );
  return mission.steps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        step.status === "pending" && step.dependsOn.every((id) => done.has(id)),
    )
    .sort((a, b) => a.step.priority - b.step.priority || a.index - b.index)
    .map(({ step }) => step);
}

/** Steps that have started and not settled — what the mission is doing now. */
export function inFlightSteps(mission: Mission): readonly PlanStep[] {
  return mission.steps.filter(
    (s) => s.status === "running" || s.status === "awaiting_approval",
  );
}

/**
 * Pending steps that can never run.
 *
 * A step is unreachable when a dependency settled without succeeding, names an
 * id no step has, or is itself unreachable — computed to a fixpoint, so one
 * failure at the root of a chain reports the whole chain rather than one step at
 * a time across several loop turns.
 *
 * Steps in a dependency *cycle* are not returned here: none of them ever settled
 * badly, so nothing about them is unreachable by this rule. They are caught by
 * `isStalled`, which asks the blunter question — is anything still able to move?
 */
export function unreachableSteps(mission: Mission): readonly PlanStep[] {
  const byId = new Map(mission.steps.map((s) => [s.id, s]));
  const dead = new Set<string>();
  for (const s of mission.steps) {
    if (isStepSettled(s.status) && !satisfiesDependency(s.status)) dead.add(s.id);
  }
  for (;;) {
    let grew = false;
    for (const s of mission.steps) {
      if (s.status !== "pending" || dead.has(s.id)) continue;
      const doomed = s.dependsOn.some((id) => dead.has(id) || !byId.has(id));
      if (doomed) {
        dead.add(s.id);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return mission.steps.filter((s) => s.status === "pending" && dead.has(s.id));
}

/** Nothing runnable and nothing in flight: the loop has no move left to make. */
export function isStalled(mission: Mission): boolean {
  return nextRunnableSteps(mission).length === 0 && inFlightSteps(mission).length === 0;
}

/**
 * Is the objective met?
 *
 * Every required step `done`, and nothing left that might still change that — no
 * step running, waiting on consent, or merely runnable. That last clause is why
 * an optional step still in the queue keeps the mission open: it was planned, it
 * can run, and finishing early would quietly drop work the plan called for.
 *
 * An optional step that *failed* does not spoil the objective; a required step
 * that came back `unverified` does. That is the difference between this question
 * and asking whether the loop has run out of things to do.
 */
export function isObjectiveMet(mission: Mission): boolean {
  const required = mission.steps.filter((s) => !s.optional);
  if (required.length === 0) return false;
  return (
    required.every((s) => satisfiesDependency(s.status)) &&
    inFlightSteps(mission).length === 0 &&
    nextRunnableSteps(mission).length === 0
  );
}

export interface StepCounts {
  readonly total: number;
  readonly done: number;
  readonly unverified: number;
  readonly failed: number;
  readonly skipped: number;
  readonly cancelled: number;
  readonly pending: number;
  readonly running: number;
  readonly awaitingApproval: number;
  /** Steps the replanner added, i.e. how many times the plan changed shape. */
  readonly corrective: number;
  /** Steps whose capability was mocked or absent. Shown, never hidden. */
  readonly simulated: number;
}

export function stepCounts(mission: Mission): StepCounts {
  const by = (s: StepStatus): number => mission.steps.filter((x) => x.status === s).length;
  return {
    total: mission.steps.length,
    done: by("done"),
    unverified: by("unverified"),
    failed: by("failed"),
    skipped: by("skipped"),
    cancelled: by("cancelled"),
    pending: by("pending"),
    running: by("running"),
    awaitingApproval: by("awaiting_approval"),
    corrective: mission.steps.filter((s) => s.origin === "replan").length,
    simulated: mission.steps.filter((s) => s.simulated === true).length,
  };
}
