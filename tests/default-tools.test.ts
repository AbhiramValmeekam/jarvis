/**
 * Which capabilities a runtime actually offers.
 *
 * `default-tools.ts` is the only file that decides what an autonomous loop is
 * allowed to reach for, so the assertions here are almost all about absence: a
 * dependency that was not wired must produce a tool that is not registered,
 * rather than one that reports success for having done nothing (§43). A planner
 * reads `registry.list()` and plans against the answer, which is why a missing
 * tool has to cost a worse plan and never a step that fails at the last moment.
 *
 * Nothing here spawns a process or writes a file. Every dependency is the same
 * injected seam `tools.test.ts` uses.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildToolRegistry, defaultTools, type DefaultToolDeps } from "../src/tools/default-tools.js";
import { ToolRegistry, type Tool } from "../src/tools/registry.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { ReversibleFs } from "../src/permissions/reversible-fs.js";
import { fileCommsStore } from "../src/tools/adapters/comms.js";
import type { ProcessResult, ProcessRunner } from "../src/tools/process-run.js";
import type { ExecutorDeps } from "../src/local-intents/executors.js";
import type { ProjectEntry } from "../src/context/project-registry.js";

const T0 = 1_700_000_000_000;

/** A runner that refuses: nothing in this file is allowed to reach a process. */
const noRun: ProcessRunner = async (): Promise<ProcessResult> => {
  throw new Error("no process may be spawned from default-tools.test.ts");
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

function memoryStore(): MemoryStore {
  return new MemoryStore({
    path: join(mkdtempSync(join(tmpdir(), "jarvis-default-tools-")), "memory.json"),
    now: () => T0,
  });
}

function reversible(): ReversibleFs {
  return new ReversibleFs({
    run: async () => "",
    roots: ["E:\\code"],
    snapshotDir: join(tmpdir(), "jarvis-default-tools-snapshots"),
    now: () => T0,
  });
}

const PROJECTS: readonly ProjectEntry[] = [];

/** Every dependency wired, which is the shape a fully configured runtime has. */
const everything: DefaultToolDeps = {
  localIntents: { executorDeps: inertExecutorDeps, execute: async () => ({ ok: true, speech: "" }) },
  projects: () => PROJECTS,
  projectRoots: () => ["E:\\code"],
  memory: memoryStore(),
  reversible: reversible(),
  run: noRun,
  // A temp directory, so listing the comms tools cannot touch the outbox of
  // whoever is running the suite. Nothing here calls them.
  commsStore: fileCommsStore(mkdtempSync(join(tmpdir(), "jarvis-default-tools-mock-"))),
  // No key, so `web_search` is the labelled mock — which is the case worth
  // asserting, since it is the one a machine with no configuration is in.
  env: {},
  // A temp data directory and a launch that cannot launch: the coding-platform
  // tools are listed here, never run, and this file's rule is that nothing in it
  // reaches a process.
  codingPlatforms: {
    dataDir: mkdtempSync(join(tmpdir(), "jarvis-default-tools-handoff-")),
    launch: async () => {
      throw new Error("no editor may be started from default-tools.test.ts");
    },
    platforms: () => [],
  },
};

const names = (deps: DefaultToolDeps = {}): readonly string[] =>
  defaultTools(deps)
    .map((t) => t.name)
    .sort();

describe("a capability absent is a capability not registered", () => {
  it("offers the terminal and git with nothing configured at all", () => {
    // These two need no runtime state: a command runner and a git binary are
    // either on the machine or the call reports that they are not.
    const bare = names();
    expect(bare).toContain("run_command");
    expect(bare).toContain("git_status");
    expect(bare).toContain("git_list_commits");
    expect(bare).toContain("git_list_branches");
  });

  it("does not offer to route an intent with no executors wired", () => {
    expect(names()).not.toContain("run_local_intent");
    expect(names({ localIntents: everything.localIntents })).toContain("run_local_intent");
  });

  it("does not offer memory tools without a store", () => {
    const without = names();
    for (const t of ["list_memories", "search_memory", "write_memory", "delete_memory"]) {
      expect(without, `${t} registered with no MemoryStore`).not.toContain(t);
    }
    expect(names({ memory: memoryStore() })).toContain("search_memory");
  });

  it("does not offer project tools without a project source", () => {
    expect(names()).not.toContain("find_project");
    expect(names({ projects: () => PROJECTS })).toContain("find_project");
  });

  it("offers the coding platforms only when a place to stage a handoff exists too", () => {
    // Both halves are needed and neither substitutes for the other: the task is
    // handed over *for a project*, and the note has to be written somewhere Jarvis
    // owns. With one missing there is no honest version of the tool to offer.
    const staging = everything.codingPlatforms;
    expect(names({ projects: () => PROJECTS })).not.toContain("delegate_coding_task");
    expect(names({ ...(staging ? { codingPlatforms: staging } : {}) })).not.toContain(
      "delegate_coding_task",
    );
    const both = names({ projects: () => PROJECTS, ...(staging ? { codingPlatforms: staging } : {}) });
    expect(both).toContain("delegate_coding_task");
    expect(both).toContain("list_coding_platforms");
  });

  it("offers no way to change a file until a change can be taken back", () => {
    // The clearest case of the rule: a delete with no undo is not the tool the
    // plan named, so it is not in the list a planner reads. `write_file` goes with
    // it, because overwriting a file it could not snapshot is the same claim.
    const without = names();
    expect(without).toContain("read_file");
    expect(without).toContain("list_directory");
    expect(without).not.toContain("write_file");
    expect(without).not.toContain("delete_file");

    const withUndo = names({ reversible: reversible() });
    expect(withUndo).toContain("write_file");
    expect(withUndo).toContain("delete_file");
  });

  it("registers every adapter when every dependency is there", () => {
    expect(names(everything)).toEqual([
      "browse_follow",
      "browse_links",
      "browse_open",
      "create_calendar_event",
      "delegate_coding_task",
      "delete_file",
      "delete_memory",
      "fetch_web_page",
      "find_project",
      "git_list_branches",
      "git_list_commits",
      "git_status",
      "http_request",
      "list_calendar_events",
      "list_coding_platforms",
      "list_directory",
      "list_memories",
      "list_projects",
      "read_file",
      "run_command",
      "run_local_intent",
      "search_memory",
      "send_email",
      "web_search",
      "write_file",
      "write_memory",
    ]);
  });

  it("invents nothing: every tool comes from an adapter", () => {
    // The file's second stated property. If a name ever appears here that no
    // adapter exports, it was written in this layer, which is where it must not be.
    const adapters = new Set(names(everything));
    for (const tool of defaultTools(everything)) expect(adapters.has(tool.name)).toBe(true);
    expect(adapters.size).toBe(defaultTools(everything).length);
  });
});

describe("buildToolRegistry", () => {
  it("puts the whole list behind one registry", () => {
    const registry = buildToolRegistry(everything);
    expect(registry.size).toBe(defaultTools(everything).length);
    expect(registry.has("run_command")).toBe(true);
    expect(registry.get("delete_file")?.name).toBe("delete_file");
  });

  it("fails at construction rather than at call time on a duplicate name", () => {
    // Two tools answering to one name is a mission calling something other than
    // what the plan said. The process refusing to start is the better way to learn it.
    const registry = new ToolRegistry();
    for (const tool of defaultTools()) registry.register(tool);
    const impostor = { ...(defaultTools()[0] as Tool) };
    expect(() => registry.register(impostor)).toThrow(/duplicate tool/);
  });

  it("names no tool twice, so building it twice over is the same registry", () => {
    expect(() => buildToolRegistry(everything)).not.toThrow();
    expect(buildToolRegistry(everything).size).toBe(buildToolRegistry(everything).size);
  });
});

describe("what the tool list claims", () => {
  const info = (name: string) => buildToolRegistry(everything).list().find((t) => t.name === name);

  it("is sorted, so the pane does not reorder itself between reads", () => {
    const listed = buildToolRegistry(everything).list().map((t) => t.name);
    expect(listed).toEqual([...listed].sort((a, b) => a.localeCompare(b)));
  });

  it("takes the level from the classifier, not from the tool's own word", () => {
    // A reader is 0 and a delete is not; neither number is written in the adapter.
    expect(info("read_file")?.typicalLevel).toBe(0);
    expect(info("git_status")?.typicalLevel).toBe(0);
    expect(info("delete_file")?.typicalLevel).toBeGreaterThanOrEqual(2);
    expect(info("run_command")?.typicalLevel).toBeGreaterThanOrEqual(2);
  });

  it("carries a category for every tool", () => {
    for (const t of buildToolRegistry(everything).list()) {
      expect(t.category, `${t.name} has no category`).toBeTruthy();
      expect(t.summary, `${t.name} has no summary`).toBeTruthy();
    }
  });

  it("reports simulated as a boolean rather than leaving it absent", () => {
    // Absent would read as "real" at the first place that renders it.
    for (const t of buildToolRegistry(everything).list()) {
      expect(typeof t.simulated).toBe("boolean");
    }
  });

  it("claims nothing is simulated among the tools that reach the real world", () => {
    // Phase 13's set is entirely real, and so are the three that fetch: `fetch`
    // is a global and the guard is in this repository, so nothing about reading a
    // page is mocked. What *is* mocked is what has no account behind it.
    const simulated = buildToolRegistry(everything)
      .list()
      .filter((t) => t.simulated)
      .map((t) => t.name);
    expect(simulated.sort()).toEqual([
      "create_calendar_event",
      "list_calendar_events",
      "send_email",
      "web_search",
    ]);
  });

  it("says MOCK in the summary of every simulated tool, not only in the flag", () => {
    // The flag is for the wire; the sentence is for the person reading a report
    // who never saw the flag. §43 needs both.
    for (const t of buildToolRegistry(everything).list()) {
      if (!t.simulated) continue;
      expect(t.summary, `${t.name} is simulated but does not say so`).toMatch(/MOCK/);
    }
  });

  it("registers no interaction it cannot perform", () => {
    // A mocked click would leave a mission believing a form was submitted, and no
    // `simulated` label follows that belief into the report's conclusion. So the
    // text browser opens, lists and follows, and there is nothing else.
    const all = names(everything);
    for (const absent of ["browse_click", "browse_type", "browse_submit", "browse_screenshot"]) {
      expect(all, `${absent} is registered and cannot be honest`).not.toContain(absent);
    }
  });
});
