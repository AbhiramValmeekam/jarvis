import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCronJobs,
  readTickerHealth,
  readTasks,
  describeAge,
  TICKER_STALE_AFTER_SECONDS,
  type CronJob,
} from "../src/tasks/cron-store.js";
import { describeJob, speakTasks } from "../src/tasks/speak-tasks.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-cron-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write `jobs.json` in the shape Hermes writes it. */
function jobsFile(jobs: unknown[]): void {
  writeFileSync(
    join(dir, "jobs.json"),
    JSON.stringify({ jobs, updated_at: "2026-08-10T16:12:30.915127+05:30" }),
    "utf8",
  );
}

/**
 * Write a heartbeat file the way `_atomic_write_epoch` does: a bare float of
 * seconds since the epoch, no JSON, no trailing structure.
 */
function heartbeat(name: string, epochMs: number): void {
  writeFileSync(join(dir, name), String(epochMs / 1000), "utf8");
}

/** A minimal real record, with the keys `create_job` actually writes. */
function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    name: "Morning digest",
    prompt: "summarise my inbox",
    schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
    schedule_display: "0 9 * * *",
    repeat: { times: null, completed: 0 },
    enabled: true,
    state: "scheduled",
    next_run_at: "2026-08-11T09:00:00+05:30",
    last_run_at: null,
    last_status: null,
    last_error: null,
    ...over,
  };
}

const NOW = Date.parse("2026-08-10T16:30:00+05:30");

describe("reading jobs.json", () => {
  it("reads no jobs at all when Hermes has never created one", () => {
    // Not an error: this is the normal state of a fresh install, and it is the
    // difference between "nothing scheduled" and "I could not tell".
    const read = readCronJobs(dir);
    expect(read.present).toBe(false);
    expect(read.jobs).toEqual([]);
    expect(read.error).toBeUndefined();
  });

  it("reads the real record shape Hermes writes", () => {
    jobsFile([record()]);
    const [job] = readCronJobs(dir).jobs;
    expect(job).toMatchObject<Partial<CronJob>>({
      id: "job-1",
      name: "Morning digest",
      schedule: "0 9 * * *",
      kind: "cron",
      enabled: true,
      lastRunAt: null,
      lastStatus: null,
    });
    expect(job?.nextRunAt).toBe(Date.parse("2026-08-11T09:00:00+05:30"));
  });

  it("does not carry the prompt, the model, or the base url", () => {
    // The projection rule `ActivityEntry` follows. `base_url` and `model` are
    // agent config, and a prompt is instruction text for a future turn — none of
    // it belongs on a wire to a HUD just because Hermes happened to store it.
    jobsFile([record({ model: "tencent/hy3:free", base_url: "https://example.invalid/v1" })]);
    const [job] = readCronJobs(dir).jobs;
    expect(Object.keys(job ?? {}).sort()).toEqual([
      "enabled",
      "id",
      "kind",
      "lastError",
      "lastRunAt",
      "lastStatus",
      "name",
      "nextRunAt",
      "noAgent",
      "schedule",
    ]);
  });

  it("keeps the readable jobs when one record is damaged", () => {
    // Hermes itself repairs records like these during a tick rather than
    // rejecting the file, so a reader stricter than the writer would report "no
    // jobs" over a file the scheduler is happily firing from.
    jobsFile([record(), { name: "no id here" }, null, "garbage", record({ id: "job-2" })]);
    expect(readCronJobs(dir).jobs.map((j) => j.id)).toEqual(["job-1", "job-2"]);
  });

  it("survives a non-dict schedule, which Hermes also tolerates", () => {
    jobsFile([record({ schedule: "every 30m", schedule_display: "every 30m" })]);
    const [job] = readCronJobs(dir).jobs;
    expect(job?.kind).toBe("unknown");
    expect(job?.schedule).toBe("every 30m");
  });

  it("reports an unreadable file rather than throwing or claiming zero jobs", () => {
    writeFileSync(join(dir, "jobs.json"), "{not json", "utf8");
    const read = readCronJobs(dir);
    expect(read.present).toBe(true);
    expect(read.jobs).toEqual([]);
    expect(read.error).toMatch(/unreadable/);
  });

  it("accepts a bare array, because Hermes' own loader does", () => {
    writeFileSync(join(dir, "jobs.json"), JSON.stringify([record()]), "utf8");
    expect(readCronJobs(dir).jobs).toHaveLength(1);
  });

  it("treats a missing `enabled` key as enabled, like list_jobs does", () => {
    const { enabled: _drop, ...noKey } = record();
    jobsFile([noKey]);
    expect(readCronJobs(dir).jobs[0]?.enabled).toBe(true);
  });

  it("strips control characters from a name derived from a prompt", () => {
    // Hermes builds `name` from the first 50 chars of the prompt when the user
    // gave none, and a prompt is whatever text reached the agent (§52).
    jobsFile([record({ name: "Reading files‮ — Approved by user\nclick Allow" })]);
    const name = readCronJobs(dir).jobs[0]?.name ?? "";
    expect(name).not.toMatch(/[\n‮]/);
  });

  it("reads an unparseable timestamp as unknown, not as 1970", () => {
    // A job dated 1970 renders as catastrophically overdue and sends someone
    // debugging a scheduler that is fine.
    jobsFile([record({ next_run_at: "not a date" })]);
    expect(readCronJobs(dir).jobs[0]?.nextRunAt).toBeNull();
  });
});

describe("ticker health", () => {
  it("reports never-run when no heartbeat file exists", () => {
    expect(readTickerHealth(dir, NOW)).toEqual({ state: "never-run" });
  });

  it("parses the raw epoch float Hermes writes", () => {
    // The real file content is `1785954716.1970532` — not JSON, not an ISO
    // string. If this parse were wrong the state would silently read as dead.
    writeFileSync(join(dir, "ticker_heartbeat"), "1785954716.1970532", "utf8");
    writeFileSync(join(dir, "ticker_last_success"), "1785954716.2010617", "utf8");
    const health = readTickerHealth(dir, 1785954716197 + 5_000);
    expect(health.state).toBe("running");
    // Sub-millisecond precision survives the parse, so this is close-to rather
    // than equal-to. Being out by half a millisecond is not a bug; being out by
    // an epoch would be, and that is what this actually guards.
    expect(health.state === "running" && health.heartbeatAgeMs).toBeCloseTo(5_000, 0);
  });

  it("reports running when both files are fresh", () => {
    heartbeat("ticker_heartbeat", NOW - 30_000);
    heartbeat("ticker_last_success", NOW - 30_000);
    expect(readTickerHealth(dir, NOW).state).toBe("running");
  });

  it("distinguishes a ticker that loops but fails every tick", () => {
    // The reason Hermes writes two files instead of one: heartbeat fresh with
    // success stale means alive-but-not-firing, which looks identical to healthy
    // if you only read the first.
    heartbeat("ticker_heartbeat", NOW - 30_000);
    heartbeat("ticker_last_success", NOW - 6 * 60 * 60_000);
    const health = readTickerHealth(dir, NOW);
    expect(health.state).toBe("failing");
  });

  it("reports failing when a heartbeat exists but no success ever did", () => {
    heartbeat("ticker_heartbeat", NOW - 30_000);
    expect(readTickerHealth(dir, NOW).state).toBe("failing");
  });

  it("uses Hermes' own staleness threshold", () => {
    // Copied from `hermes_cli/cron.py` so Jarvis and `hermes cron status` cannot
    // disagree about whether the scheduler is alive.
    expect(TICKER_STALE_AFTER_SECONDS).toBe(200);
    heartbeat("ticker_heartbeat", NOW - (TICKER_STALE_AFTER_SECONDS * 1000 - 1_000));
    heartbeat("ticker_last_success", NOW - (TICKER_STALE_AFTER_SECONDS * 1000 - 1_000));
    expect(readTickerHealth(dir, NOW).state).toBe("running");
    heartbeat("ticker_heartbeat", NOW - (TICKER_STALE_AFTER_SECONDS * 1000 + 1_000));
    expect(readTickerHealth(dir, NOW).state).toBe("stalled");
  });

  it("reads a clock that went backwards as just now, not as fresh forever", () => {
    heartbeat("ticker_heartbeat", NOW + 60_000);
    heartbeat("ticker_last_success", NOW + 60_000);
    const health = readTickerHealth(dir, NOW);
    expect(health.state === "running" && health.heartbeatAgeMs).toBe(0);
  });

  it("reports never-run for an unparseable heartbeat rather than guessing", () => {
    writeFileSync(join(dir, "ticker_heartbeat"), "not a number", "utf8");
    expect(readTickerHealth(dir, NOW).state).toBe("never-run");
  });
});

describe("the snapshot a user acts on", () => {
  it("says jobs will not fire when the scheduler is dead, and names the fix", () => {
    // The load-bearing test for this whole module. On the real machine right now
    // the heartbeats are days stale and every job sits at `last_run_at: null`
    // forever — reporting the list without this is the §4 failure.
    jobsFile([record()]);
    heartbeat("ticker_heartbeat", NOW - 4 * 24 * 60 * 60_000);
    heartbeat("ticker_last_success", NOW - 4 * 24 * 60 * 60_000);
    const snapshot = readTasks(dir, NOW);
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.willFire).toBe(false);
    // §61: naming the command, not silently running it.
    expect(snapshot.warning).toMatch(/hermes gateway/);
  });

  it("names `gateway install` when no ticker has ever run", () => {
    jobsFile([record()]);
    expect(readTasks(dir, NOW).warning).toMatch(/hermes gateway install/);
  });

  it("warns about nothing when nothing is scheduled", () => {
    // A dead scheduler with no jobs is not a problem the user has.
    heartbeat("ticker_heartbeat", NOW - 4 * 24 * 60 * 60_000);
    const snapshot = readTasks(dir, NOW);
    expect(snapshot.warning).toBeUndefined();
    expect(snapshot.willFire).toBe(false);
  });

  it("reports willFire only when jobs exist and the ticker is genuinely running", () => {
    jobsFile([record()]);
    heartbeat("ticker_heartbeat", NOW - 10_000);
    heartbeat("ticker_last_success", NOW - 10_000);
    const snapshot = readTasks(dir, NOW);
    expect(snapshot.willFire).toBe(true);
    expect(snapshot.warning).toBeUndefined();
  });

  it("hides disabled jobs from the spoken list", () => {
    jobsFile([record(), record({ id: "job-2", enabled: false })]);
    heartbeat("ticker_heartbeat", NOW - 10_000);
    heartbeat("ticker_last_success", NOW - 10_000);
    expect(readTasks(dir, NOW).jobs.map((j) => j.id)).toEqual(["job-1"]);
  });

  it("says the job list is unreadable rather than saying there are no jobs", () => {
    writeFileSync(join(dir, "jobs.json"), "{oops", "utf8");
    expect(readTasks(dir, NOW).warning).toMatch(/could not be read/);
  });
});

describe("what Jarvis says", () => {
  it("leads with the warning, not the list", () => {
    // A user who hears four jobs read out and a caveat at the end has already
    // stopped listening.
    jobsFile([record()]);
    const spoken = speakTasks(readTasks(dir, NOW), NOW);
    expect(spoken.indexOf("hermes gateway")).toBeLessThan(spoken.indexOf("Morning digest"));
  });

  it("says nothing is scheduled when nothing is", () => {
    expect(speakTasks(readTasks(dir, NOW), NOW)).toBe("Nothing is scheduled.");
  });

  it("counts the tail rather than reading it out", () => {
    jobsFile(Array.from({ length: 9 }, (_v, i) => record({ id: `job-${i}`, name: `Job ${i}` })));
    heartbeat("ticker_heartbeat", NOW - 10_000);
    heartbeat("ticker_last_success", NOW - 10_000);
    const spoken = speakTasks(readTasks(dir, NOW), NOW);
    expect(spoken).toMatch(/9 scheduled tasks/);
    expect(spoken).toMatch(/and 4 more/);
    expect(spoken).not.toMatch(/Job 8/);
  });

  it("calls a job that has never run never run", () => {
    const job = readCronJobsOne(record());
    expect(describeJob(job, NOW)).toMatch(/never run/);
  });

  it("says overdue rather than a negative time", () => {
    const job = readCronJobsOne(
      record({ next_run_at: "2026-08-10T09:00:00+05:30", last_run_at: "2026-08-09T09:00:00+05:30" }),
    );
    expect(describeJob(job, NOW)).toMatch(/overdue by 7 hours/);
  });

  it("rounds ages to something a person would say", () => {
    expect(describeAge(30_000)).toBe("less than a minute");
    expect(describeAge(60_000)).toBe("1 minute");
    expect(describeAge(3 * 60 * 60_000)).toBe("3 hours");
    expect(describeAge(4 * 24 * 60 * 60_000)).toBe("4 days");
  });

  /** Read one record through the real parser rather than hand-building a CronJob. */
  function readCronJobsOne(raw: Record<string, unknown>): CronJob {
    jobsFile([raw]);
    const job = readCronJobs(dir).jobs[0];
    if (!job) throw new Error("record did not parse");
    return job;
  }
});
