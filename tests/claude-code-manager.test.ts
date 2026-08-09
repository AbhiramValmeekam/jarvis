/**
 * The manager, driven through real child processes.
 *
 * `spawn` is not mocked. A fake spawn proves that the code calls a function, and
 * this class exists to handle things a function call cannot simulate: a process
 * that never exits until SIGTERM, one that prints garbage and exits non-zero,
 * one that cannot be started at all. Those are the paths that hang an always-on
 * assistant, so they are driven with `node -e` scripts that really do it.
 *
 * The stub stands in for the CLI, not for the contract: what it prints is copied
 * from real `claude -p --output-format json` output.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeManager, type CodingJob } from "../src/coding/claude-code-manager.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-coding-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A stub CLI: a .mjs file run by this same node binary.
 *
 * Written to disk rather than passed with `-e`, because the manager spawns
 * `[claudePath, ...args]` and the args must land where the real CLI's would.
 */
function stub(body: string): { path: string } {
  const p = join(dir, `stub-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(p, body, "utf8");
  return { path: p };
}

function manager(scriptPath: string, over: Partial<{ maxConcurrent: number }> = {}) {
  const logs: string[] = [];
  const m = new ClaudeCodeManager({
    allowedRoots: () => [dir],
    claudePath: process.execPath,
    // The stub path is prepended so the manager's own args follow it, exactly
    // as they would follow the real executable.
    spawnFn: ((_file: string, args: readonly string[], opts: object) =>
      spawn(process.execPath, [scriptPath, ...args], opts)) as never,
    onLog: (l) => logs.push(l),
    ...over,
  });
  return { m, logs };
}

/** Wait for the `finished` event for a specific job. */
function finished(m: ClaudeCodeManager, id: string): Promise<CodingJob> {
  return new Promise((resolve) => {
    m.on("finished", (j: CodingJob) => {
      if (j.id === id) resolve(j);
    });
  });
}

const OK_ENVELOPE = `{"is_error":false,"num_turns":2,"session_id":"s-1","total_cost_usd":0.02,` +
  `"terminal_reason":"completed","api_error_status":null,"result":"done","duration_ms":10,` +
  `"permission_denials":[]}`;

describe("ClaudeCodeManager", () => {
  it("returns before the task finishes, so the voice loop keeps running", async () => {
    // The requirement in one test: `start` resolves while the child is alive.
    const { path } = stub(`setTimeout(() => { console.log(${JSON.stringify(OK_ENVELOPE)}); }, 300);`);
    const { m } = manager(path);

    const job = await m.start({ task: "refactor the parser", cwd: dir, permissionMode: "acceptEdits" });
    expect(job.state).toBe("running");
    expect(m.running()).toHaveLength(1);

    const done = await finished(m, job.id);
    expect(done.result?.status).toBe("reported");
    expect(m.running()).toHaveLength(0);
    expect(m.recent()[0]?.id).toBe(job.id);
  });

  it("refuses a directory the user never nominated", async () => {
    const { path } = stub(`console.log(${JSON.stringify(OK_ENVELOPE)});`);
    const { m } = manager(path);
    // The point is not path syntax. It is that a sentence from a microphone
    // must not be able to aim a file-editing agent at the system directory.
    await expect(
      m.start({ task: "clean up", cwd: "C:\\Windows", permissionMode: "acceptEdits" }),
    ).rejects.toThrow(/outside a known project/);
  });

  it("accepts a known project whose path differs only in case and slashes", async () => {
    const { path } = stub(`console.log(${JSON.stringify(OK_ENVELOPE)});`);
    const { m } = manager(path);
    const job = await m.start({
      task: "x",
      cwd: dir.toUpperCase().replace(/\\/g, "/") + "/",
      permissionMode: "plan",
    });
    await finished(m, job.id);
    expect(job.state).toBe("running");
  });

  it("kills a task that never finishes, and says the work may be half done", async () => {
    // A real hang: no output, no exit, only a SIGTERM will end it. This is the
    // 3-minute wedge the contract probe actually hit.
    const { path } = stub(`setInterval(() => {}, 1000);`);
    const { m } = manager(path);
    const job = await m.start({
      task: "the build",
      cwd: dir,
      permissionMode: "acceptEdits",
      timeoutMs: 250,
    });
    const done = await finished(m, job.id);
    expect(done.result?.status).toBe("timed-out");
    expect(done.result?.detail).toMatch(/partial changes are still on disk/);
  });

  it("reports a crash with its exit code rather than an empty success", async () => {
    const { path } = stub(`console.error("boom: config unreadable"); process.exit(2);`);
    const { m } = manager(path);
    const job = await m.start({ task: "x", cwd: dir, permissionMode: "acceptEdits" });
    const done = await finished(m, job.id);
    expect(done.result?.status).toBe("failed");
    expect(done.result?.detail).toMatch(/exited 2/);
    expect(done.result?.detail).toMatch(/boom/);
  });

  it("reports a missing CLI as a missing CLI", async () => {
    const { m } = manager(join(dir, "does-not-exist.mjs"));
    const job = await m.start({ task: "x", cwd: dir, permissionMode: "acceptEdits" });
    const done = await finished(m, job.id);
    expect(done.result?.status).toBe("failed");
    // Node exits non-zero for a missing script rather than failing to spawn, so
    // either message is honest; what matters is that it is not "reported".
    expect(done.result?.detail.length).toBeGreaterThan(0);
  });

  it("carries a denial through to the job the user sees", async () => {
    const denied = `{"is_error":false,"num_turns":1,"session_id":"s","total_cost_usd":0,` +
      `"terminal_reason":"completed","api_error_status":null,"result":"declined",` +
      `"duration_ms":1,"permission_denials":[{"tool_name":"Write"}]}`;
    const { path } = stub(`console.log(${JSON.stringify(denied)});`);
    const { m } = manager(path);
    const job = await m.start({ task: "x", cwd: dir, permissionMode: "acceptEdits" });
    const done = await finished(m, job.id);
    expect(done.result?.status).toBe("refused");
    expect(done.result?.denied).toEqual(["Write"]);
  });

  it("bounds how many builds can run at once", async () => {
    const { path } = stub(`setInterval(() => {}, 1000);`);
    const { m } = manager(path, { maxConcurrent: 1 });
    const one = await m.start({
      task: "one",
      cwd: dir,
      permissionMode: "acceptEdits",
      timeoutMs: 5_000,
    });
    await expect(
      m.start({ task: "two", cwd: dir, permissionMode: "acceptEdits" }),
    ).rejects.toThrow(/already running/);

    // Awaited, not fired and forgotten: on Windows a live process holds its cwd
    // open, so returning here would leave the temp directory undeletable and
    // fail the teardown instead of this test. Cancelling is asynchronous — the
    // job is not over until the child is.
    const done = finished(m, one.id);
    m.cancelAll();
    await done;
  });

  it("stops a task on request and does not call it a crash", async () => {
    const { path } = stub(`setInterval(() => {}, 1000);`);
    const { m } = manager(path);
    const job = await m.start({ task: "x", cwd: dir, permissionMode: "acceptEdits", timeoutMs: 30_000 });
    expect(m.cancel(job.id)).toBe(true);
    const done = await finished(m, job.id);
    expect(done.result?.status).toBe("cancelled");
    expect(m.cancel(job.id)).toBe(false);
  });

  it("stops everything on shutdown, so no agent outlives the assistant", async () => {
    const { path } = stub(`setInterval(() => {}, 1000);`);
    const { m } = manager(path);
    const a = await m.start({ task: "a", cwd: dir, permissionMode: "acceptEdits", timeoutMs: 30_000 });
    const b = await m.start({ task: "b", cwd: dir, permissionMode: "acceptEdits", timeoutMs: 30_000 });
    const both = Promise.all([finished(m, a.id), finished(m, b.id)]);
    m.cancelAll();
    for (const j of await both) expect(j.result?.status).toBe("cancelled");
  });

  it("passes the task as one argument, so quoting in speech is not syntax", async () => {
    // Spoken text reaches argv verbatim. Through a shell, a quote or an
    // ampersand in "fix the `&&` handling" would be parsed instead of read.
    const { path } = stub(
      `const i = process.argv.indexOf("--");` +
        `console.log(JSON.stringify({result: process.argv.slice(i+1).join("|"), session_id:"s",` +
        `is_error:false, api_error_status:null, permission_denials:[], num_turns:1, total_cost_usd:0,` +
        `duration_ms:1, terminal_reason:"completed"}));`,
    );
    const { m } = manager(path);
    const task = 'fix the "&&" handling & do not $(break) it';
    const job = await m.start({ task, cwd: dir, permissionMode: "acceptEdits" });
    const done = await finished(m, job.id);
    expect(done.result?.text).toBe(task);
  });

  it("does not log the child's stderr wholesale", async () => {
    // A child's stderr can carry a key in a URL (§53). Only a short tail
    // reaches the failure detail, and nothing reaches the log lines.
    const { path } = stub(`console.error("token=sk-secret-value-12345"); process.exit(1);`);
    const { m, logs } = manager(path);
    const job = await m.start({ task: "x", cwd: dir, permissionMode: "acceptEdits" });
    await finished(m, job.id);
    expect(logs.join("\n")).not.toMatch(/sk-secret-value/);
  });
});
