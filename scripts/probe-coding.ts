/**
 * Phase 7 gate: does delegating to Claude Code actually work on this machine?
 *
 * The unit tests drive the manager through stub processes, which proves the
 * lifecycle — timeouts, cancellation, crash reporting — and says nothing about
 * whether the argument list is one the installed CLI accepts. That gap is where
 * this project's defects have consistently lived, and it produced three here
 * before this script existed:
 *
 *   - `--allowedTools ""` from the reference notes is retired; `--tools ""` is
 *     the current flag. The old one still parses, so nothing complained.
 *   - the model those notes pin, `claude-haiku-4-5-20251001`, returns 503 from
 *     the configured gateway. Exit code 0, `subtype:"success"`, `is_error:true`.
 *   - with no `--permission-mode`, a file write is put to a prompt that nobody
 *     can answer in headless mode. The run reports `is_error:false`,
 *     `terminal_reason:"completed"`, and the file does not exist.
 *
 * All three read as success to a careless caller. That is the point of running
 * this against the real thing. Its first live run then found a fourth, in
 * Jarvis' own code rather than the CLI's: `npm` on Windows is a batch shim that
 * Node will not spawn directly, so the post-task check died with `spawn EINVAL`
 * and every delegated task was reported as breaking the build. See
 * `src/coding/resolve-npm.ts`.
 *
 * **What it does to your machine.** Creates a temporary directory under %TEMP%,
 * initialises a git repository in it, asks Claude Code to write one small file
 * there, and deletes the whole thing afterwards. Nothing outside that directory
 * is touched. It does spend money — a few cents of API usage — and it needs
 * network. Nothing runs until you say yes at the prompt.
 *
 *   npx tsx scripts/probe-coding.ts
 *   npx tsx scripts/probe-coding.ts --yes    (skip the prompt)
 *   npx tsx scripts/probe-coding.ts --offline  (contract checks only, no spend)
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgs, parseClaudeJson, classifyResult } from "../src/coding/claude-cli.js";
import { ClaudeCodeManager, type CodingJob } from "../src/coding/claude-code-manager.js";
import { snapshotWork, checkWork, type CheckDeps } from "../src/coding/work-check.js";
import { resolveNpm } from "../src/coding/resolve-npm.js";

const results: { name: string; verdict: string; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, verdict: ok ? "PASS" : "FAIL", detail });
}

function run(
  file: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs?: number; shell?: boolean },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 60_000,
        windowsHide: true,
        maxBuffer: 8 << 20,
        // Honoured, not ignored: `work-check.ts` asks for a shell only for the
        // `npm.cmd` fallback, and a runner that dropped the flag would fail with
        // `spawn EINVAL` — which is how this probe found the bug it now guards.
        ...(opts.shell ? { shell: true } : {}),
      },
      (err, out, errOut) => {
        if (err) {
          reject(new Error(String(errOut || err.message).trim().split("\n").pop() ?? "failed"));
          return;
        }
        resolve(String(out));
      },
    );
  });
}

const deps: CheckDeps = {
  run,
  readText: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  join,
};

async function main(): Promise<void> {
  // --- offline first, so a broken contract fails before anything is spent ----

  const args = buildArgs({ prompt: "hello", permissionMode: "acceptEdits", tools: [] });
  check("the prompt is terminated with --", args.at(-2) === "--", args.slice(-4).join(" "));
  check("the current tools flag is used", args.includes("--tools") && !args.includes("--allowedTools"));
  check("no model is pinned by default", !args.includes("--model"), "the notes' model 503s here");
  check("a permission mode is always stated", args.includes("--permission-mode"));

  // The two envelopes that read as success. Fixtures copied from real runs.
  const api503 = classifyResult(
    parseClaudeJson(
      `{"is_error":true,"api_error_status":503,"result":"API Error: 503","session_id":"s",` +
        `"terminal_reason":"api_error","subtype":"success","permission_denials":[],` +
        `"num_turns":1,"total_cost_usd":0,"duration_ms":1}`,
    ),
    1,
  );
  check("a 503 that exited 0 is called a failure", api503.status === "failed", api503.detail);

  const refused = classifyResult(
    parseClaudeJson(
      `{"is_error":false,"api_error_status":null,"result":"declined","session_id":"s",` +
        `"terminal_reason":"completed","permission_denials":[{"tool_name":"Write"}],` +
        `"num_turns":1,"total_cost_usd":0,"duration_ms":1}`,
    ),
    1,
  );
  check("a refused write that reported no error is called refused", refused.status === "refused", refused.detail);

  // The check can only be a second opinion if it can actually run. On Windows
  // `npm` is a batch shim that Node refuses to spawn directly, and this probe is
  // where that was found: every task came back `failed: spawn EINVAL`, with the
  // work itself perfectly fine. Costs nothing and needs no network, so it runs
  // in the offline half where a regression is caught before any spend.
  const npm = resolveNpm();
  let npmVersion = "";
  try {
    npmVersion = (
      await run(npm.file, [...npm.args, "--version"], {
        cwd: process.cwd(),
        timeoutMs: 60_000,
        ...(npm.needsShell ? { shell: true } : {}),
      })
    ).trim();
  } catch (e) {
    npmVersion = `could not run: ${e instanceof Error ? e.message : String(e)}`;
  }
  check("npm can actually be spawned to run the check", /^\d+\./.test(npmVersion), `${npm.file} → ${npmVersion}`);

  // --- the real thing, only with permission --------------------------------

  if (process.argv.includes("--offline")) {
    console.log("\n--offline: contract checks only, nothing spawned.\n");
    return report();
  }

  if (!process.argv.includes("--yes")) {
    console.log(
      "\nThis will run Claude Code for real in a temporary git repository under %TEMP%.\n" +
        "It costs a few cents of API usage and needs network. The directory is deleted after.\n",
    );
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question("Run a real delegated coding task now? [y/N] "))
      .trim()
      .toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log("\nNothing run. The offline checks above still ran:\n");
      return report();
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "jarvis-phase7-"));
  try {
    await realRun(dir);
  } finally {
    // A real coding agent has been writing here. Removed whatever happened.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  report();
}

/** A throwaway project the agent can safely be pointed at. */
async function scaffold(dir: string): Promise<void> {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "jarvis-phase7-probe",
        private: true,
        // Deliberately a check that passes only if the agent's file exists, so
        // "the tests pass" is evidence about the work rather than a tautology.
        scripts: { test: `node -e "require('fs').readFileSync('greet.js');console.log('ok')"` },
      },
      null,
      2,
    ),
    "utf8",
  );
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["-c", "user.email=probe@local", "-c", "user.name=probe", "commit", "-qm", "init"], {
    cwd: dir,
  });
}

async function realRun(dir: string): Promise<void> {
  await scaffold(dir);
  check("a clean scaffolded repository is committed", true, dir);

  const before = await snapshotWork(dir, deps);
  check(
    "the test script is pinned before the agent can touch it",
    before.script === "test",
    `script=${before.script}, tree clean=${before.changed.length === 0}`,
  );

  const manager = new ClaudeCodeManager({
    allowedRoots: () => [dir],
    onLog: () => {},
  });

  // The security property, against the real manager: a path nobody nominated.
  let refusedOutside = false;
  try {
    await manager.start({ task: "x", cwd: tmpdir(), permissionMode: "acceptEdits" });
  } catch {
    refusedOutside = true;
  }
  check("refuses a directory outside the registry", refusedOutside);

  const t0 = Date.now();
  const finished = new Promise<CodingJob>((resolve) => manager.once("finished", resolve));
  const job = await manager.start({
    task: "Create a file named greet.js that exports a function greet(name) returning `Hello, ${name}!`. Do not create any other files.",
    cwd: dir,
    permissionMode: "acceptEdits",
    tools: ["Read", "Write", "Edit"],
    timeoutMs: 5 * 60_000,
  });

  // The requirement, measured: start returned while the agent is still working.
  check(
    "start returns while the task is still running",
    job.state === "running" && Date.now() - t0 < 5_000,
    `${Date.now() - t0} ms to return`,
  );
  check("the running job is visible", manager.running().length === 1);

  const done = await finished;
  const elapsed = Date.now() - t0;
  const result = done.result;

  check(
    "the task completed",
    result?.status === "reported",
    `${result?.status} in ${(elapsed / 1000).toFixed(1)}s: ${result?.detail}`,
  );
  if (result?.status !== "reported") return;

  check("a session id came back for follow-ups", !!result.sessionId, result.sessionId ?? "");
  check("the spend is reported", result.costUsd >= 0, `$${result.costUsd.toFixed(4)}`);

  // --- the second opinion, which is the point of the phase ------------------

  const verdict = await checkWork(dir, before, deps);
  check(
    "the work is independently checked, not taken on trust",
    verdict.outcome === "passed",
    `${verdict.outcome}: ${verdict.detail}`,
  );
  check(
    "the file the agent claimed to write is really there",
    existsSync(join(dir, "greet.js")),
    verdict.changed.join(", "),
  );

  // --- and the check refuses to grade a repository that rewrote its own check -
  //
  // Not simulated with a fixture: package.json on disk is edited to something
  // hostile, exactly as an injected instruction would, and the real checker is
  // asked to grade it.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node -e \"console.log('pwned')\"" } }, null, 2),
    "utf8",
  );
  const tampered = await checkWork(dir, before, deps);
  check(
    "a rewritten package.json is not run to confirm the agent's own work",
    tampered.outcome === "unchecked" && /package\.json changed/.test(tampered.detail),
    tampered.detail,
  );
}

function report(): void {
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`${r.verdict.padEnd(5)} ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = results.filter((r) => r.verdict === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
