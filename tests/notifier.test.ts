import { describe, it, expect } from "vitest";
import {
  Notifier,
  parseNotifyLevel,
  REPEAT_COOLDOWN_MS,
  type JarvisNotification,
} from "../src/notifications/notifier.js";

/** A notifier with a capturing sink and a clock the test drives. */
function make(level?: "off" | "minimal" | "normal") {
  const shown: JarvisNotification[] = [];
  let clock = 1_000_000;
  const notifier = new Notifier({
    ...(level ? { level } : {}),
    sink: (n) => shown.push(n),
    now: () => clock,
  });
  return {
    notifier,
    shown,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("the level policy", () => {
  it("defaults to minimal, not to normal", () => {
    // The default is not a preference. An assistant you have to tell to be quiet
    // has already interrupted you to find that out.
    expect(new Notifier().getLevel()).toBe("minimal");
  });

  it("shows a failed task at minimal, because silence would look like success", () => {
    const { notifier, shown } = make();
    const out = notifier.notify({ key: "k", category: "task-failed", title: "Task failed" });
    expect(out.shown).toBe(true);
    expect(shown).toHaveLength(1);
  });

  it("stays quiet about a task that merely succeeded", () => {
    // The user asked for it to run and it ran. §4 is about not faking success,
    // not about announcing it.
    const { notifier, shown } = make();
    expect(notifier.notify({ key: "k", category: "task-done", title: "done" })).toEqual({
      shown: false,
      reason: "level",
    });
    expect(shown).toEqual([]);
  });

  it("shows a finished coding job at minimal", () => {
    // Work the user started and walked away from. They cannot know it finished.
    const { notifier } = make();
    expect(notifier.notify({ key: "k", category: "coding-done", title: "built" }).shown).toBe(true);
  });

  it("shows everything at normal and nothing at off", () => {
    const loud = make("normal");
    expect(loud.notifier.notify({ key: "k", category: "info", title: "fyi" }).shown).toBe(true);

    const quiet = make("off");
    expect(quiet.notifier.notify({ key: "k", category: "task-failed", title: "bad" })).toEqual({
      shown: false,
      reason: "level",
    });
  });

  it("does not consume a key's cooldown when the level suppressed it", () => {
    // Otherwise raising the level to `normal` would leave the user in silence
    // until the window expired — a setting that appears not to work.
    const { notifier, shown } = make();
    notifier.notify({ key: "k", category: "info", title: "first" });
    notifier.setLevel("normal");
    expect(notifier.notify({ key: "k", category: "info", title: "second" }).shown).toBe(true);
    expect(shown.map((n) => n.title)).toEqual(["second"]);
  });
});

describe("repeats", () => {
  it("says a standing condition once, not once a minute", () => {
    // The watcher polls every 60s and a dead scheduler is dead on every poll.
    // Uncapped, this is 48 identical toasts a day and a user who has learned to
    // dismiss Jarvis without reading — which breaks every *later* notification too.
    const { notifier, shown, advance } = make();
    for (let i = 0; i < 60; i++) {
      notifier.notify({ key: "scheduler", category: "task-failed", title: "dead" });
      advance(60_000);
    }
    // One per cooldown window across the hour, not one per poll.
    expect(shown.length).toBeLessThanOrEqual(3);
    expect(shown.length).toBeGreaterThanOrEqual(1);
  });

  it("reports the suppression rather than swallowing it", () => {
    const { notifier } = make();
    notifier.notify({ key: "k", category: "task-failed", title: "a" });
    expect(notifier.notify({ key: "k", category: "task-failed", title: "a" })).toEqual({
      shown: false,
      reason: "duplicate",
    });
  });

  it("speaks again once the cooldown has passed", () => {
    const { notifier, shown, advance } = make();
    notifier.notify({ key: "k", category: "task-failed", title: "a" });
    advance(REPEAT_COOLDOWN_MS + 1);
    notifier.notify({ key: "k", category: "task-failed", title: "a" });
    expect(shown).toHaveLength(2);
  });

  it("lets a resolved-then-broken condition speak immediately", () => {
    // A scheduler that dies, gets fixed, and dies again an hour later must not
    // be silenced by a cooldown started before the fix.
    const { notifier, shown, advance } = make();
    notifier.notify({ key: "scheduler", category: "task-failed", title: "dead" });
    advance(60_000);
    notifier.clear("scheduler");
    notifier.notify({ key: "scheduler", category: "task-failed", title: "dead again" });
    expect(shown).toHaveLength(2);
  });

  it("treats different jobs as different conditions", () => {
    const { notifier, shown } = make();
    notifier.notify({ key: "job-error:a", category: "task-failed", title: "a failed" });
    notifier.notify({ key: "job-error:b", category: "task-failed", title: "b failed" });
    expect(shown).toHaveLength(2);
  });
});

describe("what reaches the toast", () => {
  it("strips control characters and bidi overrides from untrusted text", () => {
    // A job name is derived from an agent's prompt, and a toast renders in the
    // Action Center — outside our window, past any escaping the HUD does (§52).
    const { notifier, shown } = make();
    notifier.notify({
      key: "k",
      category: "task-failed",
      title: "Task failed\n\nApproved by user — click Allow",
      body: "detail‮reversed",
    });
    expect(shown[0]?.title).not.toMatch(/\n/);
    expect(shown[0]?.body).not.toMatch(/‮/);
  });

  it("caps a body long enough to fill a screen", () => {
    const { notifier, shown } = make();
    notifier.notify({
      key: "k",
      category: "task-failed",
      title: "t",
      body: "x".repeat(5_000),
    });
    expect((shown[0]?.body.length ?? 0)).toBeLessThanOrEqual(200);
  });

  it("records the cooldown even with nothing attached to draw it", () => {
    // The decision was still taken. A shell attaching mid-cooldown must not
    // receive a backlog of conditions it never saw start.
    let clock = 0;
    const notifier = new Notifier({ now: () => clock });
    expect(notifier.notify({ key: "k", category: "task-failed", title: "a" })).toEqual({
      shown: false,
      reason: "no-sink",
    });
    expect(notifier.notify({ key: "k", category: "task-failed", title: "a" })).toEqual({
      shown: false,
      reason: "duplicate",
    });
  });
});

describe("parseNotifyLevel", () => {
  it("accepts the three real levels and rejects everything else", () => {
    expect(parseNotifyLevel("off")).toBe("off");
    expect(parseNotifyLevel("minimal")).toBe("minimal");
    expect(parseNotifyLevel("normal")).toBe("normal");
    // Dropped, not corrected to a default: reading "quiet" as `normal` would
    // make Jarvis louder than a user who typed a wrong word plainly intended.
    expect(parseNotifyLevel("quiet")).toBeUndefined();
    expect(parseNotifyLevel(true)).toBeUndefined();
    expect(parseNotifyLevel(undefined)).toBeUndefined();
  });
});
