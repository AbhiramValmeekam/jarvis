/**
 * Watching Hermes' scheduler so the user does not have to.
 *
 * A scheduled job is the one thing in this system that is *supposed* to happen
 * while nobody is looking. That makes it the one thing where silence is
 * ambiguous: "no news" reads as "it ran", and on this machine right now it would
 * mean the opposite — the heartbeat files are four days stale and every job
 * would sit at `last_run_at: null` forever (`hermes_cli/cron.py:66`, "the most
 * common cron support report").
 *
 * So this watcher exists to convert one specific silence into one specific
 * sentence. It polls `readTasks`, compares against what it saw last time, and
 * reports **transitions** — not states. The distinction is the whole design:
 * reporting state means announcing a dead scheduler every minute until the user
 * mutes Jarvis; reporting transitions means saying it once, when it becomes
 * true, and again if it becomes true again.
 *
 * What it deliberately does not do: fire jobs. `hermes cron tick` would run due
 * jobs from here, and an agent job costs a real LLM turn — spending the user's
 * money on a 60 s timer, silently, is not a decision this module gets to make.
 * The honest move is to name the fix (`hermes gateway install`) and let the
 * person choose it (§61).
 */
import { readTasks, type TaskSnapshot } from "./cron-store.js";
import { describeJob } from "./speak-tasks.js";
import type { Notifier } from "../notifications/notifier.js";

/** How often the snapshot is re-read. */
export const DEFAULT_POLL_MS = 60_000;

/** The key every scheduler-health notification shares, so they dedup as one. */
const SCHEDULER_KEY = "scheduler-not-running";

interface JobMark {
  lastRunAt: number | null;
  lastStatus: string | null;
}

export interface TaskWatcherOptions {
  notifier: Notifier;
  /** Directory override. Absent means the real `%LOCALAPPDATA%\hermes\cron`. */
  dir?: string;
  pollMs?: number;
  now?: () => number;
  read?: (dir?: string, now?: number) => TaskSnapshot;
  onLog?: (line: string) => void;
}

/**
 * Polls the cron snapshot and notifies on change.
 *
 * Polling rather than watching the file: `fs.watch` on Windows reports a write
 * that Hermes performs as a temp-file rename, fires more than once for a single
 * save, and gives nothing at all for the *absence* of writes — which is exactly
 * the condition being detected here. A dead scheduler produces no filesystem
 * events, so a watcher built on events could never see it.
 */
export class TaskWatcher {
  private readonly notifier: Notifier;
  private readonly dir: string | undefined;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly read: (dir?: string, now?: number) => TaskSnapshot;
  private readonly onLog: ((line: string) => void) | undefined;

  private timer: NodeJS.Timeout | null = null;
  /** job id → what its last run looked like when we last checked. */
  private marks = new Map<string, JobMark>();
  /** False until the first poll has established a baseline. */
  private baselined = false;
  private lastSnapshot: TaskSnapshot | null = null;

  constructor(opts: TaskWatcherOptions) {
    this.notifier = opts.notifier;
    this.dir = opts.dir;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.now = opts.now ?? Date.now;
    this.read = opts.read ?? readTasks;
    this.onLog = opts.onLog;
  }

  /** The most recent snapshot, or null before the first poll. */
  snapshot(): TaskSnapshot | null {
    return this.lastSnapshot;
  }

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    // Scheduled jobs are not worth keeping the process alive for on their own;
    // the runtime's own listeners decide that. Without this a test that forgets
    // to stop the watcher hangs the suite instead of failing it.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One comparison pass. Public so tests and the probe can step it by hand
   * rather than waiting out a real minute.
   */
  poll(): TaskSnapshot {
    let snapshot: TaskSnapshot;
    try {
      snapshot = this.read(this.dir, this.now());
    } catch (err) {
      // `readTasks` is written not to throw; if it somehow does, a broken
      // watcher must not take down an always-on runtime.
      this.onLog?.(`task watcher: read failed: ${err instanceof Error ? err.message : String(err)}`);
      return this.lastSnapshot ?? { jobs: [], ticker: { state: "never-run" }, willFire: false };
    }

    this.checkScheduler(snapshot);
    this.checkJobs(snapshot);

    this.lastSnapshot = snapshot;
    this.baselined = true;
    return snapshot;
  }

  /**
   * Has the scheduler stopped being able to run the user's jobs?
   *
   * Evaluated on the very first poll, unlike job runs. A job that last ran
   * yesterday is history and announcing it at startup would be noise, but a
   * scheduler that is dead at startup is a live condition — it is dead *now*,
   * and it will stay dead until someone is told.
   */
  private checkScheduler(snapshot: TaskSnapshot): void {
    if (!snapshot.warning) {
      // Cleared, so the next failure is allowed to speak immediately instead of
      // serving out a cooldown started by the previous one.
      this.notifier.clear(SCHEDULER_KEY);
      return;
    }

    const outcome = this.notifier.notify({
      key: SCHEDULER_KEY,
      category: "task-failed",
      title: "Scheduled tasks are not running",
      body: snapshot.warning,
    });
    if (outcome.shown) this.onLog?.(`task watcher: ${snapshot.warning}`);
  }

  private checkJobs(snapshot: TaskSnapshot): void {
    const next = new Map<string, JobMark>();

    for (const job of snapshot.jobs) {
      const mark: JobMark = { lastRunAt: job.lastRunAt, lastStatus: job.lastStatus };
      next.set(job.id, mark);

      // The first poll only records. Otherwise every restart would replay every
      // job's most recent result — including successes from last week — which is
      // precisely the "notifications you learn to ignore" failure.
      if (!this.baselined) continue;

      const before = this.marks.get(job.id);
      if (!before) continue; // A job created since the last poll has no run to report.
      const ran = job.lastRunAt !== null && job.lastRunAt !== before.lastRunAt;
      if (!ran) continue;

      if (job.lastStatus === "error") {
        this.notifier.notify({
          key: `job-error:${job.id}`,
          category: "task-failed",
          title: `Task failed: ${job.name || job.id}`,
          body: job.lastError ?? "Hermes reported an error. Run `hermes cron list` for details.",
        });
      } else {
        // `task-done` is filtered out at the default MINIMAL level, so this is
        // silent unless the user has asked for more. Emitted anyway rather than
        // guarded by a level check here: the policy lives in one place, and a
        // caller that second-guesses it is a caller that drifts from it.
        this.notifier.notify({
          key: `job-ok:${job.id}`,
          category: "task-done",
          title: `Task finished: ${job.name || job.id}`,
          body: describeJob(job),
        });
      }
    }

    this.marks = next;
  }
}

