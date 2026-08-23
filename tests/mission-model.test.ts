import { describe, it, expect } from "vitest";
import {
  addCorrectiveSteps,
  applyStepResult,
  awaitApproval,
  createMission,
  findStep,
  inFlightSteps,
  isObjectiveMet,
  isStalled,
  isTerminal,
  makeStep,
  nextRunnableSteps,
  retryStep,
  satisfiesDependency,
  setMemory,
  setPlan,
  skipStep,
  startStep,
  statusForOutcome,
  stepCounts,
  transition,
  unreachableSteps,
  type Mission,
  type MissionEvent,
  type MissionState,
  type StepInput,
} from "../src/missions/mission-model.js";

const T0 = 1_700_000_000_000;

function mission(steps: readonly StepInput[] = []): Mission {
  const m = createMission({ id: "m1", objective: "get it ready", at: T0 });
  return setPlan(m, steps.map(makeStep));
}

/** Drive a mission to `executing` the way the orchestrator does. */
function executing(steps: readonly StepInput[]): Mission {
  const planned = transition(mission(steps), "planned", { at: T0 });
  if (!planned.ok) throw new Error("planned rejected");
  const got = transition(planned.mission, "retrieved", { at: T0 });
  if (!got.ok) throw new Error("retrieved rejected");
  return got.mission;
}

function step(m: Mission, id: string) {
  const s = findStep(m, id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

describe("mission state machine", () => {
  it("runs the healthy path planning → completed", () => {
    let m = mission([{ id: "a", title: "look", tool: "git.status" }]);
    const order: MissionState[] = [m.state];
    for (const e of ["planned", "retrieved", "verify", "step_ok", "finish"] as MissionEvent[]) {
      const r = transition(m, e, { at: T0 });
      expect(r.ok, `${e} from ${m.state}`).toBe(true);
      if (!r.ok) return;
      m = r.mission;
      order.push(m.state);
    }
    expect(order).toEqual([
      "planning",
      "retrieving",
      "executing",
      "verifying",
      "executing",
      "completed",
    ]);
    expect(m.finishedAt).toBe(T0);
  });

  it("rejects an illegal event and hands the mission back unchanged", () => {
    const m = mission();
    const r = transition(m, "step_ok", { at: T0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.from).toBe("planning");
    expect(r.reason).toContain("not legal");
    expect(r.mission).toBe(m);
  });

  it("says so when a mission is already finished", () => {
    const done = transition(mission(), "error", { at: T0 });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const again = transition(done.mission, "planned", { at: T0 });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toContain("already failed");
  });

  it("an empty plan fails rather than completing", () => {
    const r = transition(mission(), "plan_empty", { at: T0, conclusion: "nothing to do" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mission.state).toBe("failed");
    expect(r.mission.conclusion).toBe("nothing to do");
    expect(isTerminal(r.mission.state)).toBe(true);
  });

  it("a refused permission is blocked, not failed", () => {
    const m = executing([{ id: "a", title: "delete", tool: "fs.delete" }]);
    const asked = transition(awaitApproval(m, "a"), "need_approval", { at: T0 });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.mission.state).toBe("waiting_approval");
    const denied = transition(asked.mission, "denied", { at: T0 + 5, conclusion: "you said no" });
    expect(denied.ok).toBe(true);
    if (!denied.ok) return;
    expect(denied.mission.state).toBe("blocked");
    // The step stops being shown as waiting on an answer nobody will give.
    expect(step(denied.mission, "a").status).toBe("cancelled");
    expect(step(denied.mission, "a").finishedAt).toBe(T0 + 5);
  });

  it("a terminal state cancels moving steps and leaves untouched ones pending", () => {
    let m = executing([
      { id: "a", title: "one", tool: "t" },
      { id: "b", title: "two", tool: "t" },
      { id: "c", title: "three", tool: "t" },
    ]);
    m = startStep(m, "a", T0);
    m = awaitApproval(m, "b");
    const r = transition(m, "cancel", { at: T0 + 9, conclusion: "you cancelled it" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(step(r.mission, "a").status).toBe("cancelled");
    expect(step(r.mission, "b").status).toBe("cancelled");
    expect(step(r.mission, "c").status).toBe("pending");
  });
});

describe("outcomes", () => {
  it("only `verified` earns `done`", () => {
    expect(statusForOutcome("verified")).toBe("done");
    expect(statusForOutcome("failed")).toBe("failed");
    expect(statusForOutcome("unconfirmed")).toBe("unverified");
    expect(statusForOutcome("unchecked")).toBe("unverified");
  });

  it("only `done` satisfies a dependency", () => {
    expect(satisfiesDependency("done")).toBe(true);
    for (const s of ["unverified", "failed", "skipped", "cancelled", "pending"] as const) {
      expect(satisfiesDependency(s), s).toBe(false);
    }
  });

  it("an unconfirmed step does not unblock what depends on it", () => {
    let m = executing([
      { id: "a", title: "write it", tool: "fs.write" },
      { id: "b", title: "read it back", tool: "fs.read", dependsOn: ["a"] },
    ]);
    m = startStep(m, "a", T0);
    m = applyStepResult(m, "a", {
      outcome: "unconfirmed",
      at: T0 + 100,
      result: "the tool returned without error",
    });
    expect(step(m, "a").status).toBe("unverified");
    expect(step(m, "a").outcome).toBe("unconfirmed");
    expect(nextRunnableSteps(m)).toHaveLength(0);
    expect(isObjectiveMet(m)).toBe(false);
  });

  it("records timings, simulation and errors as given", () => {
    let m = executing([{ id: "a", title: "search", tool: "web.search" }]);
    m = startStep(m, "a", T0);
    m = applyStepResult(m, "a", {
      outcome: "failed",
      at: T0 + 250,
      error: "no provider configured",
      simulated: true,
    });
    const s = step(m, "a");
    expect(s.startedAt).toBe(T0);
    expect(s.finishedAt).toBe(T0 + 250);
    expect(s.error).toBe("no provider configured");
    expect(s.simulated).toBe(true);
  });
});

describe("dependency ordering", () => {
  it("offers only steps whose dependencies are done, best first", () => {
    let m = executing([
      { id: "a", title: "first", tool: "t", priority: 10 },
      { id: "b", title: "later", tool: "t", dependsOn: ["a"], priority: 1 },
      { id: "c", title: "also first", tool: "t", priority: 20 },
    ]);
    expect(nextRunnableSteps(m).map((s) => s.id)).toEqual(["a", "c"]);
    m = applyStepResult(m, "a", { outcome: "verified", at: T0 + 1 });
    // `b` has the best priority, so it goes ahead of the one that was waiting.
    expect(nextRunnableSteps(m).map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("breaks priority ties by plan order, not by chance", () => {
    const m = executing([
      { id: "x", title: "x", tool: "t" },
      { id: "y", title: "y", tool: "t" },
      { id: "z", title: "z", tool: "t" },
    ]);
    expect(nextRunnableSteps(m).map((s) => s.id)).toEqual(["x", "y", "z"]);
  });

  it("reports a whole chain as unreachable when its root fails", () => {
    let m = executing([
      { id: "a", title: "a", tool: "t" },
      { id: "b", title: "b", tool: "t", dependsOn: ["a"] },
      { id: "c", title: "c", tool: "t", dependsOn: ["b"] },
      { id: "d", title: "d", tool: "t" },
    ]);
    m = applyStepResult(m, "a", { outcome: "failed", at: T0 + 1, error: "nope" });
    expect(unreachableSteps(m).map((s) => s.id)).toEqual(["b", "c"]);
    expect(nextRunnableSteps(m).map((s) => s.id)).toEqual(["d"]);
  });

  it("treats a dependency on an id that does not exist as unreachable", () => {
    const m = executing([{ id: "b", title: "b", tool: "t", dependsOn: ["ghost"] }]);
    expect(unreachableSteps(m).map((s) => s.id)).toEqual(["b"]);
    expect(nextRunnableSteps(m)).toHaveLength(0);
    expect(isStalled(m)).toBe(true);
  });

  it("calls a dependency cycle stalled rather than unreachable", () => {
    const m = executing([
      { id: "a", title: "a", tool: "t", dependsOn: ["b"] },
      { id: "b", title: "b", tool: "t", dependsOn: ["a"] },
    ]);
    expect(unreachableSteps(m)).toHaveLength(0);
    expect(nextRunnableSteps(m)).toHaveLength(0);
    expect(isStalled(m)).toBe(true);
  });
});

describe("retry, skip and replan", () => {
  it("a retry re-queues the step and keeps the failure that caused it", () => {
    let m = executing([{ id: "a", title: "build", tool: "terminal.run" }]);
    m = startStep(m, "a", T0);
    m = applyStepResult(m, "a", { outcome: "failed", at: T0 + 5, error: "exit 1" });
    m = retryStep(m, "a");
    const s = step(m, "a");
    expect(s.status).toBe("pending");
    expect(s.attempt).toBe(2);
    expect(s.error).toBe("exit 1");
    expect(s.outcome).toBe("failed");
    expect(nextRunnableSteps(m).map((x) => x.id)).toEqual(["a"]);
  });

  it("will not retry a step that succeeded", () => {
    let m = executing([{ id: "a", title: "a", tool: "t" }]);
    m = applyStepResult(m, "a", { outcome: "verified", at: T0 + 1 });
    expect(step(retryStep(m, "a"), "a").attempt).toBe(1);
  });

  it("counts a replan even when it produced no step", () => {
    const m = addCorrectiveSteps(executing([{ id: "a", title: "a", tool: "t" }]), []);
    expect(m.replans).toBe(1);
    expect(m.steps).toHaveLength(1);
  });

  it("marks corrective steps as such, whatever the caller claimed", () => {
    const m = addCorrectiveSteps(executing([{ id: "a", title: "a", tool: "t" }]), [
      makeStep({ id: "a2", title: "try the other way", tool: "t2", origin: "plan" }),
    ]);
    expect(step(m, "a2").origin).toBe("replan");
    expect(stepCounts(m).corrective).toBe(1);
  });

  it("a skipped step records why and cannot be skipped twice", () => {
    let m = executing([{ id: "a", title: "a", tool: "t" }]);
    m = skipStep(m, "a", "no project to act on", T0 + 3);
    expect(step(m, "a").status).toBe("skipped");
    expect(step(m, "a").error).toBe("no project to act on");
    m = skipStep(m, "a", "a different reason", T0 + 9);
    expect(step(m, "a").error).toBe("no project to act on");
  });

  it("ignores a step id nothing matches instead of throwing", () => {
    const m = executing([{ id: "a", title: "a", tool: "t" }]);
    expect(startStep(m, "ghost", T0)).toBe(m);
    expect(applyStepResult(m, "ghost", { outcome: "verified", at: T0 })).toBe(m);
  });
});

describe("objective and counts", () => {
  it("is met only when every required step verified", () => {
    let m = executing([
      { id: "a", title: "a", tool: "t" },
      { id: "b", title: "b", tool: "t", optional: true },
    ]);
    m = applyStepResult(m, "a", { outcome: "verified", at: T0 + 1 });
    expect(isObjectiveMet(m)).toBe(false); // `b` is still pending
    m = applyStepResult(m, "b", { outcome: "failed", at: T0 + 2, error: "meh" });
    // An optional step failing does not spoil the objective.
    expect(isObjectiveMet(m)).toBe(true);
  });

  it("is not met by a plan with no required steps at all", () => {
    let m = executing([{ id: "a", title: "a", tool: "t", optional: true }]);
    m = applyStepResult(m, "a", { outcome: "verified", at: T0 + 1 });
    expect(isObjectiveMet(m)).toBe(false);
  });

  it("is not met while a step is still in flight", () => {
    let m = executing([
      { id: "a", title: "a", tool: "t" },
      { id: "b", title: "b", tool: "t" },
    ]);
    m = applyStepResult(m, "a", { outcome: "verified", at: T0 + 1 });
    m = startStep(m, "b", T0 + 2);
    expect(inFlightSteps(m).map((s) => s.id)).toEqual(["b"]);
    expect(isObjectiveMet(m)).toBe(false);
  });

  it("counts every status, plus corrective and simulated steps", () => {
    let m = executing([
      { id: "a", title: "a", tool: "t" },
      { id: "b", title: "b", tool: "t" },
      { id: "c", title: "c", tool: "t" },
      { id: "d", title: "d", tool: "t", simulated: true },
      { id: "e", title: "e", tool: "t" },
    ]);
    m = applyStepResult(m, "a", { outcome: "verified", at: T0 + 1 });
    m = applyStepResult(m, "b", { outcome: "unchecked", at: T0 + 2 });
    m = applyStepResult(m, "c", { outcome: "failed", at: T0 + 3 });
    m = applyStepResult(m, "d", { outcome: "verified", at: T0 + 4, simulated: true });
    m = startStep(m, "e", T0 + 5);
    const c = stepCounts(m);
    expect(c).toMatchObject({
      total: 5,
      done: 2,
      unverified: 1,
      failed: 1,
      running: 1,
      pending: 0,
      simulated: 1,
      corrective: 0,
    });
  });

  it("keeps retrieved facts as citations on the mission", () => {
    const m = setMemory(mission(), [{ source: "project", summary: "jarvis at E:\\jarvis" }]);
    expect(m.memory).toEqual([{ source: "project", summary: "jarvis at E:\\jarvis" }]);
  });
});
