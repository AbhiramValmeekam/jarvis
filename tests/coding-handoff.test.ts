/**
 * Handing a coding task over, and the two tools that do it.
 *
 * The interesting cases here are all about what Jarvis *says* afterwards, which
 * is the part that was wrong before any of this existed: asked to open
 * Antigravity and tell it to build a page, it opened Antigravity and then had to
 * admit it could not say anything to it. So the assertions are mostly about
 * outcome and summary, not about spawning:
 *
 *  - a handoff is `unconfirmed` and never `verified`, because a person still has
 *    to paste — and the summary has to name that, since the summary is spoken;
 *  - a delegation to the real headless agent is `unchecked`, because the work is
 *    running and nothing here has looked at it;
 *  - a headless platform with no `delegate` wired up **fails** rather than
 *    quietly opening an editor instead, which would be a different answer
 *    wearing the same clothes.
 *
 * The clipboard is asserted through a recorded runner: what matters is that the
 * command line is the module's constant and the file path travelled in the
 * environment, so a task containing `&` or `>` is never re-parsed by anything.
 *
 * `stageHandoff` writes a real file — that is its first step and the one thing
 * it will not fake — so these use a real temp directory and remove it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageHandoff } from "../src/coding/handoff.js";
import { PLATFORMS, type InstalledPlatform } from "../src/coding/platforms.js";
import { codingPlatformTools } from "../src/tools/adapters/coding-platform.js";
import type { ProcessResult } from "../src/tools/process-run.js";
import type { ProjectEntry } from "../src/context/project-registry.js";
import type { Tool, ToolContext, ToolRun } from "../src/tools/registry.js";

/**
 * A long-form temp directory.
 *
 * `os.tmpdir()` reports an 8.3 alias on a machine whose account name has a space
 * in it, and a short path is a different string for every comparison downstream.
 * Resolving it here costs nothing and removes a whole class of local-only failure.
 */
function sandbox(): string {
  return mkdtempSync(join(realpathSync.native(tmpdir()), "jarvis-handoff-"));
}

function platform(id: string, command: string): InstalledPlatform {
  const spec = PLATFORMS.find((p) => p.id === id);
  if (!spec) throw new Error(`no such platform: ${id}`);
  return { spec, command, needsShell: false, foundVia: "install" };
}

const PROJECT: ProjectEntry = {
  key: "site",
  name: "site",
  dir: "C:\\work\\site",
  kind: "node",
  aliases: ["site"],
  root: "C:\\work",
};

const CTX: ToolContext = {
  roots: ["C:\\work"],
  now: () => 1_700_000_000_000,
  log: () => {},
  timeoutMs: 30_000,
};

/** A runner that records the call and answers a chosen exit code. */
function recorder(code: number | null = 0) {
  const calls: { file: string; args: readonly string[]; env?: Readonly<Record<string, string>> }[] = [];
  const run = async (
    file: string,
    args: readonly string[],
    opts: { env?: Readonly<Record<string, string>> },
  ): Promise<ProcessResult> => {
    calls.push({ file, args, ...(opts.env ? { env: opts.env } : {}) });
    return { code, stdout: "", stderr: "", timedOut: false };
  };
  return { run, calls };
}

/** A detached launch that records instead of starting anything. */
function launcher() {
  const calls: { file: string; args: readonly string[]; env?: Readonly<Record<string, string>> }[] = [];
  const launch = async (
    file: string,
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
  ): Promise<void> => {
    calls.push({ file, args, ...(env ? { env } : {}) });
  };
  return { launch, calls };
}

const tool = (tools: readonly Tool[], name: string): Tool => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

let dataDir = "";
beforeEach(() => {
  dataDir = sandbox();
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("staging a task for an editor that cannot be told one", () => {
  const TASK = 'make a small html page & call it "index" > done | now';

  it("writes the note under Jarvis' own directory, never into the project", () => {
    // A file appearing in someone's `git status` because they asked a question is
    // not an acceptable side effect of answering it.
    const { launch } = launcher();
    return stageHandoff(platform("antigravity", "C:\\ag\\Antigravity IDE.exe"), PROJECT.dir, TASK, {
      dataDir,
      launch,
      now: () => 1_700_000_000_000,
      exists: () => true,
    }).then((result) => {
      expect(result.taskFile).toBe(join(dataDir, "handoff", "task-1700000000000.md"));
      expect(result.taskFile.startsWith(dataDir)).toBe(true);
      const written = readFileSync(result.taskFile, "utf8");
      expect(written).toContain(TASK);
      expect(written).toContain("Antigravity IDE");
      expect(written).toContain(PROJECT.dir);
    });
  });

  it("opens the editor on the project with the note as a second argument", async () => {
    const { launch, calls } = launcher();
    const result = await stageHandoff(
      platform("antigravity", "C:\\ag\\Antigravity IDE.exe"),
      PROJECT.dir,
      TASK,
      { dataDir, launch, exists: () => true },
    );
    expect(result.opened).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("C:\\ag\\Antigravity IDE.exe");
    expect(calls[0]?.args).toEqual(["--reuse-window", PROJECT.dir, result.taskFile]);
  });

  it("copies the task alone, not the note that explains it", async () => {
    // A clipboard holding the note holds a heading, a timestamp and the line
    // "Paste this into the agent panel:" — and an agent panel reads a pasted
    // instruction as the prompt, so it would answer the note instead of doing the
    // work. The note is the tab; the `.txt` beside it is the paste.
    const { run, calls } = recorder(0);
    const { launch } = launcher();
    const result = await stageHandoff(
      platform("antigravity", "C:\\ag\\Antigravity IDE.exe"),
      PROJECT.dir,
      TASK,
      { dataDir, launch, run, platform: "win32", now: () => 1_700_000_000_000, exists: () => true },
    );
    expect(result.promptFile).toBe(join(dataDir, "handoff", "task-1700000000000.txt"));
    expect(readFileSync(result.promptFile, "utf8")).toBe(`${TASK}\n`);
    expect(readFileSync(result.taskFile, "utf8")).toContain("Paste this into the agent panel:");
    // The clipboard reads the paste-able copy, and the editor opens the note.
    expect(calls[0]?.env).toEqual({ JARVIS_HANDOFF_FILE: result.promptFile });
  });

  it("passes the file's path through the environment, not through a command line", async () => {
    // The property worth testing rather than the exit code: the only value that
    // varies goes somewhere no parser will look at it, so `&` and `>` inside a
    // spoken task cannot become punctuation.
    const { run, calls } = recorder(0);
    const { launch } = launcher();
    const result = await stageHandoff(
      platform("antigravity", "C:\\ag\\Antigravity IDE.exe"),
      PROJECT.dir,
      TASK,
      { dataDir, launch, run, platform: "win32", exists: () => true },
    );
    expect(result.copied).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("powershell.exe");
    const args = calls[0]?.args ?? [];
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(args[3]).toBe(
      "Set-Clipboard -Value (Get-Content -Raw -LiteralPath $env:JARVIS_HANDOFF_FILE)",
    );
    // Nothing from the task, and nothing from either path, is in the command itself.
    expect(args.join(" ")).not.toContain(result.taskFile);
    expect(args.join(" ")).not.toContain(result.promptFile);
    expect(args.join(" ")).not.toContain("index");
    expect(calls[0]?.env).toEqual({ JARVIS_HANDOFF_FILE: result.promptFile });
  });

  it("reports a clipboard that did not work instead of assuming it did", async () => {
    const { launch } = launcher();
    const refused = await stageHandoff(
      platform("antigravity", "C:\\ag\\Antigravity IDE.exe"),
      PROJECT.dir,
      TASK,
      { dataDir, launch, run: recorder(1).run, platform: "win32", exists: () => true },
    );
    expect(refused.copied).toBe(false);
    expect(refused.opened).toBe(true);

    // No runner, and not Windows: two more ways to have no clipboard, both of
    // which still leave a usable handoff.
    for (const deps of [
      { platform: "win32" as string | undefined },
      { platform: "darwin", run: recorder(0).run },
    ]) {
      const r = await stageHandoff(platform("trae", "C:\\trae\\Trae.exe"), PROJECT.dir, TASK, {
        dataDir,
        launch,
        exists: () => true,
        ...deps,
      });
      expect(r.copied).toBe(false);
      expect(r.taskFile).toBeTruthy();
    }
  });

  it("still writes the note when the editor will not start, and says which failed", async () => {
    const result = await stageHandoff(
      platform("antigravity", "C:\\ag\\Antigravity IDE.exe"),
      PROJECT.dir,
      TASK,
      {
        dataDir,
        launch: async () => {
          throw new Error("ENOENT");
        },
        exists: () => true,
      },
    );
    expect(result.opened).toBe(false);
    expect(result.problem).toMatch(/Antigravity IDE/);
    expect(readFileSync(result.taskFile, "utf8")).toContain(TASK);
  });
});

describe("list_coding_platforms", () => {
  it("says which of the installed ones can be given a task", async () => {
    const tools = codingPlatformTools({
      projects: () => [PROJECT],
      platforms: () => [
        platform("claude-code", "C:\\bin\\claude.exe"),
        platform("antigravity", "C:\\ag\\Antigravity IDE.exe"),
      ],
      dataDir,
      launch: launcher().launch,
    });
    const run = await tool(tools, "list_coding_platforms").run({}, CTX);
    expect(run.outcome).toBe("verified");
    expect(run.summary).toBe("2 installed, 1 that can be given a task directly");
    const listed = run.data?.platforms as { id: string; acceptsTask: boolean }[];
    expect(listed.map((p) => [p.id, p.acceptsTask])).toEqual([
      ["claude-code", true],
      ["antigravity", false],
    ]);
  });

  it("answers plainly when nothing is installed", async () => {
    const tools = codingPlatformTools({
      projects: () => [PROJECT],
      platforms: () => [],
      dataDir,
      launch: launcher().launch,
    });
    const run = await tool(tools, "list_coding_platforms").run({}, CTX);
    expect(run.outcome).toBe("verified");
    expect(run.summary).toBe("no coding platform is installed here");
    expect(run.data?.platforms).toEqual([]);
  });
});

describe("delegate_coding_task", () => {
  const ANTIGRAVITY = platform("antigravity", "C:\\ag\\Antigravity IDE.exe");
  const CLAUDE = platform("claude-code", "C:\\bin\\claude.exe");
  const VSCODE = platform("vscode", "C:\\vsc\\Code.exe");

  function build(over: Partial<Parameters<typeof codingPlatformTools>[0]> = {}) {
    const { launch, calls } = launcher();
    const tools = codingPlatformTools({
      projects: () => [PROJECT],
      platforms: () => [ANTIGRAVITY],
      dataDir,
      launch,
      run: recorder(0).run,
      platform: "win32",
      // Every catalogued binary is present unless a case says otherwise, so a
      // test about outcomes is not also a test about this machine's disk.
      exists: () => true,
      ...over,
    });
    return { tool: tool(tools, "delegate_coding_task"), launched: calls };
  }

  it("stages a handoff and reports the paste as outstanding", async () => {
    // `unconfirmed`, and the summary names the paste: something happened, and the
    // thing that was asked for has not. Both halves are load-bearing — `failed`
    // would be wrong in the other direction, and `verified` would be a claim
    // about work that has not started.
    const { tool: t, launched } = build();
    const run = await t.run({ task: "make a small html page", project: "site" }, CTX);
    expect(run.outcome).toBe("unconfirmed");
    expect(run.summary).toBe(
      "opened Antigravity IDE on site; the task is on the clipboard, paste it into the agent panel",
    );
    expect(run.data?.delivered).toBe(false);
    expect(run.data?.copied).toBe(true);
    // Both files are named, because they are for different readers: the `.md` is
    // the tab a person reads, the `.txt` is what the clipboard holds.
    expect(String(run.data?.taskFile)).toMatch(/\.md$/);
    expect(String(run.data?.promptFile)).toMatch(/\.txt$/);
    expect(launched).toHaveLength(1);
    expect(launched[0]?.args).toContain(PROJECT.dir);
  });

  it("goes through the runtime's own manager for the headless agent", async () => {
    // Never around it. The cap, the budget, the project-scoped cwd and the
    // after-the-fact work check all live there, and a spoken sentence must not be
    // able to skip them by asking for the same thing a different way.
    const seen: { task: string; project: string }[] = [];
    const { tool: t, launched } = build({
      platforms: () => [CLAUDE, ANTIGRAVITY],
      delegate: async (task, project) => {
        seen.push({ task, project: project.key });
        return { id: "job-1", detail: "job job-1 started in C:\\work\\site" };
      },
    });
    const run = await t.run({ task: "fix the failing test" }, CTX);
    expect(run.outcome).toBe("unchecked");
    expect(run.data?.jobId).toBe("job-1");
    expect(seen).toEqual([{ task: "fix the failing test", project: "site" }]);
    // Nothing was spawned here: the manager owns that.
    expect(launched).toEqual([]);
  });

  it("fails rather than downgrading to a handoff when the agent is not wired up", async () => {
    const { tool: t, launched } = build({ platforms: () => [CLAUDE] });
    const run = await t.run({ task: "fix the failing test" }, CTX);
    expect(run.outcome).toBe("failed");
    expect(run.error).toMatch(/no delegate/);
    expect(launched).toEqual([]);
  });

  it("spawns another headless platform's CLI with the task as one argument", async () => {
    // The whole reason `platform-invoke.ts` exists, asserted end to end: the task
    // arrives as the last element of an argv, `ELECTRON_RUN_AS_NODE` is what makes
    // the app binary run the CLI file, and no shell is involved — so a task with
    // `&` in it is a task and not two commands.
    const { tool: t, launched } = build({
      platforms: () => [VSCODE],
      exists: (path) =>
        path === "C:\\vsc\\Code.exe" || path === "C:\\vsc\\resources\\app\\out\\cli.js",
    });
    const run = await t.run({ task: "-p make a page & sign it" }, CTX);
    expect(run.outcome).toBe("unchecked");
    expect(run.data?.delivered).toBe(true);
    expect(launched).toHaveLength(1);
    expect(launched[0]?.file).toBe("C:\\vsc\\Code.exe");
    expect(launched[0]?.args).toEqual([
      "C:\\vsc\\resources\\app\\out\\cli.js",
      "chat",
      "-m",
      "agent",
      "--reuse-window",
      "--",
      "-p make a page & sign it",
    ]);
    expect(launched[0]?.env).toEqual({ ELECTRON_RUN_AS_NODE: "1", VSCODE_DEV: "" });
  });

  it("reports a headless platform whose CLI is missing instead of finding a way round", async () => {
    // The way round is `cmd.exe`, and that is where a prompt stops being one
    // argument. `no-cli` names the installation as the odd thing, not the contract.
    const { tool: t, launched } = build({
      platforms: () => [VSCODE],
      exists: (path) => path === "C:\\vsc\\Code.exe",
      readdir: () => [],
    });
    const run = await t.run({ task: "make a page" }, CTX);
    expect(run.outcome).toBe("failed");
    expect(run.error).toBe("prompt channel unavailable: no-cli");
    expect(run.data?.refused).toBe("no-cli");
    expect(launched).toEqual([]);
  });

  it("picks the strongest installed platform when none was named", async () => {
    const { tool: t } = build({
      platforms: () => [CLAUDE, ANTIGRAVITY],
      delegate: async () => ({ id: "job-2", detail: "started" }),
    });
    const run = await t.run({ task: "build it" }, CTX);
    expect((run.data?.platform as { id: string }).id).toBe("claude-code");
  });

  it("refuses a platform that is not here, and lists what is", async () => {
    const { tool: t } = build();
    const run = await t.run({ task: "build it", platform: "cursor" }, CTX);
    expect(run.outcome).toBe("failed");
    expect(run.summary).toBe("cursor is not installed here");
    expect(run.detail).toBe("installed: Antigravity IDE");
  });

  it("asks which project when there is more than one and none was named", async () => {
    // The alternative is guessing, and guessing here is an agent editing the
    // wrong repository.
    const second: ProjectEntry = { ...PROJECT, key: "api", name: "api", dir: "C:\\work\\api", aliases: ["api"] };
    const { tool: t, launched } = build({ projects: () => [PROJECT, second] });
    const run = await t.run({ task: "build it" }, CTX);
    expect(run.outcome).toBe("failed");
    expect(run.summary).toMatch(/name a project/);
    expect(launched).toEqual([]);
  });

  it("fails when nothing at all is installed", async () => {
    const { tool: t } = build({ platforms: () => [] });
    const run = await t.run({ task: "build it" }, CTX);
    expect(run.outcome).toBe("failed");
    expect(run.summary).toBe("nothing installed here can be given a coding task");
  });

  it("never reports `verified`, whichever path it took", async () => {
    // The one blanket rule. This tool hands work to an actor and does not look at
    // the result, so it is in no position to grade it — `verified-action.ts` is
    // written to stop exactly that, and a coding task is the case where a wrong
    // "done" costs the most.
    const runs: ToolRun[] = [];
    const handoff = build();
    runs.push(await handoff.tool.run({ task: "a" }, CTX));
    const headless = build({
      platforms: () => [CLAUDE],
      delegate: async () => ({ id: "j", detail: "d" }),
    });
    runs.push(await headless.tool.run({ task: "a" }, CTX));
    for (const r of runs) expect(r.outcome).not.toBe("verified");
  });
});
