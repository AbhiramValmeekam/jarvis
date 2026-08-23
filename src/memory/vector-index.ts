/**
 * Similarity search over what Jarvis remembers — in this process, out of a JSON
 * file, with no model required and no native dependency.
 *
 * Phase 8's `recall()` is a keyword match, and it fails in the one direction that
 * matters for an autonomous mission: "get the portal ready" does not contain the
 * word "deploy", so a memory saying *the portal deploys from the release branch*
 * scores zero and never reaches the plan. This file is the second opinion.
 *
 * Three constraints shaped it, and each one closed off the obvious answer:
 *
 *  1. **No native module.** A packaged build runs the runtime *inside* Electron
 *     (`desktop/launch.ts`), so anything with a `.node` binary would need an ABI
 *     rebuild per Electron bump. So: plain arrays, cosine in a `for` loop. At the
 *     store's 200-entry cap that is 200 dot products of 256 floats — microseconds,
 *     and measurably cheaper than the JSON parse that loaded them.
 *  2. **It has to work with no model configured.** An index that only exists when
 *     an embeddings endpoint is reachable would make retrieval quality depend on a
 *     key, which §32 does not allow. So the default embedder is *lexical* and
 *     local, and a real one is an upgrade rather than a prerequisite.
 *  3. **It must not claim to be something it is not (§43).** A hashed lexical
 *     vector is not a semantic embedding. It generalises over word forms, order
 *     and typos, and it does *not* know that "portal" and "website" are related.
 *     So `Embedder` carries `semantic`, the index records which embedder wrote it,
 *     and the retriever labels every hit with the method that found it. Nothing
 *     here is allowed to be described as "semantic search" on a screen.
 *
 * The file is a **sidecar**: it holds vectors keyed by the id of a row in another
 * store, plus a hash of the text they were computed from. It never holds the text.
 * That means a memory deleted from `memory.json` cannot survive in here, and an
 * edited memory is detected as changed rather than answering with its old meaning.
 */
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** One thing that can be searched for: an id, its text, and when it happened. */
export interface Embeddable {
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

/**
 * Whatever turns text into vectors.
 *
 * `semantic` is the honest bit and it is not decoration: a caller that shows a
 * similarity score has to be able to say what kind of similarity it measured.
 * `simulated` stays for §43's sake — an embedder that is a stand-in says so.
 */
export interface Embedder {
  readonly name: string;
  readonly dims: number;
  /** True only for a real embedding model. The local lexical one is false. */
  readonly semantic: boolean;
  readonly simulated?: boolean;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}
/** Where the sidecar lives: beside `memory.json`, in its own directory. */
export function memoryDir(): string {
  const base =
    process.env.LOCALAPPDATA ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "Jarvis", "memory");
}

export function vectorIndexPath(): string {
  return join(memoryDir(), "vectors.json");
}

/**
 * Width of a lexical vector.
 *
 * 256 buckets against a store capped at 200 entries: collisions exist and are
 * harmless here, because a collision adds a small amount of the wrong feature to
 * a vector that is then normalised, and the scores this feeds are a *ranking*
 * rather than a threshold anyone acts on. Wider would cost file size for
 * precision no one reads.
 */
export const LEXICAL_DIMS = 256;

/** Rows kept. Above this the oldest go, so the file cannot grow without bound. */
export const MAX_INDEX_ROWS = 600;

/**
 * Decimals kept per component.
 *
 * A 256-float row at full precision is ~4 KB of JSON; at four decimals it is
 * ~1.5 KB, and the cosine of two rounded unit vectors differs from the exact one
 * far below the gap between adjacent ranks. The file is read at boot, so this is
 * paid on every start.
 */
const QUANTUM = 10_000;

/** FNV-1a, 32-bit. Used for feature buckets and for the content hash. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The stored fingerprint of a row's text, so an edit is detected as an edit. */
export function textHash(text: string): string {
  return fnv1a(text).toString(36) + ":" + text.length.toString(36);
}
/**
 * Features of one string: word unigrams, word bigrams, and character 4-grams.
 *
 * The three do different jobs and dropping any one of them is visible in the
 * ranking. Unigrams carry the topic. Bigrams keep "release branch" from matching a
 * memory that says "branch" and a memory that says "release" equally well.
 * Character 4-grams are what make this survive the way people actually type —
 * "deploys" against "deploy", "portals" against "portal", and a transposed letter
 * in a dictated word — which is the whole reason a vector beats `includes()` here.
 */
function features(text: string): readonly string[] {
  const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!norm) return [];
  const words = norm.split(" ").filter((w) => w.length > 1);
  const out: string[] = [];
  for (const w of words) out.push(`w:${w}`);
  for (let i = 1; i < words.length; i++) out.push(`b:${words[i - 1]}_${words[i]}`);
  const padded = ` ${norm} `;
  for (let i = 0; i + 4 <= padded.length; i++) out.push(`c:${padded.slice(i, i + 4)}`);
  return out;
}

/** L2-normalise in place, leaving an all-zero vector alone rather than dividing by 0. */
function normalise(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  if (sum === 0) return v;
  const scale = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i] = Math.round(v[i]! * scale * QUANTUM) / QUANTUM;
  return v;
}

/**
 * The default embedder: deterministic, local, offline, and not semantic.
 *
 * Same text in, same vector out, on any machine and after any restart — which is
 * what lets the index be cached on disk at all. It is real arithmetic over real
 * features, so it is not `simulated`; what it is not is a model, and `semantic:
 * false` is how everything downstream knows to say so.
 */
export function createLexicalEmbedder(dims = LEXICAL_DIMS): Embedder {
  return {
    name: `lexical-hash-${dims}`,
    dims,
    semantic: false,
    async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      return texts.map((text) => {
        const v = new Array<number>(dims).fill(0);
        for (const f of features(text)) {
          const h = fnv1a(f);
          const bucket = h % dims;
          // The low bit picks the sign, so unrelated features that land in the
          // same bucket cancel as often as they reinforce. Standard hashing-trick
          // practice, and it measurably reduces collision noise.
          v[bucket] = (v[bucket] ?? 0) + ((h & 1) === 0 ? 1 : -1);
        }
        return normalise(v);
      });
    },
  };
}
/** Cosine of two unit vectors: the dot product, with a length guard. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  // Rounding can push a self-comparison a hair over 1, and a score printed as
  // 100.4% would be read as a bug in the wrong place.
  return dot > 1 ? 1 : dot < -1 ? -1 : dot;
}

interface IndexRow {
  readonly id: string;
  readonly at: number;
  readonly hash: string;
  readonly v: readonly number[];
}

export interface VectorHit {
  readonly id: string;
  /** Cosine, −1…1. A ranking signal; nothing gates on an absolute value. */
  readonly score: number;
}

export interface SyncReport {
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly total: number;
  readonly embedder: string;
  readonly semantic: boolean;
  /** True when the embedder could not be reached and nothing was indexed. */
  readonly degraded?: boolean;
  readonly reason?: string;
}

export interface VectorIndexOptions {
  path?: string;
  embedder?: Embedder;
  now?(): number;
  onError?(msg: string): void;
}
/**
 * The index: rows on disk, cosine in memory.
 *
 * Reads at construction and writes only when `sync` actually changed something,
 * through temp-file + `rename` like every other store here. A file written by a
 * different embedder is **discarded rather than merged** — cosine between vectors
 * from two different feature spaces is a meaningless number that would still sort,
 * which is the worst kind of wrong.
 */
export class VectorIndex {
  private readonly path: string;
  private readonly onError: (msg: string) => void;
  private readonly embedder: Embedder;
  /**
   * The width in force, which is not always the embedder's declared one.
   *
   * A hosted embedding model's width is a property of the model, not of the code
   * calling it, so `createEmbedder` returns one that declares `dims: 0` meaning "ask
   * me later". This field is where that gets resolved: adopted from a cached index
   * whose embedder name matches, or from the first vector that comes back, and
   * enforced from then on.
   */
  private width: number;
  private rows: IndexRow[];

  constructor(opts: VectorIndexOptions = {}) {
    this.path = opts.path ?? vectorIndexPath();
    this.onError = opts.onError ?? (() => {});
    this.embedder = opts.embedder ?? createLexicalEmbedder();
    this.width = this.embedder.dims;
    this.rows = this.read();
  }

  describe(): { embedder: string; dims: number; semantic: boolean; rows: number } {
    return {
      embedder: this.embedder.name,
      dims: this.width,
      semantic: this.embedder.semantic,
      rows: this.rows.length,
    };
  }

  size(): number {
    return this.rows.length;
  }

  /**
   * Bring the index in line with a set of items, embedding only what changed.
   *
   * An embedder that throws — a local server that stopped answering — leaves the
   * index exactly as it was and reports `degraded`. The alternative, an empty
   * index, would silently turn retrieval back into keyword-only at the moment the
   * user could least tell why.
   */
  async sync(items: readonly Embeddable[]): Promise<SyncReport> {
    const wanted = new Map<string, Embeddable>();
    for (const item of items) if (item.text.trim()) wanted.set(item.id, item);

    const byId = new Map(this.rows.map((r) => [r.id, r]));
    const stale: Embeddable[] = [];
    for (const item of wanted.values()) {
      const row = byId.get(item.id);
      if (!row || row.hash !== textHash(item.text)) stale.push(item);
    }
    const removed = this.rows.filter((r) => !wanted.has(r.id)).length;
    const updated = stale.filter((s) => byId.has(s.id)).length;
    let fresh: readonly (readonly number[])[] = [];
    if (stale.length > 0) {
      try {
        fresh = await this.embedder.embed(stale.map((s) => s.text));
      } catch (err) {
        this.onError(`embedding failed, index left as it was: ${err}`);
        return {
          added: 0,
          updated: 0,
          removed: 0,
          total: this.rows.length,
          embedder: this.embedder.name,
          semantic: this.embedder.semantic,
          degraded: true,
          reason: String(err),
        };
      }
    }

    const next = new Map<string, IndexRow>();
    for (const row of this.rows) if (wanted.has(row.id)) next.set(row.id, row);
    // A width of 0 means the embedder did not know its own until now. The first
    // vector back settles it; everything after is checked against that.
    if (this.width === 0) {
      const first = fresh.find((v) => v.length > 0);
      if (first) this.width = first.length;
    }
    let added = 0;
    for (let i = 0; i < stale.length; i++) {
      const item = stale[i]!;
      const v = fresh[i];
      // A provider that returned fewer vectors than it was given texts for is a
      // provider whose answer cannot be trusted positionally, so the ones that are
      // missing are skipped rather than paired with a neighbour's vector.
      if (!v || v.length !== this.width) continue;
      if (!next.has(item.id)) added++;
      next.set(item.id, { id: item.id, at: item.at, hash: textHash(item.text), v });
    }

    const rows = [...next.values()].sort((a, b) => a.at - b.at);
    // Oldest first, so the cap drops the oldest — the same eviction rule the
    // memory store itself uses, for the same reason.
    this.rows = rows.length > MAX_INDEX_ROWS ? rows.slice(rows.length - MAX_INDEX_ROWS) : rows;
    if (added > 0 || updated > 0 || removed > 0) this.write();

    return {
      added,
      updated,
      removed,
      total: this.rows.length,
      embedder: this.embedder.name,
      semantic: this.embedder.semantic,
    };
  }
  /**
   * The closest rows to a query, best first.
   *
   * Returns `[]` for an empty index or an unembeddable query rather than throwing:
   * "nothing similar" is a legitimate answer and the retriever above still has the
   * keyword layer to fall back on.
   */
  async search(query: string, limit = 8): Promise<readonly VectorHit[]> {
    if (this.rows.length === 0 || !query.trim()) return [];
    let vector: readonly number[] | undefined;
    try {
      vector = (await this.embedder.embed([query]))[0];
    } catch (err) {
      this.onError(`embedding the query failed: ${err}`);
      return [];
    }
    if (!vector || vector.length !== this.width) return [];

    const scored = this.rows.map((r) => ({ id: r.id, score: cosine(vector, r.v) }));
    return scored
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, limit));
  }

  /** Drop everything. Used by the "forget it all" path, and by tests. */
  clear(): void {
    if (this.rows.length === 0) return;
    this.rows = [];
    this.write();
  }

  private read(): IndexRow[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected a JSON object");
      }
      const o = parsed as Record<string, unknown>;
      const cachedDims = typeof o.dims === "number" ? o.dims : 0;
      // A cached file settles an unknown width without a round trip, which is what
      // lets a restart search immediately instead of only after the next sync.
      if (o.embedder === this.embedder.name && this.width === 0 && cachedDims > 0) {
        this.width = cachedDims;
      }
      if (o.embedder !== this.embedder.name || cachedDims !== this.width) {
        // Not corruption — a configuration change. Reported at the same level
        // anyway, because a rebuild costs the next sync and a silent one would
        // look like a store that keeps forgetting.
        this.onError(
          `vector index was written by ${String(o.embedder)}; rebuilding for ${this.embedder.name}`,
        );
        return [];
      }
      if (!Array.isArray(o.rows)) throw new Error("rows must be an array");
      return o.rows.flatMap((raw) => this.parseRow(raw));
    } catch (err) {
      this.onError(`ignoring unreadable vector index at ${this.path}: ${err}`);
      return [];
    }
  }
  private parseRow(raw: unknown): IndexRow[] {
    if (typeof raw !== "object" || raw === null) return [];
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.hash !== "string") return [];
    if (!Array.isArray(o.v) || o.v.length !== this.width) return [];
    const v: number[] = [];
    for (const x of o.v) {
      if (typeof x !== "number" || !Number.isFinite(x)) return [];
      v.push(x);
    }
    return [{ id: o.id, at: typeof o.at === "number" ? o.at : 0, hash: o.hash, v }];
  }

  private write(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const body = {
      version: 1,
      embedder: this.embedder.name,
      dims: this.width,
      semantic: this.embedder.semantic,
      rows: this.rows,
    };
    const tmp = `${this.path}.tmp`;
    // No `null, 2` here, unlike the other stores: this file is vectors, not
    // something a person reads, and pretty-printing 600 rows of 256 numbers would
    // triple a file that is parsed on every boot.
    writeFileSync(tmp, JSON.stringify(body), "utf8");
    renameSync(tmp, this.path);
  }
}
