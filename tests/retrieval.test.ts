/**
 * Retrieval: which rows a mission is told about, and how each one was found.
 *
 * The arithmetic is what gets tested, because it is the part nobody can eyeball. Two
 * rankings on incomparable scales are fused by rank rather than by score; recency is
 * *added* so an old exact match can still win; an episode is weighted down because a
 * thing that happened is weaker evidence than a thing the user stated; and a row
 * matched by neither ranking is labelled `recent` rather than reported as a keyword
 * hit it never was.
 *
 * The off switch is tested hardest. "Off but the profile still travels" would be a
 * switch that does nothing, and a user who switched memory off and was then
 * addressed by name would be right to say so.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory/memory-store.js";
import { EpisodicStore } from "../src/memory/episodic-store.js";
import { ProfileStore, PROFILE_FIELDS } from "../src/memory/profile-store.js";
import { VectorIndex } from "../src/memory/vector-index.js";
import {
  MAX_RETRIEVED_CHARS,
  RECENCY_HALF_LIFE_MS,
  Retriever,
  recencyScore,
  toMemoryRefs,
} from "../src/memory/retrieval.js";

const NOW = 1_700_000_000_000;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-retrieval-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Harness {
  memory: MemoryStore;
  episodes: EpisodicStore;
  profile: ProfileStore;
  vectors: VectorIndex;
  retriever: Retriever;
  enabled: { value: boolean };
}

/** Every store over the temp directory, on a fixed clock. */
function harness(opts: { withVectors?: boolean } = {}): Harness {
  let tick = NOW - 100_000;
  const now = (): number => (tick += 1000);
  const memory = new MemoryStore({ path: join(dir, "memory.json"), now });
  const episodes = new EpisodicStore({ path: join(dir, "episodes.json"), now });
  const profile = new ProfileStore({ path: join(dir, "profile.json"), now });
  const vectors = new VectorIndex({ path: join(dir, "vectors.json") });
  const enabled = { value: true };
  const retriever = new Retriever({
    memory,
    episodes,
    profile,
    ...(opts.withVectors === false ? {} : { vectors }),
    now: () => NOW,
    enabled: () => enabled.value,
  });
  return { memory, episodes, profile, vectors, retriever, enabled };
}

describe("recencyScore", () => {
  it("is 1 now, a half a half-life ago, and never negative", () => {
    expect(recencyScore(NOW, NOW)).toBeCloseTo(1, 6);
    expect(recencyScore(NOW - RECENCY_HALF_LIFE_MS, NOW)).toBeCloseTo(0.5, 6);
    expect(recencyScore(NOW - 4 * RECENCY_HALF_LIFE_MS, NOW)).toBeGreaterThan(0);
  });

  it("does not reward a timestamp in the future or a missing one", () => {
    // Clamped, so a clock skew or a hand-edited `at` cannot buy a row the top slot.
    expect(recencyScore(NOW + RECENCY_HALF_LIFE_MS, NOW)).toBeCloseTo(1, 6);
    expect(recencyScore(0, NOW)).toBe(0);
    expect(recencyScore(Number.NaN, NOW)).toBe(0);
  });
});

describe("the off switch", () => {
  it("returns nothing at all, including the profile", async () => {
    const h = harness();
    h.memory.remember("the portal deploys from the release branch");
    h.profile.set("name", "Tony", "stated");
    h.enabled.value = false;

    const result = await h.retriever.retrieve("get the portal ready");
    expect(result.enabled).toBe(false);
    expect(result.facts).toEqual([]);
    // Nothing was deleted — the store still has it, waiting for the switch.
    expect(h.memory.entriesList()).toHaveLength(1);
  });

  it("still describes the index, so a page can say what search would be", async () => {
    const h = harness();
    h.enabled.value = false;
    const result = await h.retriever.retrieve("anything");
    expect(result.embedder).toContain("lexical");
    expect(result.semantic).toBe(false);
  });

  it("reads the switch at call time, so flipping it takes effect immediately", async () => {
    const h = harness();
    h.memory.remember("the portal deploys from the release branch");
    h.enabled.value = false;
    expect((await h.retriever.retrieve("portal")).facts).toEqual([]);
    h.enabled.value = true;
    expect((await h.retriever.retrieve("portal")).facts.length).toBeGreaterThan(0);
  });
});

describe("what comes back", () => {
  it("carries the whole profile first, labelled as always-carried rather than matched", async () => {
    const h = harness();
    h.profile.set("name", "Tony", "stated");
    h.profile.set("shell", "bash", "stated");
    h.memory.remember("the portal deploys from the release branch");

    const result = await h.retriever.retrieve("get the portal ready");
    const first = result.facts.slice(0, 2);
    expect(first.map((f) => f.source)).toEqual(["profile", "profile"]);
    expect(first.map((f) => f.method)).toEqual(["profile", "profile"]);
    expect(first[0]!.summary).toBe(`${PROFILE_FIELDS.name.label}: Tony`);
    // Score 1 and method `profile`: not a ranking result, and labelled so a reader
    // cannot mistake "always carried" for "matched this objective".
    expect(first[0]!.score).toBe(1);
  });

  it("labels a keyword hit, a vector-only hit and a row here on age alone", async () => {
    const h = harness();
    h.memory.remember("the portal deploys from the release branch");
    h.memory.remember("prefer pnpm over npm in this house");
    await h.retriever.sync();

    const result = await h.retriever.retrieve("deployment");
    const byMethod = new Map(result.facts.map((f) => [f.summary, f.method]));
    // "deployment" is not a substring of "deploys", so keyword `recall` scores this
    // row zero and it is reachable only through the vector layer — the exact gap
    // the index was added to close.
    expect(byMethod.get("the portal deploys from the release branch")).toBe("vector");
    // The unrelated row matched neither ranking, so it is here on age alone and is
    // named `recent` rather than reported as a keyword hit it never was.
    expect(byMethod.get("prefer pnpm over npm in this house")).toBe("recent");
    for (const method of byMethod.values()) {
      expect(["keyword", "vector", "both", "recent"]).toContain(method);
    }
  });

  it("scores a row found by both rankings above one found by either", async () => {
    const h = harness();
    h.memory.remember("the release branch is what the portal deploys from");
    h.memory.remember("nothing whatsoever about branches");
    await h.retriever.sync();

    const result = await h.retriever.retrieve("release branch");
    const both = result.facts.find((f) => f.method === "both");
    expect(both).toBeDefined();
    for (const other of result.facts) {
      if (other === both || other.source === "profile") continue;
      expect(both!.score).toBeGreaterThanOrEqual(other.score);
    }
  });

  it("weighs an episode below a memory that matched just as well", async () => {
    const h = harness();
    h.memory.remember("the portal deploys from the release branch");
    h.episodes.record({
      kind: "mission",
      title: "the portal deploys from the release branch",
      outcome: "completed",
    });
    await h.retriever.sync();

    const result = await h.retriever.retrieve("portal release branch");
    const memory = result.facts.find((f) => f.source === "memory");
    const episode = result.facts.find((f) => f.source === "episode");
    expect(memory).toBeDefined();
    expect(episode).toBeDefined();
    expect(memory!.score).toBeGreaterThan(episode!.score);
  });

  it("lets an old exact match beat a recent irrelevant one", async () => {
    // Recency is added, not multiplied. The other arrangement quietly buries
    // everything a user said more than a month ago.
    const h = harness();
    const old = h.memory.remember("the portal deploys from the release branch");
    h.memory.remember("the cat is called Biscuit");
    // Reach past the store's own clock to age one row by four half-lives.
    const entries = h.memory.entriesList() as unknown as { id: string; at: number }[];
    const row = entries.find((e) => e.id === old.entry!.id)!;
    Object.assign(row, { at: NOW - 4 * RECENCY_HALF_LIFE_MS });

    const result = await h.retriever.retrieve("portal release branch");
    expect(result.facts[0]?.summary).toBe("the portal deploys from the release branch");
  });

  it("drops a row that is here on age alone rather than padding the card", async () => {
    const h = harness();
    h.memory.remember("the cat is called Biscuit");
    const entries = h.memory.entriesList() as unknown as { at: number }[];
    Object.assign(entries[0]!, { at: NOW - 6 * RECENCY_HALF_LIFE_MS });

    const result = await h.retriever.retrieve("something else entirely");
    // "Here is a memory, for no reason" is worse than a shorter list.
    expect(result.facts).toEqual([]);
    expect(result.considered).toBe(1);
  });

  it("counts everything it looked at, so a UI can say '8 of 14' honestly", async () => {
    const h = harness();
    for (let i = 0; i < 12; i++) h.memory.remember(`memory number ${i} about nothing`);
    h.episodes.record({ kind: "mission", title: "a mission", outcome: "completed" });
    h.profile.set("name", "Tony", "stated");

    const result = await h.retriever.retrieve("memory number 3");
    // 12 memories + 1 episode + 1 profile field, all of them looked at.
    expect(result.considered).toBe(14);
    expect(result.facts.length).toBeLessThan(result.considered);
  });

  it("honours the row limit and the character budget", async () => {
    const h = harness();
    for (let i = 0; i < 12; i++) {
      h.memory.remember(`row ${i}: the portal deploys from the release branch`);
    }
    await h.retriever.sync();

    const three = await h.retriever.retrieve("portal release branch", 3);
    expect(three.facts).toHaveLength(3);

    const long = harness();
    for (let i = 0; i < 8; i++) {
      long.memory.remember(`row ${i} portal release branch ${"x".repeat(400)}`);
    }
    await long.retriever.sync();
    const result = await long.retriever.retrieve("portal release branch");
    const chars = result.facts.reduce((n, f) => n + f.summary.length, 0);
    expect(chars).toBeLessThanOrEqual(MAX_RETRIEVED_CHARS);
  });

  it("works with no index at all, on keyword and recency alone", async () => {
    const h = harness({ withVectors: false });
    h.memory.remember("the portal deploys from the release branch");
    const result = await h.retriever.retrieve("portal release branch");
    expect(result.embedder).toBeNull();
    expect(result.semantic).toBe(false);
    expect(result.facts.some((f) => f.method === "keyword")).toBe(true);
    expect(await h.retriever.sync()).toBeNull();
  });
});

describe("sync", () => {
  it("indexes memories and episodes together and reports the index's own words", async () => {
    const h = harness();
    h.memory.remember("the portal deploys from the release branch");
    h.episodes.record({ kind: "mission", title: "checked the portal", outcome: "failed" });
    const report = await h.retriever.sync();
    expect(report?.total).toBe(2);
    expect(report?.semantic).toBe(false);
    expect(report?.degraded).toBeUndefined();
  });
});

describe("toMemoryRefs", () => {
  it("keeps the source and the method, and truncates a long citation", () => {
    const refs = toMemoryRefs([
      { source: "memory", id: "m1", summary: "x".repeat(400), score: 1, method: "vector", at: NOW },
    ]);
    expect(refs[0]!.source).toBe("memory");
    // The method travels because "vector" is a weaker claim than "keyword", and a
    // card that hid the difference would overstate why a row is on the plan.
    expect(refs[0]!.method).toBe("vector");
    expect(refs[0]!.summary.length).toBeLessThanOrEqual(200);
    expect(refs[0]!.summary.endsWith("…")).toBe(true);
  });

  it("leaves a short citation exactly as it was", () => {
    const refs = toMemoryRefs([
      { source: "profile", id: "name", summary: "Name: Tony", score: 1, method: "profile", at: NOW },
    ]);
    expect(refs[0]!.summary).toBe("Name: Tony");
  });
});
