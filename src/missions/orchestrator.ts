/**
 * The loop that owns an objective.
 *
 * Plan, retrieve, then one step at a time: classify it, ask if the level says to
 * ask, run it through the registry, settle it from the verifier's verdict, and on
 * anything short of `verified` hand it to the replanner. It ends in one of four
 * terminal states and it always ends — that last property is the reason most of
 * this file exists.
 *
 * **Serial, deliberately.** `nextRunnableSteps` returns everything runnable and
 * this takes the first. Three reasons, in order of how much they matter: two
 * permission dialogs racing each other is a consent bug; a corrective step that
 * must run *before* the retry it fixes is ordered by priority, which only holds if
 * one step runs at a time; and a mission that executes in the order it reads is a
 * mission a probe can assert against. Parallelism here would buy wall-clock on
 * `npm test` and cost all three.
 *
 * **Four ceilings, and none of them is negotiable by a rule.** Steps executed,
 * replans spent, attempts per step, and wall clock. An always-on process cannot
 * have a loop whose exit depends on a tool eventually behaving.
 *
 * **What this file does not decide.** Whether a step may run is
 * `PermissionEngine`'s answer, from a classification the registry computed —
 * nothing here can lower a level. Whether a step succeeded is `runVerified`'s
 * answer, reached inside the adapter. What to do about a failure is the
 * replanner's. This is the thing that asks in the right order and records what
 * came back, which is why it can be read end to end.
 */
import { sanitiseForDisplay, type RiskLevel } from "../permissions/risk-model.js";
import type { PermissionEngine } from "../permissions/permission-engine.js";
import type { ProjectEntry } from "../context/project-registry.js";
import type { ToolRegistry, ToolRun } from "../tools/registry.js";
import {
  addCorrectiveSteps,
  applyStepResult,
  awaitApproval,
  classifyStep,
  createMission,
  findStep,
  isObjectiveMet,
  isTerminal,
  makeStep,
  nextRunnableSteps,
  retryStep,
  setMemory,
  setPlan,
  skipStep,
  startStep,
  stepCounts,
  transition,
  unreachableSteps,
  type Mission,
  type MissionEvent,
  type MissionMemoryRef,
  type PlanStep,
} from "./mission-model.js";
import type { Planner } from "./plan-builder.js";
import type { Remedy, RemedyVoice, Replanner } from "./replanner.js";

export interface MissionLimits {
  /** Step *executions*, which is not the plan's length — retries count. */
  readonly maxSteps: number;
  /** Replans per mission, whatever they were spent on. */
  readonly maxReplans: number;
  /** Attempts per step, counting the first. */
  readonly maxAttempts: number;
  /** Wall clock from the first event to the last. */
  readonly wallClockMs: number;
}

export const DEFAULT_MISSION_LIMITS: MissionLimits = {
  maxSteps: 24,
  maxReplans: 4,
  maxAttempts: 2,
  wallClockMs: 10 * 60_000,
};

/**
 * The level at which the UI is told a mission is parked on a question.
 *
 * Display only. `PermissionEngine` decides, and it may allow a level-2 call from
 * a grant without asking anything — in which case this transition is followed
 * immediately by `approved`. Guessing low here would be the harmful direction: a
 * dialog the mission never announced.
 */
const ANNOUNCE_APPROVAL_FROM: RiskLevel = 2;

/**
 * One thing that happened, as the runtime broadcasts it.
 *
 * The whole mission travels with every update rather than a delta. A renderer
 * that reconnects mid-mission then has the truth from the first message it sees,
 * and the projection into wire types is `ipc/contract.ts`'s job, not this file's.
 */
export interface MissionUpdate {
  readonly mission: Mission;
  readonly at: number;
  /** The mission-level event, when this update is one. */
  readonly event?: MissionEvent;
  /** The step this update is about, when it is about one. */
  readonly step?: PlanStep;
  /** One display-safe line: the planner's note, a remedy's reason, a refusal. */
  readonly note?: string;
  /**
   * Set only when `note` is a model's own sentence rather than one composed here.
   *
   * Every other note on this type is built from counted facts — `llm-planner.ts` says so
   * in its own rules — and a replan diagnosis is the one exception. It is carried rather
   * than prefixed so the page can say whose words these are without editing them, and
   * nothing in the loop reads it (`RemedyVoice`).
   */
  readonly voice?: RemedyVoice;
}

export type MissionObserver = (update: MissionUpdate) => void;

export interface OrchestratorDeps {
  readonly registry: ToolRegistry;
  readonly planner: Planner;
  readonly replanner: Replanner;
  /** The decider. Nothing in this file can allow what the engine denies. */
  readonly permissions: PermissionEngine;
  /** Read at plan time, so a project cloned after boot is planned against. */
  readonly projects: () => readonly ProjectEntry[];
  /** The only directories tools may touch. From config, never from a step. */
  readonly roots: () => readonly string[];
  /**
   * What the mission should know before it starts.
   *
   * Optional, and a failure here is not a failed mission: memory makes a plan
   * better informed and its absence makes it uninformed, not wrong. Phase 16
   * replaces this with relevance-ranked retrieval behind the same signature.
   */
  readonly retrieve?: (objective: string) => Promise<readonly MissionMemoryRef[]>;
  readonly now: () => number;
  readonly log?: (line: string) => void;
  readonly observe?: MissionObserver;
  readonly limits?: Partial<MissionLimits>;
}

/** A mission id, and the flag a cancel sets. */
interface Live {
  readonly id: string;
  cancelled: boolean;
}

function line(text: string): string {
  return sanitiseForDisplay(text, 200);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class MissionOrchestrator {
  private readonly limits: MissionLimits;
  private readonly live = new Map<string, Live>();
  private counter = 0;

  constructor(private readonly deps: OrchestratorDeps) {
    this.limits = { ...DEFAULT_MISSION_LIMITS, ...deps.limits };
  }

  /** Ids of the missions running right now. Empty when the loop costs nothing. */
  running(): readonly string[] {
    return [...this.live.keys()];
  }

  isRunning(id: string): boolean {
    return this.live.has(id);
  }

  /**
   * Ask a mission to stop.
   *
   * Sets a flag the loop reads at each step boundary rather than tearing anything
   * down: a step already inside a tool is finished and recorded, because a
   * `npm ci` abandoned half-way is worse for the user than one that completes and
   * is then reported. Returns false for a mission that is not running.
   */
  cancel(id: string): boolean {
    const live = this.live.get(id);
    if (live === undefined) return false;
    live.cancelled = true;
    return true;
  }

  private nextId(at: number): string {
    this.counter += 1;
    return `m${at.toString(36)}-${this.counter}`;
  }

  async run(objective: string, opts: { readonly id?: string } = {}): Promise<Mission> {
    const at = this.deps.now();
    const id = opts.id ?? this.nextId(at);
    const live: Live = { id, cancelled: false };
    this.live.set(id, live);
    try {
      return await this.execute(objective, id, live, at);
    } finally {
      // Whatever happened, this mission is no longer running. An id left in the
      // map would report a busy orchestrator forever after one thrown adapter.
      this.live.delete(id);
    }
  }

  private emit(update: MissionUpdate): void {
    try {
      this.deps.observe?.(update);
    } catch (err) {
      // An observer is a listener, not a participant. A renderer that throws
      // while rendering must not decide the mission's outcome.
      this.deps.log?.(`mission observer threw: ${message(err)}`);
    }
  }

  /**
   * Apply an event, emit what came of it, and return the mission either way.
   *
   * An illegal transition is logged and dropped rather than thrown, which is the
   * same choice `runtime/state-machine.ts` makes: the caller keeps the state it
   * was holding, and the loop's own `nothing moved` guard is what stops a rejected
   * event from becoming a spin.
   */
  private advance(
    mission: Mission,
    event: MissionEvent,
    detail: {
      readonly at: number;
      readonly conclusion?: string;
      readonly step?: PlanStep;
      readonly note?: string;
      readonly voice?: RemedyVoice;
    },
  ): Mission {
    const result = transition(mission, event, {
      at: detail.at,
      ...(detail.conclusion !== undefined ? { conclusion: line(detail.conclusion) } : {}),
    });
    if (!result.ok) {
      this.deps.log?.(`mission ${mission.id}: ${result.reason}`);
      return mission;
    }
    this.emit({
      mission: result.mission,
      at: detail.at,
      event,
      ...(detail.step !== undefined ? { step: detail.step } : {}),
      ...(detail.note !== undefined ? { note: line(detail.note) } : {}),
      ...(detail.voice !== undefined ? { voice: detail.voice } : {}),
    });
    return result.mission;
  }

  private async execute(
    objective: string,
    id: string,
    live: Live,
    startedAt: number,
  ): Promise<Mission> {
    const deadline = startedAt + this.limits.wallClockMs;
    let mission = createMission({ id, objective: sanitiseForDisplay(objective, 400), at: startedAt });
    this.emit({ mission, at: startedAt });

    const tools = (): readonly string[] => this.deps.registry.list().map((t) => t.name);

    let plan;
    try {
      plan = await this.deps.planner.plan({
        objective,
        projects: this.deps.projects(),
        tools: tools(),
      });
    } catch (err) {
      return this.advance(mission, "error", {
        at: this.deps.now(),
        conclusion: `planning failed: ${message(err)}`,
      });
    }

    // An objective nothing could be decomposed from is a failure with a reason,
    // not a mission that runs to `completed` having understood nothing.
    if (plan.steps.length === 0) {
      return this.advance(mission, "plan_empty", {
        at: this.deps.now(),
        conclusion: plan.note,
        note: plan.note,
      });
    }

    mission = { ...setPlan(mission, plan.steps.map(makeStep)), planner: plan.planner };
    mission = this.advance(mission, "planned", { at: this.deps.now(), note: plan.note });
    if (mission.state !== "retrieving") return mission;

    mission = await this.retrieve(mission, objective);
    if (mission.state !== "executing") return mission;

    return this.loop(mission, live, deadline);
  }

  /**
   * Pull what the mission should know, and carry on if that fails.
   *
   * A memory lookup that throws leaves the mission uninformed, not wrong, so it is
   * recorded as a note and the plan proceeds. Failing the objective because the
   * memory file was locked would be the wrong trade every time.
   */
  private async retrieve(mission: Mission, objective: string): Promise<Mission> {
    let memory: readonly MissionMemoryRef[] = [];
    let note: string | undefined;
    if (this.deps.retrieve !== undefined) {
      try {
        memory = await this.deps.retrieve(objective);
      } catch (err) {
        note = `memory lookup failed: ${message(err)}`;
      }
    }
    const counted = `${memory.length} fact${memory.length === 1 ? "" : "s"} retrieved`;
    return this.advance(setMemory(mission, memory), "retrieved", {
      at: this.deps.now(),
      note: note ?? counted,
    });
  }

  private async loop(start: Mission, live: Live, deadline: number): Promise<Mission> {
    let mission = start;
    let executed = 0;

    for (;;) {
      if (live.cancelled) {
        return this.advance(mission, "cancel", {
          at: this.deps.now(),
          conclusion: "you cancelled this mission",
        });
      }

      const now = this.deps.now();
      if (now >= deadline) {
        const minutes = Math.max(1, Math.round(this.limits.wallClockMs / 60_000));
        return this.advance(mission, "give_up", {
          at: now,
          conclusion: `this ran past its ${minutes}-minute ceiling and stopped where it was`,
        });
      }

      // A pending step whose dependency failed is reported as skipped rather than
      // left in the queue looking like work still to come.
      const dead = unreachableSteps(mission);
      if (dead.length > 0) {
        for (const s of dead) {
          mission = skipStep(mission, s.id, "a step it depended on did not succeed", now);
        }
        this.emit({
          mission,
          at: now,
          note: `${dead.length} step${dead.length === 1 ? "" : "s"} can no longer run`,
        });
        continue;
      }

      if (isObjectiveMet(mission)) {
        return this.advance(mission, "finish", {
          at: now,
          conclusion: "every required step verified",
        });
      }

      const next = nextRunnableSteps(mission)[0];
      if (next === undefined) {
        return this.advance(mission, "give_up", { at: now, conclusion: whyStuck(mission) });
      }

      if (executed >= this.limits.maxSteps) {
        return this.advance(mission, "give_up", {
          at: now,
          conclusion: `this mission has already run ${executed} steps, which is as far as it goes on its own`,
        });
      }
      executed += 1;

      const before = mission;
      mission = await this.runStep(mission, next, live);
      if (isTerminal(mission.state)) return mission;
      // Nothing moved. Either the model refused an event or a step came back in
      // the state it went in, and continuing would be a spin — the one failure
      // mode a loop in an always-on process must not have.
      if (mission === before) {
        return this.advance(mission, "error", {
          at: this.deps.now(),
          conclusion: `${next.title} left the mission exactly as it was, so the loop stopped rather than repeating it`,
        });
      }
    }
  }

  /**
   * One step, from classification to a settled status.
   *
   * The order is the point: validate, classify, ask, run, verify, record. Nothing
   * runs before the engine has answered, and nothing is `done` before a verifier
   * has said so.
   */
  private async runStep(start: Mission, step: PlanStep, live: Live): Promise<Mission> {
    const stepId = step.id;
    let mission = startStep(start, stepId, this.deps.now());
    this.emit({ mission, at: this.deps.now(), step: findStep(mission, stepId) });

    const prepared = this.deps.registry.prepare(step.tool, step.args);
    if (!prepared.ok) {
      // Rejected before anything ran. It is a failed step with a reason, and the
      // replanner decides whether that reason has a fix.
      const at = this.deps.now();
      mission = applyStepResult(mission, stepId, {
        outcome: "failed",
        at,
        error: prepared.reason,
      });
      mission = this.advance(mission, "step_bad", {
        at,
        step: findStep(mission, stepId),
        note: prepared.reason,
      });
      return this.recover(mission, stepId);
    }

    const level = prepared.classification.level;
    // Recorded before anything is asked, so the level in the plan graph, in the
    // consent question and in the stored record are the same one number.
    mission = classifyStep(mission, stepId, {
      level,
      category: prepared.classification.category,
    });
    let announced = false;
    if (level >= ANNOUNCE_APPROVAL_FROM) {
      mission = awaitApproval(mission, stepId);
      mission = this.advance(mission, "need_approval", {
        at: this.deps.now(),
        step: findStep(mission, stepId),
        note: `${step.title} is a level ${level} ${prepared.classification.category} action`,
      });
      announced = mission.state === "waiting_approval";
    }

    const decision = await this.deps.permissions.evaluate(prepared.descriptor);
    if (decision.verdict === "deny") {
      const at = this.deps.now();
      mission = applyStepResult(mission, stepId, { outcome: "failed", at, error: decision.reason });
      // A refusal is an answer. `blocked` says so; `failed` would say the mission
      // could not be done, when what is true is that it was not permitted.
      if (announced) {
        return this.advance(mission, "denied", {
          at,
          conclusion: decision.reason,
          step: findStep(mission, stepId),
          note: decision.reason,
        });
      }
      mission = this.advance(mission, "step_bad", {
        at,
        step: findStep(mission, stepId),
        note: decision.reason,
      });
      return this.recover(mission, stepId);
    }

    if (announced) {
      mission = this.advance(mission, "approved", {
        at: this.deps.now(),
        step: findStep(mission, stepId),
        note: decision.reason,
      });
      if (mission.state !== "executing") return mission;
      mission = startStep(mission, stepId, this.deps.now());
    }

    if (live.cancelled) {
      return this.advance(mission, "cancel", {
        at: this.deps.now(),
        conclusion: "you cancelled this mission before that step ran",
      });
    }

    let run: ToolRun;
    try {
      run = await this.deps.registry.invoke(prepared, {
        roots: this.deps.roots(),
        now: this.deps.now,
        log: (l) => this.deps.log?.(l),
      });
    } catch (err) {
      // The registry catches its own adapters; this is the belt for anything that
      // escapes it, so one bad tool cannot take the always-on process down.
      run = { outcome: "failed", summary: `${step.tool} did not complete`, error: message(err) };
    }

    mission = this.advance(mission, "verify", {
      at: this.deps.now(),
      step: findStep(mission, stepId),
    });

    const at = this.deps.now();
    mission = applyStepResult(mission, stepId, {
      outcome: run.outcome,
      at,
      result: run.summary,
      ...(run.error !== undefined ? { error: run.error } : {}),
      ...(run.simulated === true ? { simulated: true } : {}),
    });
    this.deps.permissions.recordOutcome(step.tool, run.outcome);

    if (run.outcome === "verified") {
      return this.advance(mission, "step_ok", {
        at,
        step: findStep(mission, stepId),
        note: run.summary,
      });
    }
    mission = this.advance(mission, "step_bad", {
      at,
      step: findStep(mission, stepId),
      note: run.error ?? run.summary,
    });
    return this.recover(mission, stepId);
  }

  /** Take a badly settled step to the replanner and apply whatever it decides. */
  private async recover(mission: Mission, stepId: string): Promise<Mission> {
    const at = this.deps.now();
    const step = findStep(mission, stepId);
    if (step === undefined) {
      return this.advance(mission, "error", { at, conclusion: "the step being replanned is gone" });
    }
    // `step_bad` was refused, which means something already moved the mission on.
    if (mission.state !== "replanning") return mission;

    let remedy: Remedy;
    try {
      remedy = await this.deps.replanner.replan({
        mission,
        step,
        tools: this.deps.registry.list().map((t) => t.name),
        limits: { maxAttempts: this.limits.maxAttempts, maxReplans: this.limits.maxReplans },
      });
    } catch (err) {
      return this.advance(mission, "error", {
        at,
        conclusion: `replanning failed: ${message(err)}`,
      });
    }

    switch (remedy.kind) {
      case "retry": {
        // Corrective steps and the retry are one decision. `addCorrectiveSteps`
        // charges the replan; the new steps carry a lower priority than the step
        // they fix, which in a serial loop is what puts them first.
        let next = addCorrectiveSteps(mission, remedy.steps.map(makeStep));
        next = retryStep(next, stepId);
        return this.advance(next, "replanned", {
          at,
          step: findStep(next, stepId),
          note: remedy.reason,
          ...voiceOf(remedy),
        });
      }
      case "steps": {
        const next = addCorrectiveSteps(mission, remedy.steps.map(makeStep));
        return this.advance(next, "replanned", { at, note: remedy.reason, ...voiceOf(remedy) });
      }
      case "skip": {
        // "Skip" here means *carry on without this one*, and the step keeps the
        // `failed` status it already earned — `skipStep` is for a step that never
        // ran, and overwriting a real failure with it would erase the reason from
        // the report. The mission survives because the step was optional, which is
        // what `isObjectiveMet` already knows. The replan is still charged: the
        // ceiling counts decisions, not the steps they produced.
        const next = addCorrectiveSteps(mission, []);
        return this.advance(next, "replanned", {
          at,
          step: findStep(next, stepId),
          note: remedy.reason,
          ...voiceOf(remedy),
        });
      }
      case "ask":
        return this.advance(mission, "ask_user", {
          at,
          conclusion: remedy.question,
          note: remedy.question,
          ...voiceOf(remedy),
        });
      case "stop":
        return this.advance(
          mission,
          remedy.cause === "exhausted" ? "replan_exhausted" : "give_up",
          { at, conclusion: remedy.reason, note: remedy.reason, ...voiceOf(remedy) },
        );
    }
  }
}

/**
 * Carry a remedy's provenance, or nothing at all.
 *
 * Spread rather than assigned, which is the idiom every optional field in this layer
 * uses: an unvoiced remedy leaves the field off the update altogether, so "this
 * repository composed the line" is the absence of a flag and never a `false` that some
 * later reader has to know to distrust.
 */
function voiceOf(remedy: Remedy): { readonly voice?: RemedyVoice } {
  return remedy.voice === undefined ? {} : { voice: remedy.voice };
}

/**
 * Why a mission with nothing runnable is not finished.
 *
 * Counts, in the vocabulary the report uses, because "stalled" on its own tells
 * the user nothing they can act on.
 */
function whyStuck(mission: Mission): string {
  const c = stepCounts(mission);
  const parts: string[] = [];
  if (c.done > 0) parts.push(`${c.done} verified`);
  if (c.unverified > 0) parts.push(`${c.unverified} unconfirmed`);
  if (c.failed > 0) parts.push(`${c.failed} failed`);
  if (c.skipped > 0) parts.push(`${c.skipped} skipped`);
  const summary = parts.length === 0 ? "nothing ran" : parts.join(", ");
  return `${summary}, and nothing is left that could change that`;
}
