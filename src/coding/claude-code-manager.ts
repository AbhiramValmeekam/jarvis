/**
 * ClaudeCodeManager — delegating code work without going deaf while it runs.
 *
 * A build takes minutes. The requirement is that Jarvis keeps listening the
 * whole time, so every task here is a background job with an id: `start`
 * returns as soon as the child is spawned, and the answer arrives later as an
 * event. Nothing in this file awaits a coding task on behalf of a caller who is
 * holding up the voice loop.
 *
 * ## What this refuses to do
 *
 * **It does not run in an arbitrary directory.** `cwd` must be a project the
 * registry already found — a real directory the user nominated in config. The
 * point is not that a path could be malformed; it is that a coding agent with
 * file tools, aimed by a sentence picked up from a microphone, must not be
 * aimable at `C:\Windows` or at whatever a webpage suggested (§52).
 *
 * **It does not choose its own permissions.** `permissionMode` is required by
 * `buildArgs` and passed through from the caller, so the decision of whether an
 * agent may edit files is made where the user's consent is, not here.
 *
 * **It does not adopt the child's claims.** See `claude-cli.ts`: a 503 and a
 * refused write both exit 0. The status comes from the parsed envelope.
 *
 * ## Concurrency
 *
 * Bounded, small, and enforced rather than documented. Each job is a real
 * process that can compile, install packages and spend money; "the user said
 * 'fix the tests' four times because it felt slow" must not become four
 * simultaneous builds in one repository.
 */
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { classifyResult, parseClaudeJson, buildArgs, type CodingResult } from "./claude-cli.js";

/** Longest a single delegated task may run before it is killed. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Most tasks that may run at once. */
export const MAX_CONCURRENT = 2;
/** Spend ceiling per task, in dollars. A spoken sentence must not be able to bill unbounded. */
export const DEFAULT_BUDGET_USD = 5;

export type JobState = "running" | "done";

/** The spawn seam, named so callers can type an injected one without importing node's. */
export type SpawnFn = typeof spawn;

export interface CodingJob {
  id: string;
  /** What the user asked for, in their words. Shown in the HUD. */
  task: string;
  cwd: string;
  state: JobState;
  startedAt: number;
  /** Present once the job has finished, whatever the outcome. */
  result?: CodingResult;
}

export interface StartOptions {
  task: string;
  /** Must be one of `projects()`. Not a free path — see the header. */
  cwd: string;
  tools?: readonly string[];
  permissionMode: "acceptEdits" | "plan" | "dontAsk";
  sessionId?: string;
  model?: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
}

export interface ManagerOptions {
  /**
   * Directories a coding agent may be pointed at. Consulted at `start`, not
   * cached, so a project added to config mid-session is usable and one removed
   * stops being a target immediately.
   */
  allowedRoots: () => readonly string[];
  /** Path to the CLI. Overridden in tests with a stub script. */
  claudePath?: string;
  /** Injected in tests. Production spawns a real process. */
  spawnFn?: SpawnFn;
  now?: () => number;
  onLog?: (line: string) => void;
  maxConcurrent?: number;
}

interface Live {
  job: CodingJob;
  child: ChildProcess;
  timer: NodeJS.Timeout;
  /** Set when we killed it ourselves, so the exit is not reported as a crash. */
  killedAs: "timed-out" | "cancelled" | null;
}

export class ClaudeCodeManager extends EventEmitter {
  private live = new Map<string, Live>();
  private history: CodingJob[] = [];
  private readonly now: () => number;

  constructor(private readonly options: ManagerOptions) {
    super();
    this.now = options.now ?? (() => Date.now());
  }

  /** Jobs currently running, newest last. Cheap enough for the HUD to poll. */
  running(): readonly CodingJob[] {
    return [...this.live.values()].map((l) => l.job);
  }

  /** Finished jobs, most recent first, capped so a long session cannot grow without bound. */
  recent(limit = 10): readonly CodingJob[] {
    return this.history.slice(0, limit);
  }

  private log(line: string): void {
    this.options.onLog?.(`claude-code: ${line}`);
  }

  /**
   * Is this directory one the user nominated?
   *
   * Compared case-insensitively after normalising separators, because Windows
   * paths reach here from three sources — config, the registry, a spoken name
   * resolved against it — that disagree about slashes and capitalisation. A
   * mismatch on that alone would refuse a legitimate project and teach whoever
   * hits it to widen the check, which is the actual risk.
   */
  private isAllowed(dir: string): boolean {
    const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
    const target = norm(dir);
    return this.options.allowedRoots().some((r) => norm(r) === target);
  }

  /**
   * Begin a coding task. Returns as soon as the process exists.
   *
   * Rejects — rather than resolving with a failed job — when the request itself
   * is wrong: an unknown directory, or too many jobs already running. Those are
   * caller errors, not agent outcomes, and folding them into `CodingResult`
   * would put "you asked for something not allowed" in the same channel as
   * "the build failed".
   */
  async start(o: StartOptions): Promise<CodingJob> {
    if (!this.isAllowed(o.cwd)) {
      // The path is named in the error because the user chose it and needs to
      // know which one was rejected; it is a directory, not a secret.
      throw new Error(`refusing to run a coding agent outside a known project: ${o.cwd}`);
    }
    const cap = this.options.maxConcurrent ?? MAX_CONCURRENT;
    if (this.live.size >= cap) {
      throw new Error(`already running ${this.live.size} coding task(s); wait for one to finish`);
    }

    const args = buildArgs({
      prompt: o.task,
      permissionMode: o.permissionMode,
      ...(o.tools ? { tools: o.tools } : {}),
      ...(o.sessionId ? { sessionId: o.sessionId } : {}),
      ...(o.model ? { model: o.model } : {}),
      maxBudgetUsd: o.maxBudgetUsd ?? DEFAULT_BUDGET_USD,
    });

    const job: CodingJob = {
      id: randomUUID(),
      task: o.task,
      cwd: o.cwd,
      state: "running",
      startedAt: this.now(),
    };

    const spawnFn = this.options.spawnFn ?? spawn;
    const child = spawnFn(this.options.claudePath ?? "claude", args, {
      cwd: o.cwd,
      // No shell. The task text is a spoken sentence; through a shell, a
      // quotation mark in it would be syntax. It travels as one argv element.
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      const l = this.live.get(job.id);
      if (!l) return;
      l.killedAs = "timed-out";
      // SIGTERM first: a coding agent mid-write should get the chance to close
      // the file it is holding. The exit handler runs either way.
      l.child.kill("SIGTERM");
    }, timeoutMs);

    const entry: Live = { job, child, timer, killedAs: null };
    this.live.set(job.id, entry);
    this.log(`started ${job.id} in ${o.cwd} (${o.permissionMode}, ${(o.tools ?? []).length} tools)`);
    this.emit("started", job);

    this.collect(entry);
    return job;
  }

  /**
   * Read the child to completion and settle the job.
   *
   * stdout is accumulated with a cap. The JSON envelope is small, but a wedged
   * child that prints forever must not be able to grow the runtime's heap until
   * the machine swaps — an always-on process cannot afford an unbounded buffer
   * anywhere.
   */
  private collect(entry: Live): void {
    const MAX_OUT = 8 << 20;
    let out = "";
    let truncated = false;
    let err = "";

    entry.child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length > MAX_OUT) {
        truncated = true;
        return;
      }
      out += chunk.toString("utf8");
    });
    // Kept only for the failure message. Never logged wholesale: a child's
    // stderr can contain an API key in a URL (§53).
    entry.child.stderr?.on("data", (chunk: Buffer) => {
      if (err.length < 4096) err += chunk.toString("utf8");
    });

    const settle = (result: CodingResult): void => {
      clearTimeout(entry.timer);
      this.live.delete(entry.job.id);
      const job: CodingJob = { ...entry.job, state: "done", result };
      this.history.unshift(job);
      if (this.history.length > 50) this.history.pop();
      this.log(`${job.id} ${result.status} in ${result.tookMs} ms`);
      this.emit("finished", job);
    };

    entry.child.on("error", (e) => {
      // Spawn itself failed — usually the CLI is not installed. Worth naming
      // precisely, because the user's fix is a different one.
      settle(this.fail(entry, `could not start Claude Code: ${e.message}`));
    });

    entry.child.on("close", (code) => {
      const tookMs = this.now() - entry.job.startedAt;

      if (entry.killedAs) {
        settle({
          status: entry.killedAs,
          text: "",
          sessionId: null,
          denied: [],
          costUsd: 0,
          turns: 0,
          tookMs,
          detail:
            entry.killedAs === "timed-out"
              ? `killed after ${Math.round(tookMs / 1000)}s; any partial changes are still on disk`
              : "stopped on request; any partial changes are still on disk",
        });
        return;
      }

      if (truncated) {
        settle(this.fail(entry, "the coding agent produced more output than Jarvis will buffer"));
        return;
      }

      try {
        settle(classifyResult(parseClaudeJson(out), tookMs));
      } catch (e) {
        // A non-zero exit with unparseable stdout is the ordinary crash case;
        // report the exit code alongside, since it is the only signal left.
        const why = e instanceof Error ? e.message : String(e);
        const tail = err.trim().split("\n").pop()?.slice(0, 200);
        settle(
          this.fail(
            entry,
            code === 0 ? why : `claude exited ${code}: ${tail || why}`,
          ),
        );
      }
    });
  }

  private fail(entry: Live, detail: string): CodingResult {
    return {
      status: "failed",
      text: "",
      sessionId: null,
      denied: [],
      costUsd: 0,
      turns: 0,
      tookMs: this.now() - entry.job.startedAt,
      detail,
    };
  }

  /** Stop a running task. Idempotent; unknown ids are not an error. */
  cancel(id: string): boolean {
    const l = this.live.get(id);
    if (!l) return false;
    l.killedAs = "cancelled";
    l.child.kill("SIGTERM");
    return true;
  }

  /**
   * Stop everything. Called on runtime shutdown.
   *
   * Without this, a detached coding agent would outlive the assistant that
   * started it and keep editing files with nobody watching.
   */
  cancelAll(): void {
    for (const id of [...this.live.keys()]) this.cancel(id);
  }
}
