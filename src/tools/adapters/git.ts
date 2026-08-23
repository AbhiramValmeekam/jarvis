/**
 * Read-only git.
 *
 * Three tools — `git_status`, `git_list_commits`, `git_list_branches` — and
 * nothing that writes. No commit, no checkout, no fetch. A mission that wants to
 * change a repository has to say so through a step the user can see and approve,
 * and Phase 13 does not offer one at all; what a plan needs from git is *facts*:
 * is the tree dirty, what landed recently, which branch is this.
 *
 * The names matter. `family()` in `risk-model.ts` matches read verbs at the start
 * of a name or after an underscore, so `git_status` classifies as a read at level
 * 0 and runs without a consent dialog, while `git.status` would land in `unknown`
 * and put a commit listing behind a prompt. Hence the shape.
 *
 * ## Ownership refusals are reported, not swallowed
 *
 * `git` on Windows refuses a repository owned by another account:
 *
 *     fatal: detected dubious ownership in repository at 'E:/jarvis'
 *
 * This is exactly the state of `E:\jarvis` right now, so it is not a hypothetical
 * branch. Two things happen here. Every invocation carries
 * `-c safe.directory=<path>` for the directory it was asked about, which is enough
 * when that directory is the repository root. When it is not — a step asking about
 * a subdirectory — git's own message names the path it wants, so that path is read
 * out of the refusal and the command is retried once with it. If it still refuses,
 * the tool says so and quotes the one-line fix, rather than reporting an empty
 * status as though the tree were clean.
 */
import { checkPath } from "../../system/path-safety.js";
import {
  nodeProcessRunner,
  outputTail,
  type ProcessResult,
  type ProcessRunner,
} from "../process-run.js";
import {
  readNumber,
  readString,
  type Tool,
  type ToolArgs,
  type ToolContext,
  type ToolRun,
} from "../registry.js";

export interface GitDeps {
  readonly run?: ProcessRunner;
  /** The program name, so a test does not need git installed. */
  readonly gitPath?: string;
}

/** A git read is fast or it is wedged. Well under the registry's default. */
const GIT_TIMEOUT_MS = 20_000;
const CHILD_TIMEOUT_MS = 15_000;

/**
 * Separators for `--pretty=format:`. Unit and record separators rather than a
 * character a commit subject could contain, which `|` very much can.
 */
const FIELD_SEP = String.fromCharCode(31);
const RECORD_SEP = String.fromCharCode(30);

/** The path in `detected dubious ownership in repository at '<path>'`. */
function dubiousPath(stderr: string): string | null {
  const match = /dubious ownership in repository at '([^']+)'/.exec(stderr);
  return match?.[1] ?? null;
}

/** Windows gives a path two spellings; comparing them needs one. */
function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

type GitOutcome =
  | { readonly ok: true; readonly result: ProcessResult }
  | { readonly ok: false; readonly reason: string };

/**
 * Run one git command, retrying once past an ownership refusal.
 *
 * The retry is not a way around a security check. `safe.directory` guards against
 * a repository whose own config could run hooks as this user, and naming the exact
 * path git asked for is what git's documented fix does. Nothing here is global,
 * nothing is written to the user's gitconfig, and the flag lives for one process.
 */
async function runGit(deps: GitDeps, cwd: string, args: readonly string[]): Promise<GitOutcome> {
  const runner = deps.run ?? nodeProcessRunner;
  const file = deps.gitPath ?? "git";
  const attempt = async (safe: string): Promise<ProcessResult> =>
    runner(file, ["-c", `safe.directory=${safe.replace(/\\/g, "/")}`, ...args], {
      cwd,
      timeoutMs: CHILD_TIMEOUT_MS,
    });

  let result: ProcessResult;
  try {
    result = await attempt(cwd);
  } catch (err) {
    // The one genuine error: git is not installed, or could not be started.
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (result.code !== 0) {
    const named = dubiousPath(result.stderr);
    if (named !== null && !sameDir(named, cwd)) {
      try {
        result = await attempt(named);
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  return { ok: true, result };
}

/**
 * A failed git read, as a step result.
 *
 * The ownership case gets its own wording and the exact command that fixes it,
 * because the alternative — "0 changes" from a git that never looked — is the kind
 * of quiet false success §43 is about.
 */
function gitFailure(what: string, result: ProcessResult): ToolRun {
  const named = dubiousPath(result.stderr);
  const detail =
    named !== null
      ? `git will not read ${named}: another account owns it. The permanent fix is yours to run — git config --global --add safe.directory ${named}`
      : outputTail(result, 6);
  return { outcome: "failed", summary: `could not ${what}`, detail, error: detail };
}

/** Resolve the repository directory a step named, or say why not. */
function repoDir(
  args: ToolArgs,
  ctx: ToolContext,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly run: ToolRun } {
  const verdict = checkPath(readString(args, "path"), ctx.roots);
  if (!verdict.ok || !verdict.path) {
    return {
      ok: false,
      run: {
        outcome: "failed",
        summary: "refused",
        error: verdict.reason ?? "that directory is not allowed",
      },
    };
  }
  return { ok: true, path: verdict.path };
}

const PATH_FIELD = { kind: "string", required: true, max: 400 } as const;

/** `## main...origin/main [ahead 2]` → the branch name, or null when detached. */
function branchOf(porcelain: readonly string[]): string | null {
  const header = porcelain.find((l) => l.startsWith("## "));
  if (header === undefined) return null;
  const name = header.slice(3).split("...")[0]?.trim() ?? "";
  if (name === "" || name.startsWith("HEAD (no branch)")) return null;
  return name;
}

function gitStatus(deps: GitDeps): Tool {
  return {
    name: "git_status",
    summary: "Read a repository's branch and working-tree changes",
    schema: { path: PATH_FIELD },
    timeoutMs: GIT_TIMEOUT_MS,
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      const dir = repoDir(args, ctx);
      if (!dir.ok) return dir.run;
      const outcome = await runGit(deps, dir.path, ["status", "--porcelain=v1", "--branch"]);
      if (!outcome.ok) {
        return { outcome: "failed", summary: "could not run git", error: outcome.reason };
      }
      if (outcome.result.code !== 0) return gitFailure("read the repository status", outcome.result);

      const lines = outcome.result.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
      const entries = lines.filter((l) => !l.startsWith("## "));
      const untracked = entries.filter((l) => l.startsWith("??")).length;
      const branch = branchOf(lines);
      const changed = entries.length - untracked;
      return {
        // A read is verified by having produced the reading it promised — the one
        // case where the act and the check are the same event.
        outcome: "verified",
        summary: `${branch ?? "detached HEAD"} · ${changed} changed, ${untracked} untracked`,
        detail: entries.slice(0, 40).join(" · ") || "the working tree is clean",
        data: {
          path: dir.path,
          branch: branch ?? "",
          changed,
          untracked,
          clean: entries.length === 0,
          entries: entries.slice(0, 40),
        },
      };
    },
  };
}

/** How many commits one step may ask for. A step is a summary, not an archive. */
const MAX_COMMITS = 50;
const DEFAULT_COMMITS = 10;

function gitListCommits(deps: GitDeps): Tool {
  return {
    name: "git_list_commits",
    summary: "Read the most recent commits in a repository",
    schema: {
      path: PATH_FIELD,
      count: { kind: "number", integer: true, min: 1, max: MAX_COMMITS },
    },
    timeoutMs: GIT_TIMEOUT_MS,
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      const dir = repoDir(args, ctx);
      if (!dir.ok) return dir.run;
      const count = readNumber(args, "count", DEFAULT_COMMITS);
      const outcome = await runGit(deps, dir.path, [
        "log",
        `-n${count}`,
        `--pretty=format:%h${FIELD_SEP}%an${FIELD_SEP}%ar${FIELD_SEP}%s${RECORD_SEP}`,
      ]);
      if (!outcome.ok) {
        return { outcome: "failed", summary: "could not run git", error: outcome.reason };
      }
      if (outcome.result.code !== 0) return gitFailure("read the commit log", outcome.result);

      // Commit subjects and author names are whatever was committed — untrusted
      // text, kept as data and shown through the registry's sanitiser.
      const commits = outcome.result.stdout
        .split(RECORD_SEP)
        .map((record) => record.trim())
        .filter((record) => record !== "")
        .map((record) => {
          const [hash = "", author = "", when = "", subject = ""] = record.split(FIELD_SEP);
          return { hash, author, when, subject };
        });
      return {
        outcome: "verified",
        summary: `${commits.length} commit${commits.length === 1 ? "" : "s"}`,
        detail: commits.map((c) => `${c.hash} ${c.subject} (${c.author}, ${c.when})`).join(" · "),
        data: { path: dir.path, commits },
      };
    },
  };
}

function gitListBranches(deps: GitDeps): Tool {
  return {
    name: "git_list_branches",
    summary: "Read a repository's local branches, marking the current one",
    schema: { path: PATH_FIELD },
    timeoutMs: GIT_TIMEOUT_MS,
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      const dir = repoDir(args, ctx);
      if (!dir.ok) return dir.run;
      const outcome = await runGit(deps, dir.path, [
        "branch",
        "--list",
        `--format=%(HEAD)${FIELD_SEP}%(refname:short)${FIELD_SEP}%(objectname:short)`,
      ]);
      if (!outcome.ok) {
        return { outcome: "failed", summary: "could not run git", error: outcome.reason };
      }
      if (outcome.result.code !== 0) return gitFailure("list the branches", outcome.result);

      const branches = outcome.result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => {
          const [head = "", name = "", head_commit = ""] = line.split(FIELD_SEP);
          return { name, commit: head_commit, current: head.trim() === "*" };
        });
      const current = branches.find((b) => b.current)?.name ?? "";
      return {
        outcome: "verified",
        summary: `${branches.length} branch${branches.length === 1 ? "" : "es"}${current === "" ? "" : `, on ${current}`}`,
        detail: branches.map((b) => (b.current ? `* ${b.name}` : b.name)).join(" · "),
        data: { path: dir.path, current, branches },
      };
    },
  };
}

/**
 * The git tools. All three read; none of them writes.
 *
 * `deps` exists for the tests and the probe — a `ProcessRunner` that returns a
 * recorded refusal is how the ownership path is exercised without needing a
 * repository owned by someone else.
 */
export function gitTools(deps: GitDeps = {}): readonly Tool[] {
  return [gitStatus(deps), gitListCommits(deps), gitListBranches(deps)];
}
