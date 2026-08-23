/**
 * The tool registry and its Phase 13 adapters.
 *
 * What these tests are actually about: a mission step is arguments from a planner,
 * and in Phase 14 that planner is a model. So the interesting assertions are the
 * refusals — a `cwd` outside the roots, an `npm install`, a `node -e` — and the
 * honesty of the outcomes: exit code 3 is `failed`, not "the build ran".
 *
 * No process is spawned. `ProcessRunner` is injected everywhere, which is the same
 * seam `executors.test.ts` uses, and the reason `run_command` can be tested at all
 * without a project on disk.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ToolRegistry,
  validateArgs,
  type Tool,
  type ToolContext,
  type ToolRun,
} from "../src/tools/registry.js";
import { terminalTools } from "../src/tools/adapters/terminal.js";
import { gitTools } from "../src/tools/adapters/git.js";
import { filesystemTools } from "../src/tools/adapters/filesystem.js";
import { localIntentTools } from "../src/tools/adapters/local-intent.js";
import { projectTools } from "../src/tools/adapters/project.js";
import { memoryTools } from "../src/tools/adapters/memory.js";
import type { ExecOutcome, ExecutorDeps } from "../src/local-intents/executors.js";
import type { LocalIntentId } from "../src/local-intents/intent-model.js";
import type { ProjectEntry } from "../src/context/project-registry.js";
import { MemoryStore } from "../src/memory/memory-store.js";
import { outputTail, type ProcessResult, type ProcessRunner } from "../src/tools/process-run.js";

/** A fixed clock, so nothing here reads the wall time. */
const T0 = 1_700_000_000_000;

function root(): string {
  return mkdtempSync(join(tmpdir(), "jarvis-tools-"));
}

function context(roots: readonly string[], timeoutMs = 30_000): ToolContext {
  return { roots, now: () => Date.now(), log: () => {}, timeoutMs };
}

/** A runner that records what it was asked to spawn and replays canned results. */
function fakeRunner(
  results: readonly Partial<ProcessResult>[],
): { readonly run: ProcessRunner; readonly calls: { file: string; args: readonly string[] }[] } {
  const calls: { file: string; args: readonly string[] }[] = [];
  let index = 0;
  const run: ProcessRunner = async (file, args) => {
    calls.push({ file, args });
    const canned = results[Math.min(index++, results.length - 1)] ?? {};
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...canned };
  };
  return { run, calls };
}

/** Prepare and invoke through the real registry — refusals included. */
async function call(
  tools: readonly Tool[],
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolRun> {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const prepared = registry.prepare(name, args);
  if (!prepared.ok) {
    return { outcome: "failed", summary: "rejected before running", error: prepared.reason };
  }
  return registry.invoke(prepared, { roots: ctx.roots, now: ctx.now, log: ctx.log });
}

const echoTool: Tool = {
  name: "read_thing",
  summary: "test tool",
  schema: { text: { kind: "string", required: true, max: 20 } },
  async run(args): Promise<ToolRun> {
    return { outcome: "verified", summary: String(args.text) };
  },
};

describe("argument validation", () => {
  it("rejects a missing required field, a wrong type and an over-long string", () => {
    const schema = { path: { kind: "string", required: true, max: 8 } } as const;
    expect(validateArgs(schema, {})).toEqual({ ok: false, reason: "path is required" });
    expect(validateArgs(schema, { path: 4 })).toEqual({ ok: false, reason: "path must be a string" });
    expect(validateArgs(schema, { path: "x".repeat(9) })).toEqual({
      ok: false,
      reason: "path is too long",
    });
  });

  it("enforces oneOf, integer and list bounds", () => {
    expect(
      validateArgs({ p: { kind: "string", oneOf: ["npm", "node"] } }, { p: "curl" }).ok,
    ).toBe(false);
    expect(validateArgs({ n: { kind: "number", integer: true } }, { n: 1.5 }).ok).toBe(false);
    expect(validateArgs({ n: { kind: "number", min: 1, max: 3 } }, { n: 9 }).ok).toBe(false);
    expect(validateArgs({ a: { kind: "stringArray", maxItems: 2 } }, { a: ["x", "y", "z"] }).ok).toBe(
      false,
    );
  });

  it("drops a key the schema does not name, so it cannot reach the tool", () => {
    const checked = validateArgs({ keep: { kind: "string" } }, { keep: "a", extra: "b" });
    expect(checked).toEqual({ ok: true, args: { keep: "a" } });
  });
});

describe("the registry", () => {
  it("refuses a duplicate name and an unknown one", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    expect(() => registry.register(echoTool)).toThrow(/duplicate/);
    const prepared = registry.prepare("no_such_tool", {});
    expect(prepared.ok).toBe(false);
  });

  it("classifies a call from its name, before the tool is reached", () => {
    const registry = new ToolRegistry();
    for (const tool of terminalTools()) registry.register(tool);
    for (const tool of gitTools()) registry.register(tool);
    const listed = registry.list();
    const levels = new Map(listed.map((t) => [t.name, t.typicalLevel]));
    // A commit listing is a read; running a command is an execute. This is the
    // whole reason the names are `verb_noun`.
    expect(levels.get("git_list_commits")).toBe(0);
    expect(levels.get("git_status")).toBe(0);
    expect(levels.get("run_command")).toBeGreaterThanOrEqual(2);
  });

  it("sanitises display text on the way out", async () => {
    const run = await call([echoTool], "read_thing", { text: "a‮b\nc" }, context([]));
    expect(run.summary).not.toContain("‮");
    expect(run.summary).not.toContain("\n");
  });

  it("turns a throwing tool into a failed step rather than an exception", async () => {
    const thrower: Tool = {
      name: "read_broken",
      summary: "throws",
      schema: {},
      async run(): Promise<ToolRun> {
        throw new Error("boom");
      },
    };
    const run = await call([thrower], "read_broken", {}, context([]));
    expect(run.outcome).toBe("failed");
    expect(run.error).toContain("boom");
  });

  it("stops waiting on a tool that hangs, and says so", async () => {
    const hanging: Tool = {
      name: "read_hang",
      summary: "never returns",
      schema: {},
      timeoutMs: 20,
      run: () => new Promise<ToolRun>(() => {}),
    };
    const run = await call([hanging], "read_hang", {}, context([]));
    expect(run.outcome).toBe("failed");
    expect(run.error).toMatch(/timed out/);
  });

  it("keeps a declared-simulated tool from reporting a real success", async () => {
    const mock: Tool = {
      name: "read_mock",
      summary: "mock",
      schema: {},
      simulated: true,
      async run(): Promise<ToolRun> {
        return { outcome: "verified", summary: "done" };
      },
    };
    const run = await call([mock], "read_mock", {}, context([]));
    expect(run.simulated).toBe(true);
  });
});

describe("run_command", () => {
  it("refuses a directory outside the roots", async () => {
    const fake = fakeRunner([{}]);
    const run = await call(
      terminalTools({ run: fake.run }),
      "run_command",
      { program: "npm", args: ["test"], cwd: "C:\\Windows\\System32" },
      context([root()]),
    );
    expect(run.outcome).toBe("failed");
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses npm install, and names the command that is allowed instead", async () => {
    const dir = root();
    const fake = fakeRunner([{}]);
    const run = await call(
      terminalTools({ run: fake.run }),
      "run_command",
      { program: "npm", args: ["install", "express"], cwd: dir },
      context([dir]),
    );
    expect(run.outcome).toBe("failed");
    expect(run.error).toMatch(/npm ci/);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a subcommand and a program that are not on the list", async () => {
    const dir = root();
    const fake = fakeRunner([{}]);
    const tools = terminalTools({ run: fake.run });
    const publish = await call(tools, "run_command", { program: "npm", args: ["publish"], cwd: dir }, context([dir]));
    expect(publish.outcome).toBe("failed");
    const curl = await call(tools, "run_command", { program: "curl", args: [], cwd: dir }, context([dir]));
    expect(curl.outcome).toBe("failed");
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses node -e, because that is code from the plan rather than the project", async () => {
    const dir = root();
    const fake = fakeRunner([{}]);
    const run = await call(
      terminalTools({ run: fake.run }),
      "run_command",
      { program: "node", args: ["-e", "require('fs').rmSync('C:/', {recursive:true})"], cwd: dir },
      context([dir]),
    );
    expect(run.outcome).toBe("failed");
    expect(run.error).toMatch(/not available to a mission/);
    expect(fake.calls).toHaveLength(0);
  });

  it("verifies a command by its exit code, and reports the tail", async () => {
    const dir = root();
    const fake = fakeRunner([{ code: 0, stdout: "built in 2.1s\n" }]);
    const run = await call(
      terminalTools({ run: fake.run, execPath: "C:\\node\\node.exe", platform: "win32" }),
      "run_command",
      { program: "npm", args: ["run", "build"], cwd: dir },
      context([dir]),
    );
    expect(run.outcome).toBe("verified");
    expect(run.summary).toContain("npm run build");
    expect(run.detail).toContain("built in 2.1s");
    expect(run.data?.code).toBe(0);
    // npm never arrives as `npm` — the shim cannot be spawned, so it is resolved
    // to a program this file chose.
    expect(fake.calls[0]?.file).not.toBe("npm");
    expect(fake.calls[0]?.args.slice(-2)).toEqual(["run", "build"]);
  });

  it("reports a non-zero exit as failed, not as an unclear result", async () => {
    const dir = root();
    const fake = fakeRunner([
      { code: 1, stdout: "", stderr: "src/a.ts(3,1): error TS2339: nope\n" },
    ]);
    const run = await call(
      terminalTools({ run: fake.run }),
      "run_command",
      { program: "npm", args: ["run", "typecheck"], cwd: dir },
      context([dir]),
    );
    expect(run.outcome).toBe("failed");
    expect(run.error).toContain("exit code 1");
    expect(run.detail).toContain("TS2339");
    expect(run.data?.code).toBe(1);
  });

  it("reports a timeout as its own fact", async () => {
    const dir = root();
    const fake = fakeRunner([{ code: null, timedOut: true }]);
    const run = await call(
      terminalTools({ run: fake.run }),
      "run_command",
      { program: "npm", args: ["test"], cwd: dir },
      context([dir]),
    );
    expect(run.outcome).toBe("failed");
    expect(run.data?.timedOut).toBe(true);
  });

  it("runs a file with this interpreter, and never the string `node`", async () => {
    const dir = root();
    const fake = fakeRunner([{ code: 0, stdout: "ok" }]);
    const run = await call(
      terminalTools({ run: fake.run, execPath: "C:\\node\\node.exe" }),
      "run_command",
      { program: "node", args: ["scripts/check.js", "--fast"], cwd: dir },
      context([dir]),
    );
    expect(run.outcome).toBe("verified");
    expect(fake.calls[0]).toEqual({
      file: "C:\\node\\node.exe",
      args: ["scripts/check.js", "--fast"],
    });
  });
});

const FS_SEP = String.fromCharCode(31);
const RS_SEP = String.fromCharCode(30);

describe("read-only git", () => {
  it("reads a branch and counts changes, keeping untracked files separate", async () => {
    const dir = root();
    const fake = fakeRunner([
      {
        stdout: [
          "## main...origin/main [ahead 1]",
          " M src/a.ts",
          "A  src/b.ts",
          "?? notes.md",
        ].join("\n"),
      },
    ]);
    const run = await call(gitTools({ run: fake.run }), "git_status", { path: dir }, context([dir]));
    expect(run.outcome).toBe("verified");
    expect(run.data).toMatchObject({ branch: "main", changed: 2, untracked: 1, clean: false });
    // Every invocation carries the flag, so an ownership refusal is the exception
    // rather than the default.
    expect(fake.calls[0]?.args[0]).toBe("-c");
    expect(String(fake.calls[0]?.args[1])).toMatch(/^safe\.directory=/);
  });

  it("reports an ownership refusal with the fix, instead of a clean tree", async () => {
    const dir = root();
    const fake = fakeRunner([
      {
        code: 128,
        stderr:
          "fatal: detected dubious ownership in repository at 'E:/jarvis'\n'E:/jarvis' is owned by:",
      },
    ]);
    const run = await call(gitTools({ run: fake.run }), "git_status", { path: dir }, context([dir]));
    expect(run.outcome).toBe("failed");
    expect(run.error).toContain("safe.directory E:/jarvis");
    // Retried once with the path git itself named, and then not again.
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.args[1]).toBe("safe.directory=E:/jarvis");
  });

  it("does not retry when the refusal names the directory already tried", async () => {
    const dir = root();
    const named = dir.replace(/\\/g, "/");
    const fake = fakeRunner([
      { code: 128, stderr: `fatal: detected dubious ownership in repository at '${named}'` },
    ]);
    const run = await call(gitTools({ run: fake.run }), "git_status", { path: dir }, context([dir]));
    expect(run.outcome).toBe("failed");
    expect(fake.calls).toHaveLength(1);
  });

  it("parses commits whose subjects contain the characters a naive split would eat", async () => {
    const dir = root();
    const subject = "fix: handle a | pipe, a --flag and 'quotes'";
    const fake = fakeRunner([
      {
        stdout: [
          ["abc1234", "Ada", "2 hours ago", subject].join(FS_SEP) + RS_SEP,
          ["def5678", "Grace", "3 days ago", "docs: why"].join(FS_SEP) + RS_SEP,
        ].join("\n"),
      },
    ]);
    const run = await call(
      gitTools({ run: fake.run }),
      "git_list_commits",
      { path: dir, count: 2 },
      context([dir]),
    );
    expect(run.outcome).toBe("verified");
    const commits = run.data?.commits as readonly { subject: string; author: string }[];
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      hash: "abc1234",
      author: "Ada",
      when: "2 hours ago",
      subject,
    });
    expect(fake.calls[0]?.args).toContain("-n2");
  });

  it("rejects a commit count outside the schema before git is reached", async () => {
    const dir = root();
    const fake = fakeRunner([{}]);
    const run = await call(
      gitTools({ run: fake.run }),
      "git_list_commits",
      { path: dir, count: 5_000 },
      context([dir]),
    );
    expect(run.outcome).toBe("failed");
    expect(fake.calls).toHaveLength(0);
  });

  it("marks the current branch", async () => {
    const dir = root();
    const fake = fakeRunner([
      {
        stdout: [
          ["*", "main", "abc1234"].join(FS_SEP),
          [" ", "feature/voice", "def5678"].join(FS_SEP),
        ].join("\n"),
      },
    ]);
    const run = await call(
      gitTools({ run: fake.run }),
      "git_list_branches",
      { path: dir },
      context([dir]),
    );
    expect(run.outcome).toBe("verified");
    expect(run.data?.current).toBe("main");
    expect(run.summary).toContain("2 branches");
  });
});

describe("filesystem tools", () => {
  it("does not offer a write or a delete without an undo layer", () => {
    const names = filesystemTools().map((t) => t.name);
    expect(names).toEqual(["read_file", "list_directory"]);
  });

  it("denies everything when no root is configured", async () => {
    const dir = root();
    writeFileSync(join(dir, "a.txt"), "hello", "utf8");
    const run = await call(filesystemTools(), "read_file", { path: join(dir, "a.txt") }, context([]));
    expect(run.outcome).toBe("failed");
    expect(run.summary).toBe("refused");
  });

  it("reads a file inside a root and reports its size", async () => {
    const dir = root();
    writeFileSync(join(dir, "a.txt"), "hello", "utf8");
    const run = await call(
      filesystemTools(),
      "read_file",
      { path: join(dir, "a.txt") },
      context([dir]),
    );
    expect(run.outcome).toBe("verified");
    expect(run.data?.text).toBe("hello");
    expect(run.summary).toContain("5 characters");
  });

  it("refuses a path that climbs out of the root", async () => {
    const dir = root();
    const run = await call(
      filesystemTools(),
      "read_file",
      { path: join(dir, "..", "..", "windows", "win.ini") },
      context([dir]),
    );
    expect(run.outcome).toBe("failed");
  });
});

describe("outputTail", () => {
  it("keeps the end, where a build says why", () => {
    const result: ProcessResult = {
      code: 1,
      stdout: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"),
      stderr: "error TS1005",
      timedOut: false,
    };
    const tail = outputTail(result, 3);
    expect(tail).toBe("line 38 · line 39 · error TS1005");
  });

  it("says so when there was nothing", () => {
    expect(outputTail({ code: 0, stdout: "", stderr: "", timedOut: false })).toBe("no output");
  });
});

/** Everything the executors touch the machine through, stubbed to touch nothing. */
const inertExecutorDeps: ExecutorDeps = {
  run: async () => "",
  launch: async () => {},
  apps: new Map(),
  screenshotRoots: [],
  now: () => new Date(T0),
  setMicMuted: () => true,
  isMicMuted: () => false,
};

/** The classification a call gets, which is what the permission engine sees. */
function levelOf(tools: readonly Tool[], name: string, args: Record<string, unknown>): number {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const prepared = registry.prepare(name, args);
  if (!prepared.ok) throw new Error(prepared.reason);
  return prepared.classification.level;
}

describe("run_local_intent", () => {
  const tools = (outcome: ExecOutcome, seen?: { id?: LocalIntentId }): readonly Tool[] =>
    localIntentTools({
      executorDeps: inertExecutorDeps,
      execute: async (match) => {
        if (seen) seen.id = match.id;
        return outcome;
      },
    });

  it("classifies the effect it routed to, not the wrapper", () => {
    const ready = tools({ ok: true, speech: "" });
    // A clock reading must not cost a consent dialog; opening a URL must.
    expect(levelOf(ready, "run_local_intent", { request: "what time is it" })).toBe(0);
    expect(
      levelOf(ready, "run_local_intent", { request: "open jarvis.dev in the browser" }),
    ).toBeGreaterThanOrEqual(3);
    // Nothing to route: the fail-closed reading of a wrapper that could do anything.
    expect(levelOf(ready, "run_local_intent", { request: "ponder the meaning of npm" })).toBe(3);
  });

  it("passes the matched intent through and reports what the executor said", async () => {
    const seen: { id?: LocalIntentId } = {};
    const run = await call(
      tools({ ok: true, speech: "It's 3:04 PM." }, seen),
      "run_local_intent",
      { request: "what time is it" },
      context([]),
    );
    expect(seen.id).toBe("time.now");
    expect(run.outcome).toBe("verified");
    expect(run.summary).toBe("It's 3:04 PM.");
    expect(run.data?.intent).toBe("time.now");
  });

  it("does not claim a lock it cannot see", async () => {
    const run = await call(
      tools({ ok: true, speech: "Locking." }),
      "run_local_intent",
      { request: "lock the computer" },
      context([]),
    );
    // The executor fired `LockWorkStation` and returned. Nothing looked afterwards,
    // so this is `unconfirmed` — which is an answer, not a failure.
    expect(run.outcome).toBe("unconfirmed");
  });

  it("fails with the question when the matcher will not guess", async () => {
    const run = await call(tools({ ok: true, speech: "" }), "run_local_intent", { request: "mute" }, context([]));
    expect(run.outcome).toBe("failed");
    expect(run.error).toMatch(/microphone|speakers/i);
  });

  it("fails with a reason when nothing local matches", async () => {
    const run = await call(
      tools({ ok: true, speech: "" }),
      "run_local_intent",
      { request: "refactor the payment module" },
      context([]),
    );
    expect(run.outcome).toBe("failed");
    expect(run.summary).toContain("no built-in action");
  });

  it("refuses screen.read, because a step has no agent to hand an image to", async () => {
    const run = await call(
      tools({ ok: true, speech: "" }),
      "run_local_intent",
      { request: "read the screen" },
      context([]),
    );
    expect(run.outcome).toBe("failed");
    expect(run.error).toMatch(/agent session/);
  });

  it("reports an executor's own failure as the step's failure", async () => {
    const run = await call(
      tools({ ok: false, speech: "I couldn't change the volume.", detail: "unreadable" }),
      "run_local_intent",
      { request: "set the volume to 40" },
      context([]),
    );
    expect(run.outcome).toBe("failed");
    expect(run.error).toBe("unreadable");
  });
});

const PROJECTS: readonly ProjectEntry[] = [
  { key: "jarvis", name: "jarvis", dir: "E:\\jarvis", kind: "node", aliases: ["jarvis"], root: "E:\\" },
  { key: "site", name: "site", dir: "E:\\site", kind: "git", aliases: ["site", "portfolio"], root: "E:\\" },
  { key: "twin", name: "twin", dir: "E:\\a\\twin", kind: "node", aliases: ["portfolio"], root: "E:\\" },
];

describe("project tools", () => {
  it("tells an empty registry apart from an unconfigured one", async () => {
    const none = await call(
      projectTools({ projects: () => [], projectRoots: () => [] }),
      "list_projects",
      {},
      context([]),
    );
    expect(none.summary).toContain("no project folders are configured");
    const empty = await call(
      projectTools({ projects: () => [], projectRoots: () => ["E:\\code"] }),
      "list_projects",
      {},
      context([]),
    );
    expect(empty.summary).toContain("1 configured folder");
  });

  it("resolves a name to a directory a later step can use", async () => {
    const run = await call(
      projectTools({ projects: () => PROJECTS }),
      "find_project",
      { name: "jarvis" },
      context([]),
    );
    expect(run.outcome).toBe("verified");
    expect(run.data).toMatchObject({ key: "jarvis", dir: "E:\\jarvis", kind: "node" });
  });

  it("refuses to pick when two projects answer to one word", async () => {
    const run = await call(
      projectTools({ projects: () => PROJECTS }),
      "find_project",
      { name: "portfolio" },
      context([]),
    );
    expect(run.outcome).toBe("failed");
    expect(run.error).toContain("2 projects match");
  });
});

describe("memory tools", () => {
  const store = (): MemoryStore =>
    new MemoryStore({ path: join(root(), "memory.json"), now: () => T0 });

  it("saves, finds and forgets, verifying each by reading the store back", async () => {
    const memory = store();
    const tools = memoryTools({ store: memory });
    const saved = await call(tools, "write_memory", { text: "the build script is npm run verify" }, context([]));
    expect(saved.outcome).toBe("verified");
    const id = String(saved.data?.id);

    const found = await call(tools, "search_memory", { query: "build script" }, context([]));
    expect(found.outcome).toBe("verified");
    expect(found.data?.total).toBe(1);

    const gone = await call(tools, "delete_memory", { id }, context([]));
    expect(gone.outcome).toBe("verified");
    expect(memory.entriesList()).toHaveLength(0);
  });

  it("passes the store's refusal of a secret straight through", async () => {
    const run = await call(
      memoryTools({ store: store() }),
      "write_memory",
      { text: "my api key is sk-ant-0000000000000000000000000000000000" },
      context([]),
    );
    expect(run.outcome).toBe("failed");
    expect(run.summary.toLowerCase()).toMatch(/won't|not|can't|refuse/);
  });

  it("treats no match as a reading rather than a failure", async () => {
    const run = await call(memoryTools({ store: store() }), "search_memory", { query: "anything" }, context([]));
    expect(run.outcome).toBe("verified");
    expect(run.data?.total).toBe(0);
  });

  it("does not report forgetting something that was never there", async () => {
    const run = await call(memoryTools({ store: store() }), "delete_memory", { id: "nope" }, context([]));
    expect(run.outcome).toBe("failed");
  });

  it("classifies forgetting as a delete, so it asks", () => {
    expect(levelOf(memoryTools({ store: store() }), "delete_memory", { id: "abc" })).toBeGreaterThanOrEqual(2);
    expect(levelOf(memoryTools({ store: store() }), "search_memory", { query: "abc" })).toBe(0);
  });
});
