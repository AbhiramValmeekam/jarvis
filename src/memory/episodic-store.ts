/**
 * What happened — as distinct from what is true.
 *
 * The Phase 8 store holds facts the user asked Jarvis to keep. This holds
 * *episodes*: a mission ran, here is what it was for, here is how it ended, here
 * is what it used. Two stores rather than one because the two answer different
 * questions and mixing them degrades both. "The portal deploys from the release
 * branch" is durable and belongs in a prompt. "On Tuesday a mission checking the
 * portal failed because the lockfile was stale" is a fact about the past that is
 * useful for exactly one thing — planning the next attempt — and would be noise in
 * every unrelated turn.
 *
 * Nothing here is written by a model and nothing here is a decision. An episode is
 * assembled from a finished mission's own record, which is why the fields are
 * counts and names rather than prose: a summary written by a planner would be a
 * claim about a mission rather than an observation of one, and §43 is the whole
 * reason this project keeps those apart.
 *
 * **The text is untrusted.** A mission's objective came from the user, but its step
 * titles and errors quote program output, and program output is where an injection
 * arrives (§52). So every string is flattened and marker-defused on the way in, and
 * anything credential-shaped is redacted — redacted, not refused, unlike a memory:
 * an episode is a record that an event occurred, and losing the record because one
 * word in it looked like a token would lose the event too.
 */
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { defuseMarkers, sanitiseForDisplay } from "../permissions/risk-model.js";
import { redactSecrets } from "../context/window-facts.js";
import { memoryDir } from "./vector-index.js";
import { STOPWORDS } from "./memory-store.js";

/** What kind of thing happened. Deliberately few: each one has a writer. */
export type EpisodeKind = "mission" | "note";

export interface Episode {
  readonly id: string;
  readonly at: number;
  readonly kind: EpisodeKind;
  /** What it was about, in one line. Flattened and capped. */
  readonly title: string;
  /** How it ended, in the vocabulary of the thing that ended: `completed`, `failed`… */
  readonly outcome: string;
  readonly detail?: string;
  readonly tools?: readonly string[];
  readonly missionId?: string;
  readonly durationMs?: number;
  /** True when something credential-shaped was removed on the way in. */
  readonly redacted?: boolean;
}
/** What a caller hands in. Ids and timestamps are the store's to assign. */
export interface EpisodeInput {
  readonly kind: EpisodeKind;
  readonly title: string;
  readonly outcome: string;
  readonly detail?: string;
  readonly tools?: readonly string[];
  readonly missionId?: string;
  readonly durationMs?: number;
  /** Overridden only by tests and by a replay of something already timestamped. */
  readonly at?: number;
}

export function episodeFilePath(): string {
  return join(memoryDir(), "episodes.json");
}

/**
 * Caps. An episode is written by machinery rather than by a person, so this store
 * fills on its own — which makes the ceiling load-bearing rather than defensive.
 *
 * 300 missions is months of real use and about 120 KB of JSON. The text caps are
 * tighter than a memory's: an episode is read as a row in a list, and a paragraph
 * of build output pasted into `detail` would be unreadable there and would drown
 * the retrieval layer that also reads it.
 */
export const MAX_EPISODES = 300;
const MAX_TITLE = 200;
const MAX_DETAIL = 400;
const MAX_TOOLS = 12;

/** Flatten, defuse, redact — in that order, and the order is the point. */
function clean(raw: string, max: number): { text: string; redacted: boolean } {
  // Redaction first, before any character is removed: a token split by a
  // zero-width character would otherwise slip past the patterns and then be
  // reassembled by the flattening. `toWindowFacts` establishes the same order.
  const { text, redacted } = redactSecrets(raw);
  return { text: defuseMarkers(sanitiseForDisplay(text, max)), redacted };
}

/** A tool name is an identifier, so anything that is not one is dropped whole. */
function cleanTools(tools: readonly string[] | undefined): readonly string[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  const ok = tools.filter((t) => /^[a-z][a-z0-9_.]{0,40}$/.test(t)).slice(0, MAX_TOOLS);
  return ok.length > 0 ? ok : undefined;
}
export interface EpisodicStoreOptions {
  path?: string;
  now?(): number;
  onError?(msg: string): void;
}

/**
 * The store. Newest-last on disk, newest-first out of every reader.
 *
 * On disk it is oldest-first so eviction is a `shift` and the file reads
 * chronologically to a human opening it. Every accessor reverses that, because a
 * list of what happened is read from the top.
 */
export class EpisodicStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly onError: (msg: string) => void;
  private episodes: Episode[];

  constructor(opts: EpisodicStoreOptions = {}) {
    this.path = opts.path ?? episodeFilePath();
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError ?? (() => {});
    this.episodes = this.read();
    reserveEpisodeIds(this.episodes);
  }

  /** Newest first. Copied, so a caller cannot reach into the store. */
  list(): readonly Episode[] {
    return this.episodes.slice().reverse();
  }

  recent(limit: number): readonly Episode[] {
    return this.list().slice(0, Math.max(0, limit));
  }

  count(): number {
    return this.episodes.length;
  }

  record(input: EpisodeInput): Episode {
    const title = clean(input.title, MAX_TITLE);
    const detail = input.detail === undefined ? undefined : clean(input.detail, MAX_DETAIL);
    const outcome = sanitiseForDisplay(input.outcome, 40);
    const episode: Episode = {
      id: nextEpisodeId(),
      at: input.at ?? this.now(),
      kind: input.kind,
      title: title.text || "(untitled)",
      outcome: outcome || "unknown",
      ...(detail && detail.text ? { detail: detail.text } : {}),
      ...(cleanTools(input.tools) ? { tools: cleanTools(input.tools) } : {}),
      ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
      ...(typeof input.durationMs === "number" && input.durationMs >= 0
        ? { durationMs: Math.round(input.durationMs) }
        : {}),
      ...(title.redacted || detail?.redacted ? { redacted: true } : {}),
    };
    this.episodes.push(episode);
    while (this.episodes.length > MAX_EPISODES) this.episodes.shift();
    this.write();
    return episode;
  }
  /**
   * Keyword search over title, outcome and detail. Newest first among equals.
   *
   * Deliberately the same shape of match as `MemoryStore.recall` rather than
   * something cleverer: the vector index above is where similarity happens, and
   * two subtly different keyword scorers would be two things to reason about when
   * a retrieval result looks wrong. That includes the stopword list, which is
   * imported rather than repeated — without it "act as the user" scores a point
   * against every episode whose title contains "the", which is most of them.
   */
  search(query: string): readonly Episode[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
    const scored = this.list().map((e, index) => {
      const hay = `${e.title} ${e.outcome} ${e.detail ?? ""} ${(e.tools ?? []).join(" ")}`.toLowerCase();
      let score = 0;
      if (hay.includes(q)) score += 3;
      for (const t of terms) if (hay.includes(t)) score += 1;
      return { e, score, index };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((s) => s.e);
  }

  forget(id: string): Episode | null {
    const at = this.episodes.findIndex((e) => e.id === id);
    if (at === -1) return null;
    const removed = this.episodes.splice(at, 1)[0] ?? null;
    this.write();
    return removed;
  }

  clear(): number {
    const gone = this.episodes.length;
    if (gone === 0) return 0;
    this.episodes = [];
    this.write();
    return gone;
  }

  private read(): Episode[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
      return parsed.flatMap((raw) => parseEpisode(raw));
    } catch (err) {
      // Corrupt is an empty store and a log line, never a crash — and the file
      // stays where it is, because it is the only copy of whatever it holds.
      this.onError(`ignoring unreadable episode store at ${this.path}: ${err}`);
      return [];
    }
  }

  private write(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.episodes, null, 2), "utf8");
    renameSync(tmp, this.path);
  }
}
/**
 * A row off disk, re-cleaned.
 *
 * The file was written by this store, but it is a plain JSON file in a directory a
 * person can open — so it is treated as input rather than as something already
 * screened. Re-cleaning costs a pass over a few hundred short strings at boot and
 * closes the hand-edit path into the prompt.
 */
function parseEpisode(raw: unknown): Episode[] {
  if (typeof raw !== "object" || raw === null) return [];
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.title !== "string") return [];
  const kind: EpisodeKind = o.kind === "note" ? "note" : "mission";
  const title = clean(o.title, MAX_TITLE);
  if (!title.text) return [];
  const detail = typeof o.detail === "string" ? clean(o.detail, MAX_DETAIL) : undefined;
  const tools = Array.isArray(o.tools)
    ? cleanTools(o.tools.filter((t): t is string => typeof t === "string"))
    : undefined;
  return [
    {
      id: o.id,
      at: typeof o.at === "number" ? o.at : 0,
      kind,
      title: title.text,
      outcome: typeof o.outcome === "string" ? sanitiseForDisplay(o.outcome, 40) : "unknown",
      ...(detail && detail.text ? { detail: detail.text } : {}),
      ...(tools ? { tools } : {}),
      ...(typeof o.missionId === "string" ? { missionId: o.missionId } : {}),
      ...(typeof o.durationMs === "number" && o.durationMs >= 0
        ? { durationMs: o.durationMs }
        : {}),
      ...(o.redacted === true || title.redacted || detail?.redacted ? { redacted: true } : {}),
    },
  ];
}

let episodeCounter = 0;

/** `e<base36>`, unique across restarts for the same reason memory ids are. */
function nextEpisodeId(): string {
  episodeCounter += 1;
  return `e${episodeCounter.toString(36)}`;
}

function reserveEpisodeIds(episodes: readonly Episode[]): void {
  for (const e of episodes) {
    const m = /^e([0-9a-z]+)$/.exec(e.id);
    if (!m) continue;
    const n = parseInt(m[1]!, 36);
    if (Number.isFinite(n) && n > episodeCounter) episodeCounter = n;
  }
}
