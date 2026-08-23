/**
 * The orchestration loop's tests.
 *
 * These run the real `ToolRegistry`, the real `PermissionEngine` and the real
 * `DeterministicReplanner` against fake *tools* — the seam is the adapter, not the
 * machinery, because the machinery is what is under test. A fake permission engine
 * would prove nothing about whether a level-3 step asks.
 *
 * The chain the phase is built for — objective → plan → memory → tool → failure →
 * replan → retry → verified → report — is asserted in one test ("recovers from a
 * build that could not find its dependencies") rather than split across several,
 * so a break in the middle of it cannot pass.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_MISSION_LIMITS,
  MissionOrchestrator,
  type MissionUpdate,
  type OrchestratorDeps,
} from "../src/missions/orchestrator.js";
import { DeterministicReplanner } from "../src/missions/replanner.js";
import type { Planner, PlanResult } from "../src/missions/plan-builder.js";
import type { Mission, MissionEvent, StepInput } from "../src/missions/mission-model.js";
import { PermissionEngine, type ConsentChoice } from "../src/permissions/permission-engine.js";
import {
  ToolRegistry,
  type Schema,
  type Tool,
  type ToolArgs,
  type ToolRun,
} from "../src/tools/registry.js";

const T0 = 1_700_000_000_000;

/** A tool whose results are scripted. The last one repeats if it is asked again. */
function fakeTool(
  name: string,
  results: readonly ToolRun[],
  opts: { readonly schema?: Schema; readonly simulated?: boolean } = {},
): { readonly tool: Tool; readonly calls: ToolArgs[] } {
  const calls: ToolArgs[] = [];
  const tool: Tool = {
    name,
    summary: `fake ${name}`,
    schema: opts.schema ?? {},
    ...(opts.simulated === true ? { simulated: true } : {}),
    async run(args: ToolArgs): Promise<ToolRun> {
      calls.push(args);
      const at = Math.min(calls.length - 1, results.length - 1);
      return results[at] ?? { outcome: "failed", summary: "no scripted result" };
    },
  };
  return { tool, calls };
}

const ok = (summary = "done"): ToolRun => ({ outcome: "verified", summary });
const bad = (error: string): ToolRun => ({ outcome: "failed", summary: "did not work", error });

function registryOf(tools: readonly Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

function fixedPlanner(steps: readonly StepInput[], note = "a plan"): Planner {
  return { plan: async (): Promise<PlanResult> => ({ steps, planner: "deterministic", note }) };
}

interface Harness {
  readonly orchestrator: MissionOrchestrator;
  readonly updates: MissionUpdate[];
  readonly events: () => readonly MissionEvent[];
  readonly asks: string[];
  readonly engine: PermissionEngine;
  readonly clock: { at: number };
}

function harness(
  tools: readonly Tool[],
  planner: Planner,
  over: Partial<OrchestratorDeps> & { readonly choice?: ConsentChoice | null } = {},
): Harness {
  const clock = { at: T0 };
  // A clock that always moves: two events at the same millisecond would make an
  // ordering assertion pass for the wrong reason.
  const now = (): number => {
    clock.at += 1;
    return clock.at;
  };
  const asks: string[] = [];
  const engine = new PermissionEngine({
    now,
    ask: async (ctx) => {
      asks.push(ctx.title);
      return over.choice === undefined ? "allow_once" : over.choice;
    },
  });
  const updates: MissionUpdate[] = [];
  const orchestrator = new MissionOrchestrator({
    registry: registryOf(tools),
    planner,
    replanner: new DeterministicReplanner(),
    permissions: engine,
    projects: () => [],
    roots: () => ["E:\\code"],
    now,
    observe: (u) => updates.push(u),
    ...over,
  });
  return {
    orchestrator,
    updates,
    events: () => updates.map((u) => u.event).filter((e): e is MissionEvent => e !== undefined),
    asks,
    engine,
    clock,
  };
}

const statusOf = (mission: Mission, id: string): string | undefined =>
  mission.steps.find((s) => s.id === id)?.status;

describe("a mission that works", () => {
  it("plans, retrieves, runs both steps and completes", async () => {
    const read = fakeTool("list_projects", [ok("2 projects")]);
    const status = fakeTool("git_status", [ok("main, clean")], {
      schema: { path: { kind: "string", required: true } },
    });
    const h = harness(
      [read.tool, status.tool],
      fixedPlanner([
        { id: "projects", title: "List the projects", tool: "list_projects", priority: 10 },
        {
          id: "git",
          title: "Read the tree",
          tool: "git_status",
          args: { path: "E:\\code\\x" },
          dependsOn: ["projects"],
          priority: 20,
        },
      ]),
      { retrieve: async () => [{ source: "memory", summary: "the deadline is Friday" }] },
    );

    const mission = await h.orchestrator.run("check my projects");
    expect(mission.state).toBe("completed");
    expect(mission.memory).toHaveLength(1);
    expect(statusOf(mission, "projects")).toBe("done");
    expect(statusOf(mission, "git")).toBe("done");
    expect(h.events()).toEqual([
      "planned",
      "retrieved",
      "verify",
      "step_ok",
      "verify",
      "step_ok",
      "finish",
    ]);
  });

  it("runs steps in the plan's order, one at a time", async () => {
    const order: string[] = [];
    const one: Tool = {
      name: "list_projects",
      summary: "one",
      schema: {},
      async run() {
        order.push("one");
        return ok();
      },
    };
    const two: Tool = {
      name: "list_memories",
      summary: "two",
      schema: {},
      async run() {
        order.push("two");
        return ok();
      },
    };
    const h = harness(
      [one, two],
      fixedPlanner([
        { id: "b", title: "Second", tool: "list_memories", priority: 20 },
        { id: "a", title: "First", tool: "list_projects", priority: 10 },
      ]),
    );
    const mission = await h.orchestrator.run("do both");
    expect(mission.state).toBe("completed");
    expect(order).toEqual(["one", "two"]);
  });

  it("does not ask about a read", async () => {
    const read = fakeTool("list_projects", [ok()]);
    const h = harness([read.tool], fixedPlanner([{ id: "a", title: "Read", tool: "list_projects" }]));
    await h.orchestrator.run("read it");
    expect(h.asks).toEqual([]);
    expect(h.events()).not.toContain("need_approval");
  });

  it("reports a mocked capability as simulated on the step", async () => {
    const mock = fakeTool("list_projects", [ok()], { simulated: true });
    const h = harness([mock.tool], fixedPlanner([{ id: "a", title: "Read", tool: "list_projects" }]));
    const mission = await h.orchestrator.run("read it");
    expect(mission.steps[0]?.simulated).toBe(true);
  });

  it("leaves nothing running once it is over", async () => {
    const read = fakeTool("list_projects", [ok()]);
    const h = harness([read.tool], fixedPlanner([{ id: "a", title: "Read", tool: "list_projects" }]));
    const mission = await h.orchestrator.run("read it");
    expect(h.orchestrator.running()).toEqual([]);
    expect(h.orchestrator.isRunning(mission.id)).toBe(false);
  });
});

describe("consent", () => {
  it("announces the question, then carries on when it is allowed", async () => {
    const command = fakeTool("run_command", [ok("exit 0")]);
    const h = harness([command.tool], fixedPlanner([{ id: "b", title: "Build it", tool: "run_command" }]));
    const mission = await h.orchestrator.run("build it");
    expect(mission.state).toBe("completed");
    expect(h.asks).toHaveLength(1);
    expect(h.events()).toEqual([
      "planned",
      "retrieved",
      "need_approval",
      "approved",
      "verify",
      "step_ok",
      "finish",
    ]);
  });

  it("treats a refusal as blocked, not failed, and does not run the tool", async () => {
    const command = fakeTool("run_command", [ok()]);
    const h = harness([command.tool], fixedPlanner([{ id: "b", title: "Build it", tool: "run_command" }]), {
      choice: "deny",
    });
    const mission = await h.orchestrator.run("build it");
    expect(mission.state).toBe("blocked");
    expect(command.calls).toEqual([]);
    expect(statusOf(mission, "b")).toBe("failed");
    expect(mission.conclusion).toMatch(/declined/);
  });

  it("treats no answer as a refusal", async () => {
    const command = fakeTool("run_command", [ok()]);
    const h = harness([command.tool], fixedPlanner([{ id: "b", title: "Build it", tool: "run_command" }]), {
      choice: null,
    });
    const mission = await h.orchestrator.run("build it");
    expect(mission.state).toBe("blocked");
    expect(command.calls).toEqual([]);
  });
});

describe("failure and recovery", () => {
  it("recovers from a build that could not find its dependencies", async () => {
    // The chain this whole phase exists to produce, in one test: a real plan, a
    // real tool call, a real failure, a replan that adds a step, a retry, and only
    // then a completed mission.
    const command = fakeTool(
      "run_command",
      [bad("exit code 1 · Error: Cannot find module 'vite'"), ok("exit 0"), ok("exit 0")],
      {
        schema: {
          program: { kind: "string", required: true },
          args: { kind: "stringArray" },
          cwd: { kind: "string", required: true },
        },
      },
    );
    const h = harness(
      [command.tool],
      fixedPlanner([
        {
          id: "build",
          title: "Build it",
          tool: "run_command",
          args: { program: "npm", args: ["run", "build"], cwd: "E:\\code\\x" },
          priority: 30,
        },
      ]),
      { retrieve: async () => [{ source: "project", summary: "x is a node project" }] },
    );

    const mission = await h.orchestrator.run("get x ready");

    expect(mission.state).toBe("completed");
    expect(mission.replans).toBe(1);
    // The install ran before the retry, and the build ran twice.
    expect(command.calls.map((c) => (c.args as string[] | undefined)?.join(" "))).toEqual([
      "run build",
      "ci",
      "run build",
    ]);
    expect(statusOf(mission, "build")).toBe("done");
    expect(statusOf(mission, "build-install")).toBe("done");
    expect(mission.steps.find((s) => s.id === "build")?.attempt).toBe(2);
    // The failure it recovered from is still on the record.
    expect(mission.steps.find((s) => s.id === "build")?.error).toMatch(/Cannot find module/);
    expect(mission.steps.find((s) => s.id === "build-install")?.origin).toBe("replan");
    expect(h.events()).toEqual([
      "planned",
      "retrieved",
      "need_approval",
      "approved",
      "verify",
      "step_bad",
      "replanned",
      "need_approval",
      "approved",
      "verify",
      "step_ok",
      "need_approval",
      "approved",
      "verify",
      "step_ok",
      "finish",
    ]);
  });

  it("fails with the reason when a failure has no fix", async () => {
    const command = fakeTool("run_command", [bad("exit code 2 · error TS2304: Cannot find name 'foo'")]);
    const h = harness([command.tool], fixedPlanner([{ id: "b", title: "Build it", tool: "run_command" }]));
    const mission = await h.orchestrator.run("build it");
    expect(mission.state).toBe("failed");
    expect(mission.conclusion).toMatch(/will fail the same way/);
    expect(command.calls).toHaveLength(1);
  });

  it("blocks on a question only the user can answer", async () => {
    const find = fakeTool("find_project", [bad('2 projects match "site"')]);
    const h = harness([find.tool], fixedPlanner([{ id: "p", title: "Find site", tool: "find_project" }]));
    const mission = await h.orchestrator.run("is site ready");
    expect(mission.state).toBe("blocked");
    expect(mission.conclusion).toMatch(/say which one/);
  });

  it("carries on past an optional step that failed", async () => {
    const git = fakeTool("git_status", [bad("fatal: not a git repository")]);
    const read = fakeTool("list_projects", [ok()]);
    const h = harness(
      [git.tool, read.tool],
      fixedPlanner([
        { id: "git", title: "Read the tree", tool: "git_status", optional: true, priority: 10 },
        { id: "p", title: "List them", tool: "list_projects", priority: 20 },
      ]),
    );
    const mission = await h.orchestrator.run("look around");
    expect(mission.state).toBe("completed");
    // The failure stays on the record — the mission survived it, it did not vanish.
    expect(statusOf(mission, "git")).toBe("failed");
    expect(mission.steps.find((s) => s.id === "git")?.error).toMatch(/not a git repository/);
    expect(statusOf(mission, "p")).toBe("done");
    expect(mission.replans).toBe(1);
  });

  it("skips the steps that can no longer run, and says so", async () => {
    const git = fakeTool("git_status", [bad("fatal: not a git repository")]);
    const commits = fakeTool("list_memories", [ok()]);
    const read = fakeTool("list_projects", [ok()]);
    const h = harness(
      [git.tool, commits.tool, read.tool],
      fixedPlanner([
        { id: "git", title: "Read the tree", tool: "git_status", optional: true, priority: 10 },
        { id: "after", title: "Read what it found", tool: "list_memories", dependsOn: ["git"], priority: 20 },
        { id: "p", title: "List them", tool: "list_projects", priority: 30 },
      ]),
    );
    const mission = await h.orchestrator.run("look around");
    expect(statusOf(mission, "after")).toBe("skipped");
    expect(commits.calls).toEqual([]);
    // An independent step still runs: one dead branch does not stop the plan.
    expect(statusOf(mission, "p")).toBe("done");
    expect(mission.state).toBe("failed");
    expect(mission.conclusion).toMatch(/1 verified, 1 failed, 1 skipped/);
  });

  it("leaves a step that never ran as never attempted", async () => {
    const read = fakeTool("list_projects", [bad("exit code 2 · nothing to be done")]);
    const later = fakeTool("list_memories", [ok()]);
    const h = harness(
      [read.tool, later.tool],
      fixedPlanner([
        { id: "a", title: "First", tool: "list_projects", priority: 10 },
        { id: "b", title: "Second", tool: "list_memories", dependsOn: ["a"], priority: 20 },
      ]),
    );
    const mission = await h.orchestrator.run("do both");
    expect(mission.state).toBe("failed");
    // Not `skipped`: nothing was decided about it, the mission ended first.
    expect(statusOf(mission, "b")).toBe("pending");
    expect(later.calls).toEqual([]);
  });

  it("reads a memory write back rather than writing it twice", async () => {
    const write = fakeTool("write_memory", [{ outcome: "unconfirmed", summary: "not sure" }], {
      schema: { text: { kind: "string", required: true } },
    });
    const search = fakeTool("search_memory", [ok("nothing saved about that")], {
      schema: { query: { kind: "string", required: true } },
    });
    const h = harness(
      [write.tool, search.tool],
      fixedPlanner([
        { id: "save", title: "Save that", tool: "write_memory", args: { text: "Friday" } },
      ]),
    );
    const mission = await h.orchestrator.run("remember Friday");
    // The write is `unverified`, so the mission cannot claim success — but the
    // read-back happened and the report has the fact.
    expect(mission.state).toBe("failed");
    expect(statusOf(mission, "save")).toBe("unverified");
    expect(search.calls).toEqual([{ query: "Friday" }]);
    expect(write.calls).toHaveLength(1);
  });

  it("fails a step the registry rejected without running anything", async () => {
    const read = fakeTool("list_projects", [ok()], {
      schema: { path: { kind: "string", required: true } },
    });
    const h = harness([read.tool], fixedPlanner([{ id: "a", title: "Read", tool: "list_projects" }]));
    const mission = await h.orchestrator.run("read it");
    expect(mission.state).toBe("failed");
    expect(statusOf(mission, "a")).toBe("failed");
    expect(read.calls).toEqual([]);
    expect(mission.steps[0]?.error).toMatch(/path is required/);
  });

  it("fails a step whose tool this build does not have", async () => {
    const h = harness([], fixedPlanner([{ id: "a", title: "Do it", tool: "no_such_tool" }]));
    const mission = await h.orchestrator.run("do it");
    expect(mission.state).toBe("failed");
    expect(mission.steps[0]?.error).toMatch(/no tool called/);
  });
});

describe("nothing to do", () => {
  it("fails with the planner's own reason when there is no plan", async () => {
    const h = harness([], fixedPlanner([], "I have no deterministic plan for that objective"));
    const mission = await h.orchestrator.run("negotiate my rent");
    expect(mission.state).toBe("failed");
    expect(mission.steps).toEqual([]);
    expect(mission.conclusion).toBe("I have no deterministic plan for that objective");
    expect(h.events()).toEqual(["plan_empty"]);
  });

  it("fails rather than throwing when the planner does", async () => {
    const planner: Planner = {
      plan: async () => {
        throw new Error("the registry exploded");
      },
    };
    const h = harness([], planner);
    const mission = await h.orchestrator.run("do something");
    expect(mission.state).toBe("failed");
    expect(mission.conclusion).toMatch(/planning failed: the registry exploded/);
  });
});

describe("bounds", () => {
  it("stops at the step ceiling", async () => {
    const read = fakeTool("list_projects", [ok()]);
    const steps: StepInput[] = Array.from({ length: 6 }, (_v, i) => ({
      id: `s${i}`,
      title: `Step ${i}`,
      tool: "list_projects",
      priority: i,
    }));
    const h = harness([read.tool], fixedPlanner(steps), { limits: { maxSteps: 3 } });
    const mission = await h.orchestrator.run("do lots");
    expect(mission.state).toBe("failed");
    expect(mission.conclusion).toMatch(/already run 3 steps/);
    expect(read.calls).toHaveLength(3);
  });

  it("stops at the wall clock", async () => {
    const slow: Tool = {
      name: "list_projects",
      summary: "slow",
      schema: {},
      async run() {
        return ok();
      },
    };
    const h = harness(
      [slow],
      fixedPlanner([
        { id: "a", title: "First", tool: "list_projects", priority: 10 },
        { id: "b", title: "Second", tool: "list_projects", priority: 20 },
      ]),
      { limits: { wallClockMs: 5 } },
    );
    const mission = await h.orchestrator.run("do both");
    expect(mission.state).toBe("failed");
    expect(mission.conclusion).toMatch(/ceiling/);
  });

  it("does not replan forever", async () => {
    // Every attempt fails the same fixable way, so the replanner keeps having
    // something to try — the ceilings are the only thing that ends this.
    const command = fakeTool("run_command", [bad("exit code 1 · Cannot find module 'vite'")], {
      schema: {
        program: { kind: "string", required: true },
        args: { kind: "stringArray" },
        cwd: { kind: "string", required: true },
      },
    });
    const h = harness(
      [command.tool],
      fixedPlanner([
        {
          id: "build",
          title: "Build it",
          tool: "run_command",
          args: { program: "npm", args: ["run", "build"], cwd: "E:\\code\\x" },
        },
      ]),
    );
    const mission = await h.orchestrator.run("get it ready");
    expect(mission.state).toBe("failed");
    expect(mission.replans).toBeLessThanOrEqual(DEFAULT_MISSION_LIMITS.maxReplans);
    expect(command.calls.length).toBeLessThanOrEqual(DEFAULT_MISSION_LIMITS.maxSteps);
  });
});

describe("cancelling", () => {
  it("stops at the next step boundary and keeps what already ran", async () => {
    const read = fakeTool("list_projects", [ok()]);
    const later = fakeTool("list_memories", [ok()]);
    const plan = fixedPlanner([
      { id: "a", title: "First", tool: "list_projects", priority: 10 },
      { id: "b", title: "Second", tool: "list_memories", priority: 20 },
    ]);
    // Cancelling from inside an update is what the UI's stop button does.
    const holder: { orchestrator?: MissionOrchestrator } = {};
    const h = harness([read.tool, later.tool], plan, {
      observe: (u) => {
        if (u.event === "step_ok") holder.orchestrator?.cancel(u.mission.id);
      },
    });
    holder.orchestrator = h.orchestrator;

    const mission = await h.orchestrator.run("do both");
    expect(mission.state).toBe("cancelled");
    expect(statusOf(mission, "a")).toBe("done");
    expect(later.calls).toEqual([]);
    expect(mission.conclusion).toMatch(/cancelled/);
  });

  it("says no when asked to cancel something that is not running", () => {
    const h = harness([], fixedPlanner([]));
    expect(h.orchestrator.cancel("m-nothing")).toBe(false);
  });
});

describe("what reaches the wire", () => {
  it("keeps every note on one line", async () => {
    const read = fakeTool("list_projects", [
      { outcome: "failed", summary: "did not work", error: "exit code 2 · line one\nline two" },
    ]);
    const h = harness([read.tool], fixedPlanner([{ id: "a", title: "Read", tool: "list_projects" }]));
    await h.orchestrator.run("read it");
    for (const u of h.updates) {
      if (u.note !== undefined) expect(u.note).not.toMatch(/[\n\r]/);
    }
  });

  it("caps an objective rather than carrying an essay into the record", async () => {
    const h = harness([], fixedPlanner([], "no plan"));
    const mission = await h.orchestrator.run("x".repeat(900));
    expect(mission.objective.length).toBeLessThanOrEqual(400);
  });

  it("survives an observer that throws", async () => {
    const read = fakeTool("list_projects", [ok()]);
    const h = harness([read.tool], fixedPlanner([{ id: "a", title: "Read", tool: "list_projects" }]), {
      observe: () => {
        throw new Error("the renderer fell over");
      },
    });
    const mission = await h.orchestrator.run("read it");
    expect(mission.state).toBe("completed");
  });
});
