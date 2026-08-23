/**
 * Things the user asked Jarvis to remember.
 *
 * Jarvis keeps its own store rather than writing Hermes' memory files, and that
 * is a deliberate boundary rather than a convenience. Three reasons, in order of
 * weight:
 *
 * 1. **Hermes owns its format.** `%LOCALAPPDATA%\hermes\memories\MEMORY.md` is
 *    `§`-delimited, written under an `msvcrt` lock on a sibling `.lock` file,
 *    evicted against per-store character limits, and threat-scanned on every
 *    write by `tools/threat_patterns.first_threat_message`. Reimplementing that
 *    in Node would make Jarvis responsible for not corrupting a file that
 *    already holds the user's real notes — in a format Hermes may change in any
 *    update, with a bug that would be silent and durable.
 * 2. **Latency.** Hermes has no REST route that writes a memory; writes happen
 *    only inside an agent turn, measured at ~16 s to first token on this
 *    machine. Writing something down should not cost a conversation.
 * 3. **The offline guarantee.** Phase 4 established that the local layer is
 *    consulted *before* the Hermes availability check, so the promise does not
 *    depend on the thing it exists to be independent of. Memory holds to that.
 *
 * Teaching Hermes something durable is a separate, explicit act — "tell Hermes
 * to remember X" reaches the agent, and Hermes' own memory tool does that write.
 * `hermes-memory.ts` reads those files and has no write path at all.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { redactSecrets } from "../context/window-facts.js";

export interface MemoryEntry {
  /** Stable within a store, so `forget` can name one unambiguously. */
  id: string;
  text: string;
  /** Epoch ms, from the injected clock. */
  at: number;
  /**
   * When the text was last changed, if it ever was.
   *
   * Separate from `at` rather than replacing it: `at` is when the user first said
   * this, which is what recency in `memory/retrieval.ts` is a proxy for, and
   * correcting a typo in a memory from March should not make it look like a thing
   * said today. The edit is still recorded, because a store that showed no sign of
   * having been edited would be a store a person could not audit.
   */
  editedAt?: number;
}

/**
 * Where the store lives: beside `config.json`, not inside Hermes' directory.
 *
 * Same resolution as `configFilePath()` in `context/config.ts`. Kept separate
 * from the config file because config is hand-edited and this is not.
 */
export function memoryFilePath(): string {
  const base =
    process.env.LOCALAPPDATA ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "Jarvis", "memory.json");
}

/**
 * Caps. Bounded for the same reason Hermes' store is bounded: an unbounded
 * memory becomes an unbounded prompt, and the cost is paid on every turn.
 *
 * Generous against how fast a person dictates memories, and small enough that
 * the whole store can be fenced into a prompt without dominating it.
 */
export const MAX_ENTRIES = 200;
export const MAX_TOTAL_CHARS = 20_000;
export const MAX_ENTRY_CHARS = 600;

/** A refusal, or the text cleared for storage. */
export type Screening = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Decide whether a memory may be stored at all.
 *
 * A credential-shaped memory is **refused, not redacted**. Storing
 * `my key is [redacted]` would leave something that looks like a memory and
 * reads back as useless, and the user would believe the secret was saved. §53
 * says never store them; the honest outcome is to decline and say which shape
 * was seen, so the user can decide what to do instead.
 *
 * `redactSecrets` is reused rather than reimplemented: its `SECRET_PATTERNS` and
 * `ENTROPY_RUN` already carry the tuning that stops an ordinary long hyphenated
 * string being mistaken for a key. This function only needs its verdict, not its
 * output.
 */
export function screenMemory(raw: string): Screening {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return { ok: false, reason: "there was nothing to remember" };
  if (text.length > MAX_ENTRY_CHARS) {
    return {
      ok: false,
      reason: `that is ${text.length} characters and the limit is ${MAX_ENTRY_CHARS}`,
    };
  }
  if (redactSecrets(text).redacted) {
    return {
      ok: false,
      reason:
        "that looks like it contains a password, key or token, so I did not save it — " +
        "keep credentials in a password manager instead",
    };
  }
  return { ok: true, text };
}

export interface RememberResult {
  ok: boolean;
  /** What Jarvis should say. Already user-facing. */
  speech: string;
  entry?: MemoryEntry;
  /** Entries dropped to make room. Reported, never silent. */
  evicted?: readonly MemoryEntry[];
}

export interface StoreOptions {
  path?: string;
  /** Injected so tests are not tied to the wall clock. */
  now?(): number;
  /** Where a malformed file is reported. Never thrown. */
  onError?(msg: string): void;
}

/**
 * The store: read-once, write-on-rename, forgiving on the way in.
 *
 * Design mirrors `loadConfig` in `context/config.ts`, for the same reasons: a
 * missing file is the normal first run, and a malformed one must not stop Jarvis
 * coming up — it yields an empty store and a log line instead. Unlike config,
 * writes go through a temp file + `rename` so a crash mid-write cannot leave a
 * torn file: rename is atomic on the same volume.
 *
 * Single-writer by construction: only the runtime drives local intents. No lock
 * is needed, and claiming one would be theatre.
 */
/**
 * Words that carry no meaning in a recall query.
 *
 * Without this, "what do you remember about the tax return" scores a point
 * against every memory containing "the" — which is most of them. That is merely
 * noisy for `recall`, and dangerous for `forget`: a spurious single hit is a
 * deletion of the wrong memory, and a spurious set of hits turns a clear request
 * into a question. Short tokens are dropped for the same reason.
 *
 * Exported because `EpisodicStore.search` scores the same way, and two subtly
 * different stopword lists would be two things to reason about when a retrieval
 * result looks wrong.
 */
export const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "was", "are", "were", "be", "been",
  "to", "of", "in", "on", "at", "for", "with", "that", "this", "it", "its",
  "my", "me", "i", "you", "your", "about", "as", "by", "from", "has", "have",
]);

export class MemoryStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly onError: (msg: string) => void;
  private entries: MemoryEntry[];

  constructor(opts: StoreOptions = {}) {
    this.path = opts.path ?? memoryFilePath();
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError ?? (() => {});
    this.entries = this.read();
    // Ids have to stay unique *across restarts*, not just within a process. A
    // fresh counter would hand out `m1` again to a store that already holds one,
    // and `forget` matches the first id it finds — so the wrong memory would be
    // deleted, silently, and only ever after a restart.
    reserveIds(this.entries);
  }

  /** Current entries, oldest first. The array is copied; callers cannot mutate the store through it. */
  entriesList(): readonly MemoryEntry[] {
    return this.entries.slice();
  }

  remember(text: string): RememberResult {
    const screening = screenMemory(text);
    if (!screening.ok) return { ok: false, speech: screening.reason };

    const entry: MemoryEntry = { id: nextId(), text: screening.text, at: this.now() };
    const evicted = this.evictToFit(entry);
    this.entries.push(entry);
    this.write();

    const howMany = this.entries.length;
    const speech =
      evicted.length > 0
        ? `Saved, and let go of ${evicted.length} older one${evicted.length === 1 ? "" : "s"} to make room.`
        : `Remembered — I have ${howMany} thing${howMany === 1 ? "" : "s"} saved now.`;
    return { ok: true, speech, entry, evicted };
  }

  /**
   * Substring + word overlap. No embedding model: this is the local fast path,
   * and the fallback for a miss is an agent that can ask.
   *
   * Stopwords are dropped before scoring, and a query that is *only* stopwords
   * matches nothing rather than everything — "what was it about the" should
   * come back empty, not return the whole store.
   */
  recall(query: string): readonly MemoryEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));

    const scored = this.entries.map((e) => {
      const hay = e.text.toLowerCase();
      let score = 0;
      // The whole phrase still counts, stopwords and all: someone who quotes a
      // memory back verbatim means that one.
      if (hay.includes(q)) score += 3;
      for (const t of terms) if (hay.includes(t)) score += 1;
      return { e, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.e);
  }

  /**
   * Replace the text of one memory, keeping its id and its original timestamp.
   *
   * Screened by `screenMemory` exactly as a new memory is, and for the stronger
   * reason: an edit is the one path that could put text into an *existing* row, so a
   * store that screened `remember` and trusted `revise` would have a door beside the
   * one it locked. The caps are re-checked too — text may only grow into headroom
   * that exists, and it grows without evicting anything, because dropping someone
   * else's memory to make room for an edit is not something a user asked for.
   */
  revise(id: string, text: string): RememberResult {
    const at = this.entries.findIndex((e) => e.id === id);
    if (at === -1) return { ok: false, speech: "there is no memory with that id" };
    const screening = screenMemory(text);
    if (!screening.ok) return { ok: false, speech: screening.reason };
    const existing = this.entries[at]!;
    if (screening.text === existing.text) {
      return { ok: true, speech: "that is what it already says", entry: existing };
    }
    const room = MAX_TOTAL_CHARS - (this.totalChars() - existing.text.length);
    if (screening.text.length > room) {
      return {
        ok: false,
        speech: `that would not fit — there is room for ${room} characters in the store`,
      };
    }
    const entry: MemoryEntry = {
      ...existing,
      text: screening.text,
      editedAt: this.now(),
    };
    this.entries[at] = entry;
    this.write();
    return { ok: true, speech: "Updated.", entry };
  }

  forget(id: string): MemoryEntry | null {
    const at = this.entries.findIndex((e) => e.id === id);
    if (at === -1) return null;
    const removed = this.entries.splice(at, 1)[0] ?? null;
    this.write();
    return removed;
  }

  /**
   * Drop everything, returning how many went.
   *
   * The "forget it all" path, and it is not reachable by one click: the request that
   * gets here carries a literal confirmation phrase the runtime checks
   * (`ipc/contract.ts`), because this is the one irreversible bulk delete in the
   * memory subsystem and there is no Recycle Bin behind a JSON row.
   */
  clear(): number {
    const gone = this.entries.length;
    if (gone === 0) return 0;
    this.entries = [];
    this.write();
    return gone;
  }

  /** Drop oldest entries until the caps hold, returning what went. */
  private evictToFit(incoming: MemoryEntry): readonly MemoryEntry[] {
    const dropped: MemoryEntry[] = [];
    while (
      this.entries.length >= MAX_ENTRIES ||
      this.totalChars() + incoming.text.length > MAX_TOTAL_CHARS
    ) {
      if (this.entries.length === 0) break;
      dropped.push(this.entries.shift()!);
    }
    return dropped;
  }

  private totalChars(): number {
    return this.entries.reduce((sum, e) => sum + e.text.length, 0);
  }

  private read(): MemoryEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
      return parsed.flatMap((raw) => {
        if (typeof raw !== "object" || raw === null) return [];
        const o = raw as Record<string, unknown>;
        if (typeof o.text !== "string" || typeof o.id !== "string") return [];
        const text = o.text.trim().replace(/\s+/g, " ");
        if (!text) return [];
        return [
          {
            id: o.id,
            text,
            at: typeof o.at === "number" ? o.at : 0,
            ...(typeof o.editedAt === "number" ? { editedAt: o.editedAt } : {}),
          },
        ];
      });
    } catch (err) {
      // Corrupt is an empty store, never a crash. The file stays on disk for a
      // human to look at; overwriting it silently would destroy the only copy
      // of whatever was in there.
      this.onError(`ignoring unreadable memory store at ${this.path}: ${err}`);
      return [];
    }
  }

  private write(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2), "utf8");
    renameSync(tmp, this.path);
  }
}

let counter = 0;
/**
 * Ids, unique across every store this process opens *and* across restarts.
 *
 * `m<base36>` off a counter that every loaded store pushes past its own highest
 * id. Not a random id: these are read back to a person ("that's memory m3"), so
 * short and pronounceable beats globally unique, and `reserveIds` gives the same
 * guarantee within the only scope that matters.
 */
function nextId(): string {
  counter += 1;
  return `m${counter.toString(36)}`;
}

/** Push the counter past everything already stored, so a reload cannot re-issue an id. */
function reserveIds(entries: readonly MemoryEntry[]): void {
  for (const e of entries) {
    const m = /^m([0-9a-z]+)$/.exec(e.id);
    if (!m) continue;
    const n = parseInt(m[1]!, 36);
    if (Number.isFinite(n) && n > counter) counter = n;
  }
}
