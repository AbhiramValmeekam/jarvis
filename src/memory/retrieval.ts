/**
 * What a mission is told before it plans, and why those rows and not others.
 *
 * Phase 13 gave the orchestrator a `retrieve` hook and filled it with the simplest
 * thing that worked: the memory store's keyword `recall`, then the most recent
 * entries. This replaces the filling, not the hook — which matters, because the hook
 * is failure-tolerant by design and a retrieval layer that throws still leaves a
 * mission uninformed rather than broken.
 *
 * Four layers are read and they are not interchangeable:
 *
 *  - **profile** — eight short fields about the person. Always carried when the
 *    layer is on, because "who is this for" is context for every objective and the
 *    whole profile is smaller than one memory.
 *  - **memory** — what the user asked Jarvis to keep. Ranked.
 *  - **episodes** — what happened before. Ranked, and weighted down: a thing that
 *    happened is weaker evidence than a thing the user stated.
 *  - **vectors** — the same memories and episodes, reachable by similarity rather
 *    than by shared words.
 *
 * **Two rankings, fused, rather than one score.** Keyword rank and vector rank
 * measure different things on incomparable scales, and multiplying a cosine by a
 * keyword count would produce a number that sorts without meaning anything.
 * Reciprocal-rank fusion needs no calibration: a row near the top of either list
 * ranks well, a row near the top of both ranks best, and the arithmetic is
 * inspectable in a test. Recency is then added, not multiplied, so an old but
 * exactly-matching memory can still win — the opposite arrangement quietly buries
 * everything a user said more than a month ago.
 *
 * Every row that comes out of here is **data** (§52). It is fenced by
 * `memory-prompt.ts` before a model sees it, and it reaches the plan as a citation
 * on the retrieval card rather than as an instruction.
 */
import type { MemoryStore } from "./memory-store.js";
import type { EpisodicStore } from "./episodic-store.js";
import { PROFILE_FIELDS, type ProfileStore } from "./profile-store.js";
import type { Embeddable, SyncReport, VectorIndex } from "./vector-index.js";

export type FactSource = "memory" | "profile" | "episode";
export type FactMethod = "keyword" | "vector" | "both" | "profile" | "recent";

export interface RetrievedFact {
  readonly source: FactSource;
  /** The row's own id — `m3`, `e7`, or a profile key. */
  readonly id: string;
  /** Display-safe, already capped by the store that holds it. */
  readonly summary: string;
  /** 0…1, and only meaningful against the other rows in the same result. */
  readonly score: number;
  /** How this row was found. Shown, because "vector" is a weaker claim than "keyword". */
  readonly method: FactMethod;
  readonly at: number;
}
export interface RetrievalResult {
  readonly facts: readonly RetrievedFact[];
  /** Rows looked at, before ranking. Lets the UI say "3 of 41" honestly. */
  readonly considered: number;
  /** False when the user has memory switched off: the list is empty *by choice*. */
  readonly enabled: boolean;
  /** The index's own description, or null when there is no index. */
  readonly embedder: string | null;
  /** True only if a real embedding model is behind the vectors. */
  readonly semantic: boolean;
}

export interface RetrievalDeps {
  readonly memory: MemoryStore;
  readonly episodes?: EpisodicStore;
  readonly profile?: ProfileStore;
  readonly vectors?: VectorIndex;
  now?(): number;
  /** The off switch, read at call time so flipping it takes effect immediately. */
  enabled?(): boolean;
}

/**
 * Budgets.
 *
 * Rows and characters both, because they bound different failures: eight rows of
 * 600 characters would be a wall of text in the retrieval card, and forty rows of
 * ten characters would be a citation list nobody reads. The character cap matches
 * `memory-prompt.ts`'s, since the same rows are what a model is given.
 */
export const MAX_RETRIEVED = 8;
export const MAX_RETRIEVED_CHARS = 1_200;

/**
 * How fast a fact loses ground for being old: half its recency term every 21 days.
 *
 * Three weeks is chosen against how people actually use this. A memory from
 * yesterday and a memory from a month ago are both current; one from six months ago
 * is usually about a project that ended. The term is *added* to relevance rather
 * than scaling it, so age never makes an exact match invisible.
 */
export const RECENCY_HALF_LIFE_MS = 21 * 24 * 60 * 60 * 1000;

/** Fusion weights. Keyword leads because it is the stronger claim when it fires. */
const W_KEYWORD = 0.6;
const W_VECTOR = 0.4;
/** The rank offset in reciprocal-rank fusion. Small, so the top rows stay separated. */
const RRF_K = 2;
/** Relevance against recency, in the final sum. */
const W_RELEVANCE = 0.75;
const W_RECENCY = 0.25;
/** An episode is weaker evidence than something the user said outright. */
const EPISODE_WEIGHT = 0.7;
/** 1 at now, 0.5 one half-life ago. Clamped, so a future timestamp is not a bonus. */
export function recencyScore(at: number, now: number): number {
  if (!Number.isFinite(at) || at <= 0) return 0;
  const age = Math.max(0, now - at);
  return 0.5 ** (age / RECENCY_HALF_LIFE_MS);
}

interface Candidate {
  readonly source: FactSource;
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

/**
 * The retriever.
 *
 * Holds no state of its own beyond the stores it was given: every call re-reads
 * them, because a mission started thirty seconds after the user saved a memory has
 * to see it.
 */
export class Retriever {
  private readonly deps: RetrievalDeps;
  private readonly now: () => number;
  private readonly isEnabled: () => boolean;

  constructor(deps: RetrievalDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.isEnabled = deps.enabled ?? (() => true);
  }

  /** Everything indexable, as the vector index wants it. Memories and episodes. */
  private embeddables(): readonly Embeddable[] {
    const rows: Embeddable[] = this.deps.memory
      .entriesList()
      .map((e) => ({ id: e.id, text: e.text, at: e.at }));
    for (const e of this.deps.episodes?.list() ?? []) {
      rows.push({ id: e.id, text: `${e.title} — ${e.outcome}${e.detail ? ` — ${e.detail}` : ""}`, at: e.at });
    }
    return rows;
  }

  /**
   * Bring the index up to date. Called after a write, and once at startup.
   *
   * Returns the index's own report rather than a boolean, so a caller can log that
   * nothing was indexed because the embedder was unreachable — which is a different
   * fact from an empty store.
   */
  async sync(): Promise<SyncReport | null> {
    if (!this.deps.vectors) return null;
    return this.deps.vectors.sync(this.embeddables());
  }
  /**
   * The rows worth carrying for this objective.
   *
   * Order of business: refuse if memory is off, gather candidates, rank the two
   * lists, fuse, add recency, then spend the budget — profile first, because it is
   * cheap and unconditionally relevant, and the ranked rows after it.
   */
  async retrieve(objective: string, limit = MAX_RETRIEVED): Promise<RetrievalResult> {
    const describe = this.deps.vectors?.describe();
    const base = {
      considered: 0,
      enabled: this.isEnabled(),
      embedder: describe?.embedder ?? null,
      semantic: describe?.semantic ?? false,
    };
    // Off is off. Not "off but the profile still travels": a user who switched
    // memory off and then saw Jarvis address them by name would be right to
    // conclude the switch does nothing.
    if (!base.enabled) return { ...base, facts: [] };

    const candidates = new Map<string, Candidate>();
    const add = (c: Candidate): void => {
      if (c.text.trim()) candidates.set(c.id, c);
    };
    for (const e of this.deps.memory.entriesList()) {
      add({ source: "memory", id: e.id, text: e.text, at: e.at });
    }
    for (const e of this.deps.episodes?.list() ?? []) {
      add({
        source: "episode",
        id: e.id,
        text: `${e.title} — ${e.outcome}${e.detail ? ` — ${e.detail}` : ""}`,
        at: e.at,
      });
    }

    // Two rankings over the same candidate set. `recall` and `search` return their
    // own orders; only the position in each is used, which is what makes fusing
    // them legitimate without calibrating one against the other.
    const keywordRank = new Map<string, number>();
    let rank = 0;
    for (const e of this.deps.memory.recall(objective)) keywordRank.set(e.id, rank++);
    for (const e of this.deps.episodes?.search(objective) ?? []) {
      if (!keywordRank.has(e.id)) keywordRank.set(e.id, rank++);
    }

    const vectorRank = new Map<string, number>();
    if (this.deps.vectors) {
      const hits = await this.deps.vectors.search(objective, limit * 3);
      let i = 0;
      for (const hit of hits) if (candidates.has(hit.id)) vectorRank.set(hit.id, i++);
    }
    const now = this.now();
    // The most one row could score before recency: top of both lists. Divided out,
    // so relevance and recency are both 0…1 and the weights below mean what they say.
    const maxFusion = W_KEYWORD / RRF_K + W_VECTOR / RRF_K;
    const scored: RetrievedFact[] = [];
    for (const c of candidates.values()) {
      const kw = keywordRank.get(c.id);
      const vec = vectorRank.get(c.id);
      const fusion =
        (kw === undefined ? 0 : W_KEYWORD / (RRF_K + kw)) +
        (vec === undefined ? 0 : W_VECTOR / (RRF_K + vec));
      const relevance = fusion / maxFusion;
      const recency = recencyScore(c.at, now);
      const method: FactMethod =
        kw !== undefined && vec !== undefined
          ? "both"
          : kw !== undefined
            ? "keyword"
            : vec !== undefined
              ? "vector"
              // Matched by neither, so it is here on recency alone. Named, rather
              // than reported as a keyword hit it never was.
              : "recent";
      const weight = c.source === "episode" ? EPISODE_WEIGHT : 1;
      scored.push({
        source: c.source,
        id: c.id,
        summary: c.text,
        score: (W_RELEVANCE * relevance + W_RECENCY * recency) * weight,
        method,
        at: c.at,
      });
    }

    const facts: RetrievedFact[] = [];
    let chars = 0;
    const spend = (fact: RetrievedFact): boolean => {
      if (facts.length >= limit) return false;
      if (chars + fact.summary.length > MAX_RETRIEVED_CHARS) return true;
      chars += fact.summary.length;
      facts.push(fact);
      return true;
    };

    for (const f of this.deps.profile?.list() ?? []) {
      // Score 1 and method `profile`: not a ranking result, and labelled so that a
      // reader cannot mistake "always carried" for "matched this objective".
      if (!spend({
        source: "profile",
        id: f.key,
        summary: `${PROFILE_FIELDS[f.key].label}: ${f.value}`,
        score: 1,
        method: "profile",
        at: f.at,
      })) break;
    }

    scored.sort((a, b) => b.score - a.score || b.at - a.at);
    for (const f of scored) {
      // A row with nothing behind it but age is dropped rather than padding the
      // card: "here is a memory, for no reason" is worse than a shorter list.
      if (f.method === "recent" && f.score < W_RECENCY * 0.5) continue;
      if (!spend(f)) break;
    }

    return { ...base, facts, considered: candidates.size + (this.deps.profile?.count() ?? 0) };
  }
}
/** How long a citation may be on the retrieval card. It is a pointer, not the row. */
const MAX_CITATION = 200;

/**
 * The retrieval result as the mission layer wants it.
 *
 * Deliberately not typed as `MissionMemoryRef`: this file does not import the
 * mission layer, so memory stays a leaf and the dependency runs one way. The shape
 * is structurally the same, and the runtime — which knows about both — is where the
 * two meet.
 */
export function toMemoryRefs(
  facts: readonly RetrievedFact[],
): readonly {
  readonly source: FactSource;
  readonly summary: string;
  readonly method: FactMethod;
}[] {
  return facts.map((f) => ({
    source: f.source,
    method: f.method,
    summary:
      f.summary.length > MAX_CITATION ? `${f.summary.slice(0, MAX_CITATION - 1)}…` : f.summary,
  }));
}
