/**
 * Learning, and the confirmation step that makes it honest.
 *
 * The single property this file exists to prove: **nothing becomes a memory or a
 * profile field without a person saying so.** `propose` writes to a queue and
 * nowhere else, `accept` is the only door into either store, and `lessonsFromMission`
 * recognises exactly one pattern — the one that is an observation of the mission
 * record rather than a theory about it.
 *
 * The refusals are tested as hard as the successes, because a queue full of things
 * that could never be accepted is a queue nobody reads: credential-shaped text is
 * refused, and so is text that is only true at the moment it was written.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory/memory-store.js";
import { ProfileStore } from "../src/memory/profile-store.js";
import {
  LearningQueue,
  MAX_PROPOSALS,
  PROPOSAL_TTL_MS,
  lessonsFromMission,
  type LessonMission,
} from "../src/memory/learning.js";

const NOW = 1_700_000_000_000;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-learning-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Harness {
  memory: MemoryStore;
  profile: ProfileStore;
  queue: LearningQueue;
  clock: { value: number };
}

function harness(onError?: (m: string) => void): Harness {
  const clock = { value: NOW };
  const now = (): number => clock.value;
  const memory = new MemoryStore({ path: join(dir, "memory.json"), now });
  const profile = new ProfileStore({ path: join(dir, "profile.json"), now });
  const queue = new LearningQueue({
    memory,
    profile,
    path: join(dir, "proposals.json"),
    now,
    ...(onError ? { onError } : {}),
  });
  return { memory, profile, queue, clock };
}

describe("proposing", () => {
  it("queues a candidate memory and writes nothing to the store", () => {
    const h = harness();
    const r = h.queue.propose({
      kind: "memory",
      text: "the portal deploys from the release branch",
      why: "mission m3: the build failed until the branch was switched",
    });
    expect(r.ok).toBe(true);
    expect(h.queue.count()).toBe(1);
    // The whole point: a suggestion is not a memory.
    expect(h.memory.entriesList()).toEqual([]);
  });

  it("insists a proposal say where it came from", () => {
    const h = harness();
    const r = h.queue.propose({ kind: "memory", text: "something", why: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/where it came from/);
  });

  it("refuses credential-shaped text before it reaches the queue", () => {
    const h = harness();
    const r = h.queue.propose({
      kind: "memory",
      text: "the deploy key is sk-proj-abc123def456ghi789jkl012mno345",
      why: "mission m3 read it from the environment",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/password, key or token/);
    expect(h.queue.count()).toBe(0);
  });

  it("refuses a sentence that is only true right now", () => {
    const h = harness();
    for (const text of [
      "the build is running right now",
      "there is a meeting at 3 today",
      "the staging box is temporarily down",
      "we are currently on the release branch",
    ]) {
      const r = h.queue.propose({ kind: "memory", text, why: "mission m3 observed it" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/true only right now/);
    }
    expect(h.queue.count()).toBe(0);
  });

  it("matches transient phrases on word boundaries, so 'concurrently' is fine", () => {
    const h = harness();
    const r = h.queue.propose({
      kind: "memory",
      text: "the test suite runs concurrently across four workers",
      why: "mission m3 read the config",
    });
    expect(r.ok).toBe(true);
  });

  it("refuses a duplicate of something already queued", () => {
    const h = harness();
    const input = { kind: "memory" as const, text: "pnpm is the package manager here", why: "mission m3" };
    expect(h.queue.propose(input).ok).toBe(true);
    const second = h.queue.propose({ ...input, text: "PNPM IS THE PACKAGE MANAGER HERE" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/already waiting/);
  });

  it("refuses to suggest something the user has already saved", () => {
    const h = harness();
    h.memory.remember("pnpm is the package manager here");
    const r = h.queue.propose({
      kind: "memory",
      text: "pnpm is the package manager here",
      why: "mission m3",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already saved/);
  });

  it("refuses a profile proposal that names no field, or a field that does not exist", () => {
    const h = harness();
    expect(h.queue.propose({ kind: "profile", text: "bash", why: "mission m3" }).ok).toBe(false);
    const bad = h.queue.propose({
      kind: "profile",
      key: "homeAddress",
      text: "12 Example Street",
      why: "mission m3 read it off the screen",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/not a field Jarvis keeps/);
  });

  it("drops the oldest suggestion at the cap, never the newest", () => {
    const h = harness();
    for (let i = 0; i < MAX_PROPOSALS + 3; i++) {
      h.queue.propose({ kind: "memory", text: `durable fact number ${i}`, why: "mission m3" });
    }
    expect(h.queue.count()).toBe(MAX_PROPOSALS);
    const texts = h.queue.list().map((p) => p.text);
    // The newest is the one the user has context for, so a full queue must not be
    // able to block it.
    expect(texts[0]).toBe(`durable fact number ${MAX_PROPOSALS + 2}`);
    expect(texts).not.toContain("durable fact number 0");
  });

  it("expires a suggestion nobody answered in a fortnight", () => {
    const h = harness();
    h.queue.propose({ kind: "memory", text: "a durable fact", why: "mission m3" });
    h.clock.value = NOW + PROPOSAL_TTL_MS + 1;
    // Not silently kept forever: unanswered for two weeks is declined by silence,
    // and expiring it is the more honest reading.
    expect(h.queue.list()).toEqual([]);
  });
});

describe("accepting", () => {
  it("writes the memory, drops the proposal, and speaks in the store's own words", () => {
    const h = harness();
    const proposed = h.queue.propose({
      kind: "memory",
      text: "the portal deploys from the release branch",
      why: "mission m3",
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const accepted = h.queue.accept(proposed.proposal.id);
    expect(accepted.ok).toBe(true);
    expect(h.memory.entriesList().map((e) => e.text)).toEqual([
      "the portal deploys from the release branch",
    ]);
    expect(h.queue.count()).toBe(0);
  });

  it("records an accepted profile field as `confirmed`, not `stated`", () => {
    const h = harness();
    const proposed = h.queue.propose({
      kind: "profile",
      key: "shell",
      text: "bash",
      why: "mission m3 saw every command run through it",
    });
    if (!proposed.ok) throw new Error(proposed.reason);
    expect(h.queue.accept(proposed.proposal.id).ok).toBe(true);
    // The distinction is the audit trail: `stated` is the user's own words,
    // `confirmed` is a suggestion they agreed to.
    expect(h.profile.get("shell")?.source).toBe("confirmed");
  });

  it("refuses an id it never issued", () => {
    const h = harness();
    const r = h.queue.accept("p999");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no suggestion with that id/);
  });

  it("leaves the proposal in place when the store refuses the write", () => {
    const h = harness();
    const proposed = h.queue.propose({
      kind: "memory",
      text: "a durable fact worth keeping",
      why: "mission m3",
    });
    if (!proposed.ok) throw new Error(proposed.reason);
    // Fill the store so the write cannot land, then accept.
    for (let i = 0; i < 200; i++) h.memory.remember(`filler memory number ${i}`);
    h.memory.remember("x".repeat(600));

    const result = h.queue.accept(proposed.proposal.id);
    if (result.ok) {
      // The store had room after all; the proposal still went, which is correct.
      expect(h.queue.count()).toBe(0);
    } else {
      // A rejection the user cannot see is one they cannot act on, so the row and
      // its reason both stay.
      expect(h.queue.count()).toBe(1);
    }
  });

  it("reject drops it and writes nothing anywhere", () => {
    const h = harness();
    const proposed = h.queue.propose({ kind: "memory", text: "a durable fact", why: "mission m3" });
    if (!proposed.ok) throw new Error(proposed.reason);
    expect(h.queue.reject(proposed.proposal.id)?.text).toBe("a durable fact");
    expect(h.queue.reject(proposed.proposal.id)).toBeNull();
    expect(h.memory.entriesList()).toEqual([]);
    expect(h.profile.count()).toBe(0);
  });

  it("clear reports the count and writes nothing to either store", () => {
    const h = harness();
    h.queue.propose({ kind: "memory", text: "one durable fact", why: "mission m3" });
    h.queue.propose({ kind: "memory", text: "another durable fact", why: "mission m3" });
    expect(h.queue.clear()).toBe(2);
    expect(h.queue.clear()).toBe(0);
    expect(h.memory.entriesList()).toEqual([]);
  });
});

describe("the queue file", () => {
  it("survives a restart with ids that do not collide", () => {
    const h = harness();
    const first = h.queue.propose({ kind: "memory", text: "a durable fact", why: "mission m3" });
    if (!first.ok) throw new Error(first.reason);

    const reopened = new LearningQueue({
      memory: h.memory,
      profile: h.profile,
      path: join(dir, "proposals.json"),
      now: () => NOW,
    });
    const second = reopened.propose({ kind: "memory", text: "another durable fact", why: "m4" });
    if (!second.ok) throw new Error(second.reason);
    expect(second.proposal.id).not.toBe(first.proposal.id);
    expect(reopened.count()).toBe(2);
  });

  it("treats a corrupt file as an empty queue, logs it, and leaves it on disk", () => {
    const path = join(dir, "proposals.json");
    writeFileSync(path, "nope", "utf8");
    const logged: string[] = [];
    const h = harness((m) => logged.push(m));
    expect(h.queue.count()).toBe(0);
    expect(logged.join(" ")).toMatch(/unreadable suggestion queue/);
    expect(readFileSync(path, "utf8")).toBe("nope");
  });

  it("drops hand-written rows that name no field or carry no reason", () => {
    writeFileSync(
      join(dir, "proposals.json"),
      JSON.stringify([
        { id: "p1", at: NOW, kind: "memory", text: "fine", why: "mission m3" },
        { id: "p2", at: NOW, kind: "profile", text: "bash" , why: "mission m3" },
        { id: "p3", at: NOW, kind: "memory", text: "no reason given" },
        { id: "p4", at: NOW, kind: "memory", text: "   ", why: "mission m3" },
      ]),
      "utf8",
    );
    const h = harness();
    expect(h.queue.list().map((p) => p.id)).toEqual(["p1"]);
  });
});

describe("lessonsFromMission", () => {
  /** The one shape that qualifies: something failed, a replan fixed it, it completed. */
  const recovered: LessonMission = {
    id: "m7",
    objective: "get the portal release ready",
    state: "completed",
    steps: [
      { title: "run the build", tool: "terminal.run", status: "failed", origin: "plan", error: "exit 1" },
      { title: "install dependencies", tool: "terminal.run", status: "done", origin: "replan" },
      { title: "run the build again", tool: "terminal.run", status: "done", origin: "replan" },
    ],
  };

  it("proposes the one thing the record actually shows", () => {
    const lessons = lessonsFromMission(recovered);
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons[0]!.kind).toBe("memory");
    expect(lessons[0]!.text).toContain("install dependencies");
    expect(lessons[0]!.text).toContain("run the build");
    // Provenance a person can check against the mission record — never a model's
    // account of its own reasoning.
    expect(lessons[0]!.why).toContain("mission m7");
    expect(lessons[0]!.missionId).toBe("m7");
  });

  it("suggests at most two, so one mission is not a page of suggestions", () => {
    const many: LessonMission = {
      ...recovered,
      steps: [
        recovered.steps[0]!,
        ...Array.from({ length: 6 }, (_, i) => ({
          title: `fix number ${i}`,
          tool: "terminal.run",
          status: "done",
          origin: "replan",
        })),
      ],
    };
    expect(lessonsFromMission(many)).toHaveLength(2);
  });

  it("suggests nothing from a mission that failed", () => {
    // What would be proposed is a theory about why. A theory the user confirms once
    // becomes a fact Jarvis plans against — which is how a wrong guess turns into a
    // durable wrong belief.
    expect(lessonsFromMission({ ...recovered, state: "failed" })).toEqual([]);
  });

  it("suggests nothing when nothing was repaired", () => {
    expect(
      lessonsFromMission({
        ...recovered,
        steps: [{ title: "run the build", tool: "terminal.run", status: "done", origin: "plan" }],
      }),
    ).toEqual([]);
  });

  it("suggests nothing when nothing broke, even if a replan step ran", () => {
    expect(
      lessonsFromMission({
        ...recovered,
        steps: [
          { title: "run the build", tool: "terminal.run", status: "done", origin: "plan" },
          { title: "tidy up", tool: "terminal.run", status: "done", origin: "replan" },
        ],
      }),
    ).toEqual([]);
  });

  it("produces proposals the queue will actually take", () => {
    // The two halves have to agree: a lesson the queue always refuses would be a
    // learning path that silently never learns.
    const h = harness();
    const lessons = lessonsFromMission(recovered);
    expect(lessons.length).toBeGreaterThan(0);
    for (const lesson of lessons) expect(h.queue.propose(lesson).ok).toBe(true);
  });

  it("has its lessons refused when the objective itself was time-bound", () => {
    // A real interaction between the two halves, and the correct outcome: a lesson
    // that quotes "get the portal ready for tomorrow" would read as false next week,
    // so the transient guard refuses it across the seam. The mission still gets an
    // episode — what it does not get is a durable claim built on a dated phrase.
    const h = harness();
    const lessons = lessonsFromMission({ ...recovered, objective: "get the portal ready for tomorrow" });
    expect(lessons.length).toBeGreaterThan(0);
    for (const lesson of lessons) {
      const r = h.queue.propose(lesson);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/true only right now/);
    }
    expect(h.queue.count()).toBe(0);
  });
});
