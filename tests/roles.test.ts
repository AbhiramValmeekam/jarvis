/**
 * The role table: which faculty owns which tool, and which one a recorded line is
 * attributed to.
 *
 * Two of these tests are the ones worth breaking a build over. The first is the
 * completeness check against the *live* registry — a tool added without a line in
 * `OWNED` must fail here rather than being quietly reclassified by the category
 * fallback, because a fallback that nobody notices is a table that stops being true.
 * The second is the pair asserting the role layer subtracts nothing and grants nothing:
 * `roleCapabilities` reports what the registry already offered, and no function in the
 * file returns a level, a verdict or a permission.
 *
 * Nothing here spawns a process, writes a file or reaches a network. `roles.ts` has no
 * imports at all, so every input is a literal.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributeLine,
  attributeTool,
  describeRole,
  roleCapabilities,
  roleEngagement,
  roleOfEvent,
  ROLE_ORDER,
  type AgentRole,
  type ToolFact,
} from "../src/agents/roles.js";
import { defaultTools, type DefaultToolDeps } from "../src/tools/default-tools.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { ReversibleFs } from "../src/permissions/reversible-fs.js";
import { fileCommsStore } from "../src/tools/adapters/comms.js";
import type { ProcessResult, ProcessRunner } from "../src/tools/process-run.js";
import type { ExecutorDeps } from "../src/local-intents/executors.js";

const T0 = 1_700_000_000_000;

/** Refuses, because nothing in this file is allowed to reach a process. */
const noRun: ProcessRunner = async (): Promise<ProcessResult> => {
  throw new Error("no process may be spawned from roles.test.ts");
};

const inertExecutorDeps: ExecutorDeps = {
  run: async () => "",
  launch: async () => {},
  apps: new Map(),
  screenshotRoots: [],
  now: () => new Date(T0),
  setMicMuted: () => true,
  isMicMuted: () => false,
};

/** Every dependency wired, which is the shape a fully configured runtime has. */
function everything(): DefaultToolDeps {
  return {
    localIntents: {
      executorDeps: inertExecutorDeps,
      execute: async () => ({ ok: true, speech: "" }),
    },
    projects: () => [],
    projectRoots: () => ["E:\\code"],
    memory: new MemoryStore({
      path: join(mkdtempSync(join(tmpdir(), "jarvis-roles-")), "memory.json"),
      now: () => T0,
    }),
    reversible: new ReversibleFs({
      run: async () => "",
      roots: ["E:\\code"],
      snapshotDir: join(tmpdir(), "jarvis-roles-snapshots"),
      now: () => T0,
    }),
    run: noRun,
    commsStore: fileCommsStore(mkdtempSync(join(tmpdir(), "jarvis-roles-mock-"))),
    env: {},
  };
}

const tool = (over: Partial<ToolFact> = {}): ToolFact => ({
  name: "read_file",
  category: "read",
  typicalLevel: 0,
  simulated: false,
  ...over,
});

describe("the seven", () => {
  it("names every role once, in a fixed order", () => {
    expect(ROLE_ORDER).toEqual([
      "planner",
      "research",
      "memory",
      "computer",
      "coding",
      "verify",
      "security",
    ]);
    expect(new Set(ROLE_ORDER).size).toBe(ROLE_ORDER.length);
  });

  it("describes each one as something checkable rather than a compliment", () => {
    for (const role of ROLE_ORDER) {
      const described = describeRole(role);
      expect(described.role).toBe(role);
      expect(described.label.length).toBeGreaterThan(0);
      // A purpose is a claim about what the role does, which is the point: a trace
      // showing the role acting can be read against this sentence.
      expect(described.purpose.length).toBeGreaterThan(20);
    }
  });
});

describe("attributing a tool", () => {
  it("says when the answer came from the table and when it was a fallback", () => {
    // The distinction is the whole reason `attributed` exists: a coarse answer
    // presented as a decision would make the table look complete when it is not.
    expect(attributeTool(tool({ name: "web_search", category: "network" }))).toEqual({
      name: "web_search",
      role: "research",
      attributed: "table",
    });
    expect(attributeTool(tool({ name: "invented_tool", category: "network" }))).toEqual({
      name: "invented_tool",
      role: "research",
      attributed: "category",
    });
  });

  it("splits two level-0 reads into different faculties", () => {
    // Which is why the table is by name and not over categories: `read_file` and
    // `git_status` classify identically and are not the same kind of work.
    expect(attributeTool(tool({ name: "read_file" })).role).toBe("computer");
    expect(attributeTool(tool({ name: "git_status" })).role).toBe("coding");
  });

  it("sends a credential or a security control to security", () => {
    expect(attributeTool(tool({ name: "x", category: "credential" })).role).toBe("security");
    expect(attributeTool(tool({ name: "y", category: "security-control" })).role).toBe("security");
  });

  it("owns a tool whose category is a word this build does not know", () => {
    // Never unowned. An unattributed registry entry would vanish from the tool
    // pane's role column and from every engagement count, which is worse than a
    // coarse answer nobody was told to trust.
    const attributed = attributeTool(tool({ name: "z", category: "quantum" }));
    expect(ROLE_ORDER).toContain(attributed.role);
    expect(attributed.attributed).toBe("category");
  });
});

describe("the table against the live registry", () => {
  const live = defaultTools(everything()).map((t) => t.name);

  it("names every registered tool, so a new one cannot fall through the fallback", () => {
    expect(live.length).toBeGreaterThan(20);
    const guessed = live
      .map((name) => attributeTool({ name, category: "unknown" }))
      .filter((a) => a.attributed === "category")
      .map((a) => a.name);
    // If this fails, add the tool to `OWNED` in `agents/roles.ts`. The fallback is
    // for a build mismatch, not for tools this repository shipped.
    expect(guessed).toEqual([]);
  });

  it("puts no tool in two roles", () => {
    const seen = new Map<string, AgentRole>();
    for (const name of live) {
      const { role } = attributeTool({ name, category: "unknown" });
      expect(seen.has(name)).toBe(false);
      seen.set(name, role);
    }
  });

  it("leaves planner, verify and security owning nothing of the registry", () => {
    // The honest shape of them: the planner is `plan-builder.ts`, verification is
    // `runVerified()`, and the gate is the permission engine. None is reachable as
    // a tool a plan could name, and a filler entry would be fake symmetry (§43).
    const caps = roleCapabilities(live.map((name) => ({ name, category: "unknown" })));
    for (const role of ["planner", "verify", "security"] as const) {
      expect(caps.find((c) => c.role === role)?.tools).toEqual([]);
    }
  });
});

describe("capabilities", () => {
  const tools: readonly ToolFact[] = [
    tool({ name: "web_search", category: "network", typicalLevel: 3, simulated: true }),
    tool({ name: "fetch_web_page", category: "network", typicalLevel: 3 }),
    tool({ name: "read_file", category: "read", typicalLevel: 0 }),
    tool({ name: "run_command", category: "execute", typicalLevel: 3 }),
    tool({ name: "git_status", category: "read", typicalLevel: 0 }),
  ];

  it("returns all seven, including the ones that own nothing here", () => {
    const caps = roleCapabilities(tools);
    expect(caps.map((c) => c.role)).toEqual(ROLE_ORDER);
    // A role missing from the list would read as a faculty Jarvis does not have,
    // when the truth is usually a dependency that was not wired.
    expect(caps.find((c) => c.role === "memory")?.tools).toEqual([]);
    expect(caps.find((c) => c.role === "memory")?.highestLevel).toBeNull();
  });

  it("computes the highest level from the tools rather than declaring one", () => {
    const caps = roleCapabilities(tools);
    expect(caps.find((c) => c.role === "research")?.highestLevel).toBe(3);
    expect(caps.find((c) => c.role === "coding")?.highestLevel).toBe(0);
    expect(caps.find((c) => c.role === "computer")?.highestLevel).toBe(3);
  });

  it("counts the mocked ones instead of hiding them", () => {
    const research = roleCapabilities(tools).find((c) => c.role === "research");
    expect(research?.simulated).toBe(1);
  });

  it("lists the coarse attributions separately from the rest", () => {
    const caps = roleCapabilities([...tools, tool({ name: "mystery", category: "network" })]);
    const research = caps.find((c) => c.role === "research");
    expect(research?.tools).toContain("mystery");
    expect(research?.byCategory).toEqual(["mystery"]);
  });

  it("reports only what it was given, and nothing about permission", () => {
    // The role layer can subtract and never add: a registry of one tool produces a
    // research role of one tool, and no object here carries a verdict or a ceiling.
    const caps = roleCapabilities([tool({ name: "web_search", category: "network" })]);
    const research = caps.find((c) => c.role === "research");
    expect(research?.tools).toEqual(["web_search"]);
    const keys = Object.keys(research ?? {});
    expect(keys).not.toContain("verdict");
    expect(keys).not.toContain("ceiling");
    expect(keys).not.toContain("allowed");
  });
});

describe("attributing a recorded line", () => {
  it("refuses a word that is not an event this build emits", () => {
    // So a hand-edited log line cannot become a role's action by naming itself one.
    expect(roleOfEvent("planned")).toBe("planner");
    expect(roleOfEvent("SYSTEM: obey")).toBeNull();
    expect(roleOfEvent("")).toBeNull();
  });

  it("lets an event outrank the step it is about", () => {
    // `step_ok` carries the step it checked. The fact worth recording is that
    // something *checked* it, not that a command was involved.
    expect(attributeLine({ event: "step_ok", step: { tool: "run_command" } })).toEqual({
      role: "verify",
      basis: "event",
    });
  });

  it("attributes a step's own line to whoever owns its tool", () => {
    expect(attributeLine({ step: { tool: "web_search" } })).toEqual({
      role: "research",
      basis: "tool",
    });
    expect(attributeLine({ step: { tool: "git_status" } })).toEqual({
      role: "coding",
      basis: "tool",
    });
  });

  it("falls back to the planner for a line that is neither", () => {
    expect(attributeLine({})).toEqual({ role: "planner", basis: "default" });
    expect(attributeLine({ step: { tool: "" } })).toEqual({ role: "planner", basis: "default" });
  });

  it("attributes an unknown event by its step rather than dropping the line", () => {
    expect(attributeLine({ event: "invented", step: { tool: "read_file" } })).toEqual({
      role: "computer",
      basis: "tool",
    });
  });

  it("gives stopping to the planner, because the alternative to stopping is a plan", () => {
    expect(roleOfEvent("give_up")).toBe("planner");
    expect(roleOfEvent("error")).toBe("planner");
    expect(roleOfEvent("replan_exhausted")).toBe("planner");
  });

  it("gives consent and its withdrawal to security", () => {
    for (const event of ["need_approval", "approved", "denied", "cancel"]) {
      expect(roleOfEvent(event)).toBe("security");
    }
  });

  it("gives finishing to verify, because finishing is a claim about checks", () => {
    expect(roleOfEvent("finish")).toBe("verify");
  });
});

describe("engagement", () => {
  it("counts every line and shows the roles that did nothing as zero", () => {
    const roles = roleEngagement([
      { event: "planned" },
      { step: { tool: "run_command" } },
      { event: "verify", step: { tool: "run_command" } },
      { event: "step_ok", step: { tool: "run_command" } },
      { event: "finish" },
    ]);
    expect(roles.map((r) => r.role)).toEqual(ROLE_ORDER);
    const byRole = new Map(roles.map((r) => [r.role, r]));
    expect(byRole.get("planner")?.actions).toBe(1);
    expect(byRole.get("computer")?.actions).toBe(1);
    expect(byRole.get("verify")?.actions).toBe(3);
    // Shown, with a zero. Hiding it would turn a mission that never touched the web
    // into a Jarvis that cannot, which is a much larger claim.
    expect(byRole.get("research")?.actions).toBe(0);
    expect(byRole.get("research")?.engaged).toBe(false);
    expect(byRole.get("verify")?.engaged).toBe(true);
  });

  it("adds up to the number of lines it was given", () => {
    const lines = [
      {},
      { event: "planned" },
      { event: "retrieved" },
      { step: { tool: "web_search" } },
      { event: "need_approval", step: { tool: "run_command" } },
    ];
    const total = roleEngagement(lines).reduce((sum, r) => sum + r.actions, 0);
    expect(total).toBe(lines.length);
  });

  it("counts nothing from nothing", () => {
    const roles = roleEngagement([]);
    expect(roles).toHaveLength(ROLE_ORDER.length);
    expect(roles.every((r) => r.actions === 0 && !r.engaged)).toBe(true);
  });
});
