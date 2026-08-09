/**
 * Checking whether the delegated work actually happened.
 *
 * `claude-cli.ts` grades the *conversation*: did a turn complete, was a tool
 * refused. Its best verdict is `reported`, which means the agent says it is
 * done. This file is the second opinion, and the reason Phase 7 is not just a
 * process wrapper.
 *
 * Two independent observations, neither of which asks the agent anything:
 *
 *   1. **Did the working tree change?** An agent that reports a fix and touched
 *      no files is the `unconfirmed` case that `verified-action.ts` was written
 *      about. It is also common: models summarise a plan and stop.
 *   2. **Does the project's own check still pass?** The repository already knows
 *      how to grade itself — `npm run verify`, `npm test`. Running it is the
 *      closest thing to ground truth available without a human reading the diff.
 *
 * ## The check command is read before the agent runs, and pinned
 *
 * This is a security property, not a convenience. `npm test` executes whatever
 * `package.json` currently says, and the process that just had write access to
 * the repository is the coding agent. A task steered by injected text (§52 — a
 * TODO comment, an issue body, a dependency's README) could rewrite the `test`
 * script and then be "verified" by Jarvis running it.
 *
 * So the command is captured *before* delegation and compared afterwards. If
 * `package.json` changed during the task, the check is not run at all and the
 * work comes back `unchecked` for a person to look at. Refusing to grade is the
 * correct answer there: an assistant that runs an agent-authored command in
 * order to confirm the agent's own work has verified nothing.
 */

/** What the project's own check said. */
export type CheckOutcome =
  /** The check ran and passed. */
  | "passed"
  /** The check ran and failed. */
  | "failed"
  /** The project has no check command to run. */
  | "none"
  /** The check could not be trusted or could not be run. Not a pass. */
  | "unchecked";

export interface WorkCheck {
  outcome: CheckOutcome;
  detail: string;
  /** Paths git reports as modified. Empty means the agent changed nothing. */
  changed: readonly string[];
  /** The command that ran, for the Activity view. Null when none did. */
  command: string | null;
}

/** Scripts trusted to be a project's self-check, best first. */
const CHECK_SCRIPTS = ["verify", "test", "check"] as const;

import { resolveNpm, type ResolvedNpm } from "./resolve-npm.js";

/**
 * Which npm script grades this project?
 *
 * Pure, and deliberately narrow: only a fixed list of well-known script names is
 * eligible. A project cannot nominate an arbitrary command for Jarvis to run by
 * naming it something else, which keeps the blast radius of a rewritten
 * `package.json` to scripts that were already going to be candidates.
 */
export function detectCheckScript(packageJsonText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object") return null;
  const table = scripts as Record<string, unknown>;
  for (const name of CHECK_SCRIPTS) {
    if (typeof table[name] === "string" && (table[name] as string).trim().length > 0) return name;
  }
  return null;
}

/**
 * Paths from `git status --porcelain`.
 *
 * The status letters are two columns, then a space, then the path; a rename
 * carries `old -> new` and the new name is the one that matters. Untracked
 * files count — a new file is a change, and an agent that only adds files would
 * otherwise look like one that did nothing.
 */
export function parseGitStatus(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const path = line.slice(3).trim();
    if (path.length === 0) continue;
    const arrow = path.lastIndexOf(" -> ");
    out.push(arrow === -1 ? path : path.slice(arrow + 4));
  }
  return out;
}

export interface CheckDeps {
  /**
   * Runs a program in `cwd` and resolves with stdout, rejecting on non-zero exit.
   *
   * `cwd` is not optional and not advice. Every command here is a question about
   * one specific repository, and a runner that ignored it would answer about
   * whichever directory the runtime happened to be started in — reporting the
   * assistant's own test suite as the delegated work's verdict.
   */
  run: (
    file: string,
    args: readonly string[],
    opts: { cwd: string; timeoutMs?: number; shell?: boolean },
  ) => Promise<string>;
  /** Reads a file, or returns null when it does not exist. */
  readText: (path: string) => string | null;
  join: (...parts: string[]) => string;
}

/**
 * What the repository looked like before the agent touched it.
 *
 * Captured up front so the comparison afterwards is against a real observation
 * rather than an assumption about a clean tree. A repository with uncommitted
 * work in it is the normal case, not an error.
 */
export interface WorkSnapshot {
  changed: readonly string[];
  /** The script name to run afterwards, chosen before the agent could influence it. */
  script: string | null;
  /** Verbatim `package.json`, to detect a rewrite. Never logged. */
  packageJson: string | null;
}

export async function snapshotWork(cwd: string, deps: CheckDeps): Promise<WorkSnapshot> {
  const packageJson = deps.readText(deps.join(cwd, "package.json"));
  let changed: readonly string[] = [];
  try {
    changed = parseGitStatus(
      await deps.run("git", ["status", "--porcelain"], { cwd, timeoutMs: 15_000 }),
    );
  } catch {
    // Not a git repository, or git is missing. The change comparison degrades to
    // "unknown", which `checkWork` reports honestly rather than treating as "no
    // changes" — the direction of that guess decides whether silence reads as
    // success, so it is not guessed.
    return { changed, script: packageJson ? detectCheckScript(packageJson) : null, packageJson };
  }
  return { changed, script: packageJson ? detectCheckScript(packageJson) : null, packageJson };
}

/**
 * Grade the work against the snapshot.
 *
 * Never throws. Every failure mode here — no git, no package.json, a check that
 * exits non-zero, a check that hangs — is a legitimate answer about the state of
 * the repository, and turning one into an exception would push the caller toward
 * a catch-all that reports "done".
 */
export async function checkWork(
  cwd: string,
  before: WorkSnapshot,
  deps: CheckDeps,
  opts: { timeoutMs?: number; npm?: ResolvedNpm } = {},
): Promise<WorkCheck> {
  let changed: string[] = [];
  try {
    changed = parseGitStatus(
      await deps.run("git", ["status", "--porcelain"], { cwd, timeoutMs: 15_000 }),
    );
  } catch {
    return {
      outcome: "unchecked",
      detail: "not a git repository, so I cannot tell what changed",
      changed: [],
      command: null,
    };
  }

  // Set difference rather than a count: an agent that deletes one stale file and
  // creates one new file leaves the total identical.
  const wasThere = new Set(before.changed);
  const fresh = changed.filter((p) => !wasThere.has(p));

  if (fresh.length === 0) {
    return {
      outcome: "unchecked",
      detail: "nothing in the working tree changed, so there is nothing to check",
      changed: [],
      command: null,
    };
  }

  if (!before.script) {
    return {
      outcome: "none",
      detail: `${fresh.length} file(s) changed; this project has no test script to run`,
      changed: fresh,
      command: null,
    };
  }

  // The injection guard. See the header: running a command the agent may have
  // just written, to confirm the agent's own work, verifies nothing.
  const after = deps.readText(deps.join(cwd, "package.json"));
  if (after !== before.packageJson) {
    return {
      outcome: "unchecked",
      detail:
        "package.json changed during the task, so I did not run its test script — check the diff yourself",
      changed: fresh,
      command: null,
    };
  }

  const command = `npm run ${before.script}`;
  const npm = opts.npm ?? resolveNpm();
  try {
    // `needsShell` is only ever true for the `npm.cmd` fallback, and it is safe
    // there for a specific reason: every element of this command line is a
    // literal from this file — `run` and a name out of `CHECK_SCRIPTS`. The one
    // caller-supplied value, `cwd`, travels as a spawn option and is never
    // shell-parsed. That stops being true the moment anything else is appended
    // here, which is why nothing is.
    await deps.run(npm.file, [...npm.args, "run", before.script], {
      cwd,
      timeoutMs: opts.timeoutMs ?? 5 * 60_000,
      ...(npm.needsShell ? { shell: true } : {}),
    });
    return {
      outcome: "passed",
      detail: `${fresh.length} file(s) changed and \`${command}\` passed`,
      changed: fresh,
      command,
    };
  } catch (err) {
    // The message is the check's own last line, which is where a test runner
    // puts its summary. Truncated: a full failing test log is not a sentence.
    const why = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    return {
      outcome: "failed",
      detail: `${fresh.length} file(s) changed but \`${command}\` failed: ${why}`,
      changed: fresh,
      command,
    };
  }
}

/**
 * One sentence about the delegated task, out loud.
 *
 * The distinction this project keeps insisting on has to survive being spoken:
 * "it says it is done" and "I checked and it works" are different claims, and
 * only the second one may sound like one.
 */
export function speakCheck(check: WorkCheck, task: string): string {
  switch (check.outcome) {
    case "passed":
      return `${task} is done — ${check.changed.length} file${check.changed.length === 1 ? "" : "s"} changed and the tests pass.`;
    case "failed":
      return `Claude Code changed ${check.changed.length} file${check.changed.length === 1 ? "" : "s"} for ${task}, but the tests are failing now.`;
    case "none":
      return `Claude Code changed ${check.changed.length} file${check.changed.length === 1 ? "" : "s"} for ${task}. There is no test suite here, so I could not check it.`;
    case "unchecked":
      return `Claude Code says it finished ${task}, but I could not confirm it: ${check.detail}.`;
  }
}
