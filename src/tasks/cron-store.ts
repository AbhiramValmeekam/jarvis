/**
 * Hermes' scheduled jobs, read from disk.
 *
 * Same boundary as `memory/hermes-memory.ts`, and for the same reason: Hermes
 * owns `%LOCALAPPDATA%\hermes\cron\jobs.json`, writes it under a cross-process
 * advisory lock (`cron/jobs.py` takes `msvcrt.locking` on a sibling
 * `.jobs.lock`), and repairs malformed records in place during a tick. **There
 * is no write path in this module** — not a disabled one, an absent one. A
 * second writer racing the scheduler over that file could lose a user's jobs,
 * and `_get_due_jobs_locked` explicitly documents recovering from exactly that
 * kind of damage.
 *
 * Reading rather than shelling out to `hermes cron list` is the same trade the
 * skill catalog made and it measured the same way here: `hermes cron list`
 * costs 0.511 s of Python startup and prints a Rich table, while the file is a
 * few hundred bytes of JSON. Reading disk also means "what's scheduled?" still
 * answers with Hermes down — which matters more for tasks than for skills,
 * because "is my 9am job going to fire?" is a question people ask *precisely*
 * when something looks wrong.
 *
 * Everything in here is untrusted content (§52). A job name and prompt are
 * free text that an agent turn can create — `cron/jobs.py:1185` builds `name`
 * from the first 50 characters of the prompt when none is given — so both are
 * sanitised at this boundary before anything speaks or renders them.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { sanitiseForDisplay } from "../permissions/risk-model.js";

/** `%LOCALAPPDATA%\hermes` — `get_hermes_home()` on win32 (`hermes_constants.py:55`). */
export function hermesHome(): string {
  const explicit = process.env.HERMES_HOME;
  if (explicit) return explicit;
  const base = process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(base, "hermes");
}

/** `<hermes home>/cron` — `CRON_DIR` (`cron/jobs.py:74`). */
export function cronDir(home = hermesHome()): string {
  return join(home, "cron");
}

/**
 * A scheduled job, as Jarvis reads it.
 *
 * A projection of the ~30-key record Hermes writes, not the record itself. The
 * same rule `ActivityEntry` follows: Hermes is free to add a field, and
 * spreading its record would publish that field to every attached UI without
 * anyone choosing to. Two of the keys it writes are `model` and `base_url` —
 * config that belongs to the agent, not on a wire to a HUD.
 *
 * `prompt` is deliberately absent. It is the instruction text a future agent
 * turn will execute, it can run to paragraphs, and no question this module
 * answers ("what's scheduled?", "did it run?") needs it.
 */
export interface CronJob {
  id: string;
  /** Sanitised. Hermes derives it from the prompt when the user gave no name. */
  name: string;
  /** Hermes' own `schedule_display`, e.g. `every 30m`, `0 9 * * *`. Sanitised. */
  schedule: string;
  /** `once` | `interval` | `cron`, or `unknown` for a record we could not read. */
  kind: "once" | "interval" | "cron" | "unknown";
  enabled: boolean;
  /** Epoch ms, or null when Hermes has not computed one. */
  nextRunAt: number | null;
  /** Epoch ms of the last fire, or null if it has never run. */
  lastRunAt: number | null;
  /** Hermes' own word for how the last run ended: `ok` or `error`. Sanitised, or null. */
  lastStatus: string | null;
  /**
   * Why the last run failed, when it did.
   *
   * Included where `prompt` was not, because this is the one field that answers
   * the question a person actually has when they see a failure, and there is no
   * cheaper way to get it than showing it. It is still untrusted text from an
   * agent turn (§52), so it is sanitised and cut short — a toast body is not a
   * log viewer, and `hermes cron list` is there for the full text.
   */
  lastError: string | null;
  /** True when the job runs a script with no agent turn — so it costs nothing. */
  noAgent: boolean;
}

/**
 * Hermes writes ISO-8601 with an offset (`_hermes_now().isoformat()`), so
 * `Date.parse` handles it. A record edited by hand can hold anything, and an
 * unparseable timestamp reads as "unknown" rather than as 1970 — a job dated
 * 1970 would render as catastrophically overdue and send someone debugging a
 * scheduler that is fine.
 */
function epoch(raw: unknown): number | null {
  if (typeof raw !== "string" || !raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function readKind(schedule: unknown): CronJob["kind"] {
  if (!schedule || typeof schedule !== "object") return "unknown";
  const kind = (schedule as { kind?: unknown }).kind;
  return kind === "once" || kind === "interval" || kind === "cron" ? kind : "unknown";
}

/**
 * One record, or null if it is too damaged to describe.
 *
 * Only `id` is required. Everything else degrades to a stated unknown, because
 * Hermes itself tolerates these records — `_get_due_jobs_locked` repairs a
 * missing `id` and a non-dict `schedule` rather than rejecting the file — and a
 * reader stricter than the writer would report "no jobs" over a jobs file that
 * the scheduler is happily firing from.
 */
function toJob(raw: unknown): CronJob | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id ? o.id : null;
  if (!id) return null;

  const schedule = o.schedule;
  const display =
    typeof o.schedule_display === "string" && o.schedule_display
      ? o.schedule_display
      : schedule && typeof schedule === "object" && typeof (schedule as { display?: unknown }).display === "string"
        ? ((schedule as { display?: string }).display ?? "")
        : "";

  return {
    id: sanitiseForDisplay(id, 40),
    name: typeof o.name === "string" ? sanitiseForDisplay(o.name, 80) : "",
    schedule: sanitiseForDisplay(display, 60),
    kind: readKind(schedule),
    // Absent means enabled: Hermes writes `"enabled": true` on create and
    // `list_jobs` treats a missing key the same way (`j.get("enabled", True)`).
    enabled: o.enabled !== false,
    nextRunAt: epoch(o.next_run_at),
    lastRunAt: epoch(o.last_run_at),
    lastStatus: typeof o.last_status === "string" ? sanitiseForDisplay(o.last_status, 40) : null,
    lastError: typeof o.last_error === "string" && o.last_error ? sanitiseForDisplay(o.last_error, 120) : null,
    noAgent: o.no_agent === true,
  };
}

export interface CronRead {
  /** False when `jobs.json` does not exist — no jobs have ever been created. */
  present: boolean;
  jobs: readonly CronJob[];
  /** Set when the file exists but could not be read. `jobs` is empty then. */
  error?: string;
}

/**
 * Read `cron/jobs.json`.
 *
 * The file is `{"jobs": [...], "updated_at": "..."}`. Both shapes are accepted
 * — a bare array too — because `load_jobs` in Hermes does the same, and this
 * reader has no business being pickier than the writer.
 *
 * Never throws. A missing file is the normal state on a machine where nobody
 * has scheduled anything, and a malformed one must not take down the runtime
 * (the rule `loadConfig` and `MemoryStore` already follow).
 */
export function readCronJobs(dir = cronDir()): CronRead {
  const file = join(dir, "jobs.json");
  if (!existsSync(file)) return { present: false, jobs: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { present: true, jobs: [], error: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { jobs?: unknown }).jobs)
      ? ((parsed as { jobs: unknown[] }).jobs)
      : null;
  if (!list) return { present: true, jobs: [], error: "expected a jobs array" };

  return { present: true, jobs: list.flatMap((j) => toJob(j) ?? []) };
}

// --- is anything actually going to fire? ------------------------------------

/**
 * How stale a heartbeat may be before the ticker counts as dead.
 *
 * `STALE_AFTER` in `hermes_cli/cron.py`: `TICKER_INTERVAL_SECONDS * 3 + 20`,
 * i.e. 200 s. Copied rather than invented so Jarvis and `hermes cron status`
 * cannot disagree about whether the scheduler is alive — two tools giving
 * different answers to that question is worse than either answer alone.
 */
export const TICKER_INTERVAL_SECONDS = 60;
export const TICKER_STALE_AFTER_SECONDS = TICKER_INTERVAL_SECONDS * 3 + 20;

/**
 * The single most important fact this module reports.
 *
 * Verified from live Hermes source, and it is not what the plan assumed:
 * **there is no standalone cron daemon.** `_warn_if_gateway_not_running`
 * (`hermes_cli/cron.py:66`) says so outright — "The cron ticker only runs
 * inside the gateway (`_start_cron_ticker` in gateway/run.py); there is no
 * standalone cron daemon. Without a running gateway, `next_run_at` passes but
 * jobs never fire and `last_run_at` stays null — the most common cron support
 * report (#51038)."
 *
 * So a job can be perfectly scheduled and still never run, and the *only*
 * observable difference is these two heartbeat files. Reporting a job list
 * without reporting this would be the exact failure §4 forbids: a tasks feature
 * that looks like it works.
 *
 * The two files are separate signals on purpose (`record_ticker_heartbeat`):
 * `ticker_heartbeat` is bumped every loop iteration, `ticker_last_success` only
 * after a tick that did not raise. A ticker failing every tick keeps the first
 * fresh — so "alive" and "actually firing jobs" are different questions, and
 * this answers both.
 */
export type TickerHealth =
  /** Fresh heartbeat and fresh success: jobs really are firing. */
  | { state: "running"; heartbeatAgeMs: number; successAgeMs: number }
  /** Looping, but every tick is failing. Jobs are not running. */
  | { state: "failing"; heartbeatAgeMs: number; successAgeMs: number | null }
  /** Heartbeat too old. Something started a ticker once and it is gone. */
  | { state: "stalled"; heartbeatAgeMs: number; successAgeMs: number | null }
  /** No heartbeat file at all: no ticker has ever run for this profile. */
  | { state: "never-run" };

/**
 * Read an epoch-seconds file, as `_epoch_file_age` does.
 *
 * The content is a float of seconds since the epoch (`1785954716.1970532`),
 * written atomically by `_atomic_write_epoch`. A torn or unreadable read
 * returns null, which callers must treat as "cannot determine" — Hermes'
 * docstring is explicit that None is not "dead".
 */
function readEpochFile(path: string): number | null {
  try {
    const seconds = Number.parseFloat(readFileSync(path, "utf8").trim());
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

export function readTickerHealth(dir = cronDir(), now = Date.now()): TickerHealth {
  const heartbeat = readEpochFile(join(dir, "ticker_heartbeat"));
  if (heartbeat === null) return { state: "never-run" };

  // Clamped at zero like `_epoch_file_age`'s `max(0.0, ...)`: a clock that went
  // backwards should read as "just now", not as a negative age that would
  // compare as fresh forever.
  const heartbeatAgeMs = Math.max(0, now - heartbeat);
  const success = readEpochFile(join(dir, "ticker_last_success"));
  const successAgeMs = success === null ? null : Math.max(0, now - success);
  const staleMs = TICKER_STALE_AFTER_SECONDS * 1000;

  if (heartbeatAgeMs > staleMs) return { state: "stalled", heartbeatAgeMs, successAgeMs };
  if (successAgeMs === null || successAgeMs > staleMs) {
    return { state: "failing", heartbeatAgeMs, successAgeMs };
  }
  return { state: "running", heartbeatAgeMs, successAgeMs };
}

/**
 * Everything a caller needs to answer "are my tasks going to run?".
 *
 * The two reads are returned together rather than separately because they are
 * only meaningful together. A job list without ticker health invites the
 * conclusion that a listed job will fire, and on this machine right now that
 * conclusion is false.
 */
export interface TaskSnapshot {
  jobs: readonly CronJob[];
  ticker: TickerHealth;
  /** True when jobs exist and the ticker is genuinely running. */
  willFire: boolean;
  /** Present when something is wrong in a way the user can act on. */
  warning?: string;
}

/**
 * The sentence a person needs, in the words they need it in.
 *
 * §61 governs the wording: "If something requires administrator permission or
 * manual configuration, explain exactly what I need to do." The fix for a dead
 * ticker is `hermes gateway install`, which registers a Windows Scheduled Task
 * — so the warning names the command instead of quietly doing it, and instead
 * of the useless "scheduler unavailable".
 */
function warningFor(ticker: TickerHealth, jobCount: number): string | undefined {
  if (jobCount === 0) return undefined;
  switch (ticker.state) {
    case "running":
      return undefined;
    case "never-run":
      return (
        "Hermes' scheduler has never run on this machine, so none of these will fire. " +
        "Run `hermes gateway install` in a terminal to start it at logon."
      );
    case "stalled":
      return (
        `Hermes' scheduler last checked in ${describeAge(ticker.heartbeatAgeMs)} ago, so none of ` +
        "these are firing. Run `hermes gateway start` in a terminal, or `hermes gateway install` " +
        "to have it start at logon."
      );
    case "failing":
      return (
        "Hermes' scheduler is running but every check is failing, so nothing is firing. " +
        "Run `hermes cron status` in a terminal to see why."
      );
  }
}

/** Rounded, spoken-sized. Nobody needs "4 days, 3 hours and 11 minutes". */
export function describeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}

export function readTasks(dir = cronDir(), now = Date.now()): TaskSnapshot {
  const read = readCronJobs(dir);
  const ticker = readTickerHealth(dir, now);
  const jobs = read.jobs.filter((j) => j.enabled);
  const warning = read.error
    ? `Hermes' job list could not be read (${read.error}).`
    : warningFor(ticker, jobs.length);

  return {
    jobs,
    ticker,
    willFire: jobs.length > 0 && ticker.state === "running",
    ...(warning ? { warning } : {}),
  };
}
