import { describe, it, expect } from "vitest";
import { TaskWatcher } from "../src/tasks/task-watcher.js";
import { Notifier, type JarvisNotification } from "../src/notifications/notifier.js";
import type { CronJob, TaskSnapshot, TickerHealth } from "../src/tasks/cron-store.js";

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "Morning digest",
    schedule: "0 9 * * *",
    kind: "cron",
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    noAgent: false,
    ...over,
  };
}

const RUNNING: TickerHealth = { state: "running", heartbeatAgeMs: 1_000, successAgeMs: 1_000 };
const STALLED: TickerHealth = { state: "stalled", heartbeatAgeMs: 9_000_000, successAgeMs: null };

function snapshot(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return { jobs: [], ticker: RUNNING, willFire: false, ...over };
}

/** A watcher whose reads and clock the test drives. `poll()` is stepped by hand. */
function make(first: TaskSnapshot) {
  const shown: JarvisNotification[] = [];
  let current = first;
  let clock = 1_000_000;
  const notifier = new Notifier({ level: "normal", sink: (n) => shown.push(n), now: () => clock });
  const watcher = new TaskWatcher({
    notifier,
    read: () => current,
    now: () => clock,
  });
  return {
    watcher,
    shown,
    notifier,
    set: (s: TaskSnapshot) => {
      current = s;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("the scheduler itself", () => {
  it("reports a dead scheduler on the very first poll", () => {
    // Unlike a job run, this is a live condition rather than history: it is dead
    // *now*, and it stays dead until someone is told. Waiting for a transition
    // would mean only ever telling people whose scheduler died while watching.
    const t = make(snapshot({ jobs: [job()], ticker: STALLED, willFire: false, warning: "Run `hermes gateway start`." }));
    t.watcher.poll();
    expect(t.shown).toHaveLength(1);
    expect(t.shown[0]?.body).toMatch(/hermes gateway start/);
  });

  it("does not repeat it on every poll", () => {
    const t = make(snapshot({ jobs: [job()], ticker: STALLED, warning: "still dead" }));
    for (let i = 0; i < 10; i++) {
      t.watcher.poll();
      t.advance(60_000);
    }
    expect(t.shown.length).toBeLessThanOrEqual(2);
  });

  it("says nothing at all when the scheduler is healthy", () => {
    const t = make(snapshot({ jobs: [job()], ticker: RUNNING, willFire: true }));
    t.watcher.poll();
    t.watcher.poll();
    expect(t.shown).toEqual([]);
  });

  it("speaks immediately when the scheduler dies again after a fix", () => {
    const t = make(snapshot({ jobs: [job()], ticker: STALLED, warning: "dead" }));
    t.watcher.poll();
    t.set(snapshot({ jobs: [job()], ticker: RUNNING, willFire: true }));
    t.watcher.poll();
    t.advance(60_000);
    t.set(snapshot({ jobs: [job()], ticker: STALLED, warning: "dead again" }));
    t.watcher.poll();
    expect(t.shown).toHaveLength(2);
  });
});

describe("job runs", () => {
  it("does not replay old results at startup", () => {
    // Otherwise every restart announces last week's successes, and the user
    // learns to dismiss Jarvis without reading.
    const ran = job({ lastRunAt: 1_000, lastStatus: "ok" });
    const t = make(snapshot({ jobs: [ran], willFire: true }));
    t.watcher.poll();
    expect(t.shown).toEqual([]);
  });

  it("reports a job that failed since the last poll, with Hermes' own reason", () => {
    const t = make(snapshot({ jobs: [job()], willFire: true }));
    t.watcher.poll();
    t.set(
      snapshot({
        jobs: [job({ lastRunAt: 2_000, lastStatus: "error", lastError: "provider timed out" })],
        willFire: true,
      }),
    );
    t.watcher.poll();
    expect(t.shown).toHaveLength(1);
    expect(t.shown[0]?.title).toMatch(/Morning digest/);
    expect(t.shown[0]?.body).toBe("provider timed out");
  });

  it("still says something useful when Hermes gave no reason", () => {
    const t = make(snapshot({ jobs: [job()], willFire: true }));
    t.watcher.poll();
    t.set(snapshot({ jobs: [job({ lastRunAt: 2_000, lastStatus: "error" })], willFire: true }));
    t.watcher.poll();
    expect(t.shown[0]?.body).toMatch(/hermes cron list/);
  });

  it("reports a success only when the user asked to hear about them", () => {
    const t = make(snapshot({ jobs: [job()], willFire: true }));
    t.watcher.poll();
    t.notifier.setLevel("minimal");
    t.set(snapshot({ jobs: [job({ lastRunAt: 2_000, lastStatus: "ok" })], willFire: true }));
    t.watcher.poll();
    expect(t.shown).toEqual([]);
  });

  it("says nothing when a job did not run between polls", () => {
    const ran = job({ lastRunAt: 2_000, lastStatus: "ok" });
    const t = make(snapshot({ jobs: [ran], willFire: true }));
    t.watcher.poll();
    t.watcher.poll();
    t.watcher.poll();
    expect(t.shown).toEqual([]);
  });

  it("does not announce a run for a job created since the last poll", () => {
    // Its `last_run_at` is new to us, but the run is not new to the world — the
    // job may have been created by an agent turn that already fired it once.
    const t = make(snapshot({ jobs: [], willFire: true }));
    t.watcher.poll();
    t.set(snapshot({ jobs: [job({ id: "new", lastRunAt: 5_000, lastStatus: "error" })], willFire: true }));
    t.watcher.poll();
    expect(t.shown).toEqual([]);
  });

  it("forgets a job that has been deleted", () => {
    const t = make(snapshot({ jobs: [job()], willFire: true }));
    t.watcher.poll();
    t.set(snapshot({ jobs: [], willFire: false }));
    t.watcher.poll();
    // Recreated with a run already recorded: treated as new, not as a fresh run.
    t.set(snapshot({ jobs: [job({ lastRunAt: 9_000, lastStatus: "error" })], willFire: true }));
    t.watcher.poll();
    expect(t.shown).toEqual([]);
  });
});

describe("resilience", () => {
  it("survives a read that throws rather than taking down the runtime", () => {
    const logs: string[] = [];
    const watcher = new TaskWatcher({
      notifier: new Notifier({ level: "normal", sink: () => {} }),
      read: () => {
        throw new Error("disk gone");
      },
      onLog: (l) => logs.push(l),
    });
    expect(() => watcher.poll()).not.toThrow();
    expect(logs.join(" ")).toMatch(/disk gone/);
  });

  it("stops cleanly and can be stopped twice", () => {
    const t = make(snapshot());
    t.watcher.start();
    t.watcher.stop();
    expect(() => t.watcher.stop()).not.toThrow();
  });

  it("exposes the last snapshot without re-reading", () => {
    const t = make(snapshot({ jobs: [job()], willFire: true }));
    expect(t.watcher.snapshot()).toBeNull();
    t.watcher.poll();
    expect(t.watcher.snapshot()?.jobs).toHaveLength(1);
  });
});
