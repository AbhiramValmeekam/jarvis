/**
 * The vector index: cosine over a JSON sidecar, with no model required.
 *
 * Three properties carry the design and each has a test here. The lexical embedder
 * is **deterministic**, which is the only reason vectors can be cached on disk at
 * all. It is **not semantic**, and says so, because a page that called a word hash
 * semantic search would describe software the user does not have (§43). And the
 * sidecar **never holds the text** — only an id and a hash — so a deleted memory
 * cannot survive in here and an edited one is detected as changed rather than
 * answering with its old meaning.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEXICAL_DIMS,
  MAX_INDEX_ROWS,
  VectorIndex,
  cosine,
  createLexicalEmbedder,
  textHash,
  type Embeddable,
  type Embedder,
} from "../src/memory/vector-index.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-vectors-"));
  path = join(dir, "vectors.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function index(opts: { embedder?: Embedder; onError?(m: string): void } = {}): VectorIndex {
  return new VectorIndex({ path, ...opts });
}

function row(id: string, text: string, at = 1000): Embeddable {
  return { id, text, at };
}

describe("the lexical embedder", () => {
  it("is deterministic, unit-length and the width it claims", async () => {
    const e = createLexicalEmbedder();
    const [a] = await e.embed(["the portal deploys from the release branch"]);
    const [b] = await e.embed(["the portal deploys from the release branch"]);
    expect(a).toHaveLength(LEXICAL_DIMS);
    expect(a).toEqual(b);
    // Same text in, same vector out — on any machine, after any restart. Without
    // this the cache on disk would be worthless.
    expect(cosine(a!, b!)).toBeCloseTo(1, 3);
  });

  it("says it is not semantic, and is not a stand-in either", () => {
    const e = createLexicalEmbedder();
    // Real arithmetic over real features, so not `simulated`. What it is not is a
    // model, and `semantic: false` is how everything downstream knows to say so.
    expect(e.semantic).toBe(false);
    expect(e.simulated).toBeUndefined();
    expect(e.name).toContain("lexical");
  });

  it("generalises over word endings and a typo, which is why it beats includes()", async () => {
    const e = createLexicalEmbedder();
    const [base, ending, typo, unrelated] = await e.embed([
      "the portal deploys from the release branch",
      "portal deploy release branches",
      "the portal deploy from the relaese branch",
      "feed the cat twice a day",
    ]);
    expect(cosine(base!, ending!)).toBeGreaterThan(cosine(base!, unrelated!));
    expect(cosine(base!, typo!)).toBeGreaterThan(cosine(base!, unrelated!));
  });

  it("does not pretend to know that two different words mean the same thing", async () => {
    const e = createLexicalEmbedder();
    const [portal, website] = await e.embed(["the portal", "the website"]);
    // The honest limit of a word hash, asserted so nobody later reads the label
    // "similarity" as more than it is.
    expect(cosine(portal!, website!)).toBeLessThan(0.6);
  });

  it("returns an all-zero vector for text with no features rather than throwing", async () => {
    const [v] = await createLexicalEmbedder().embed(["!!! ??? ***"]);
    expect(v).toHaveLength(LEXICAL_DIMS);
    expect(v!.every((x) => x === 0)).toBe(true);
  });
});

describe("cosine", () => {
  it("is 0 for mismatched widths instead of reading off the end", () => {
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });

  it("is clamped, so a self-comparison never prints as 100.4%", () => {
    expect(cosine([1, 0], [1, 0])).toBeLessThanOrEqual(1);
    expect(cosine([-1, 0], [1, 0])).toBeGreaterThanOrEqual(-1);
  });
});

describe("sync", () => {
  it("embeds what is new, reports the counts, and writes the file", async () => {
    const i = index();
    const report = await i.sync([row("m1", "the portal deploys from release"), row("m2", "feed the cat")]);
    expect(report.added).toBe(2);
    expect(report.updated).toBe(0);
    expect(report.removed).toBe(0);
    expect(report.total).toBe(2);
    expect(report.semantic).toBe(false);
    expect(i.size()).toBe(2);
  });

  it("re-embeds only what changed", async () => {
    let calls = 0;
    const embedder: Embedder = {
      ...createLexicalEmbedder(),
      async embed(texts) {
        calls += texts.length;
        return createLexicalEmbedder().embed(texts);
      },
    };
    const i = index({ embedder });
    await i.sync([row("m1", "one"), row("m2", "two")]);
    expect(calls).toBe(2);
    const second = await i.sync([row("m1", "one"), row("m2", "two changed")]);
    expect(calls).toBe(3);
    expect(second.updated).toBe(1);
    expect(second.added).toBe(0);
  });

  it("drops a row whose source row is gone", async () => {
    const i = index();
    await i.sync([row("m1", "one"), row("m2", "two")]);
    const report = await i.sync([row("m1", "one")]);
    expect(report.removed).toBe(1);
    expect(i.size()).toBe(1);
    // A memory deleted from the store cannot survive in the sidecar. The file is
    // the check, because that is what a restart reads.
    expect(readFileSync(path, "utf8")).not.toContain('"m2"');
  });

  it("never holds the text, only an id and a hash of it", async () => {
    const i = index();
    await i.sync([row("m1", "the staging box is at 10.0.0.7")]);
    const body = readFileSync(path, "utf8");
    expect(body).not.toContain("staging");
    expect(body).not.toContain("10.0.0.7");
    expect(body).toContain(textHash("the staging box is at 10.0.0.7"));
  });

  it("ignores an item with no text rather than indexing an empty vector", async () => {
    const report = await index().sync([row("m1", "   ")]);
    expect(report.total).toBe(0);
  });

  it("leaves the index exactly as it was when the embedder throws, and says so", async () => {
    const good = createLexicalEmbedder();
    const i = index();
    await i.sync([row("m1", "the portal deploys from release")]);

    const broken: Embedder = {
      name: good.name,
      dims: good.dims,
      semantic: false,
      async embed() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      },
    };
    const logged: string[] = [];
    const after = new VectorIndex({ path, embedder: broken, onError: (m) => logged.push(m) });
    const report = await after.sync([row("m1", "the portal deploys from release"), row("m2", "new")]);
    // Degraded, not empty. An empty index would silently turn retrieval back into
    // keyword-only at the moment the user could least tell why.
    expect(report.degraded).toBe(true);
    expect(report.reason).toMatch(/ECONNREFUSED/);
    expect(after.size()).toBe(1);
    expect(logged.join(" ")).toMatch(/embedding failed, index left as it was/);
  });

  it("skips a vector of the wrong width rather than pairing it with a neighbour's", async () => {
    const short: Embedder = {
      name: "lexical-hash-256",
      dims: LEXICAL_DIMS,
      semantic: false,
      async embed(texts) {
        return texts.map((t, n) =>
          n === 0 ? new Array<number>(4).fill(0.5) : new Array<number>(LEXICAL_DIMS).fill(0),
        );
      },
    };
    const report = await index({ embedder: short }).sync([row("a", "one"), row("b", "two")]);
    expect(report.added).toBe(1);
  });

  it("evicts the oldest at the row cap", async () => {
    const i = index();
    const items = Array.from({ length: MAX_INDEX_ROWS + 3 }, (_, n) =>
      row(`m${n}`, `memory number ${n}`, n + 1),
    );
    await i.sync(items);
    expect(i.size()).toBe(MAX_INDEX_ROWS);
    const hits = await i.search("memory number 0");
    expect(hits.some((h) => h.id === "m0")).toBe(false);
  });

  it("does not rewrite the file when nothing changed", async () => {
    const i = index();
    await i.sync([row("m1", "one")]);
    const before = readFileSync(path, "utf8");
    await i.sync([row("m1", "one")]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("search", () => {
  it("finds a memory that shares no whole word with the query", async () => {
    // The failure that motivated the whole file: `recall("deployment")` scores zero
    // against a memory saying "deploys", so it never reaches the plan.
    const i = index();
    await i.sync([
      row("m1", "the portal deploys from the release branch"),
      row("m2", "feed the cat twice a day"),
    ]);
    const hits = await i.search("portal deployment");
    expect(hits[0]?.id).toBe("m1");
  });

  it("honours the limit and returns best first", async () => {
    const i = index();
    await i.sync([
      row("m1", "the release branch"),
      row("m2", "the release branch of the portal"),
      row("m3", "unrelated entirely"),
    ]);
    const hits = await i.search("release branch", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("answers an empty query and an empty index with nothing, not an error", async () => {
    const i = index();
    expect(await i.search("anything")).toEqual([]);
    await i.sync([row("m1", "one")]);
    expect(await i.search("   ")).toEqual([]);
  });

  it("returns nothing when embedding the query fails", async () => {
    const flaky: Embedder = {
      name: "lexical-hash-256",
      dims: LEXICAL_DIMS,
      semantic: false,
      embed: (() => {
        let first = true;
        return async (texts: readonly string[]) => {
          if (first) {
            first = false;
            return createLexicalEmbedder().embed(texts);
          }
          throw new Error("gone");
        };
      })(),
    };
    const logged: string[] = [];
    const i = index({ embedder: flaky, onError: (m) => logged.push(m) });
    await i.sync([row("m1", "one")]);
    expect(await i.search("one")).toEqual([]);
    expect(logged.join(" ")).toMatch(/embedding the query failed/);
  });
});

describe("the file", () => {
  it("is reusable across a restart without re-embedding", async () => {
    const first = index();
    await first.sync([row("m1", "the portal deploys from the release branch")]);
    const second = index();
    expect(second.size()).toBe(1);
    const hits = await second.search("portal deployment");
    expect(hits[0]?.id).toBe("m1");
  });

  it("describes itself honestly, including how many rows it holds", async () => {
    const i = index();
    await i.sync([row("m1", "one"), row("m2", "two")]);
    expect(i.describe()).toEqual({
      embedder: `lexical-hash-${LEXICAL_DIMS}`,
      dims: LEXICAL_DIMS,
      semantic: false,
      rows: 2,
    });
  });

  it("discards an index written by a different embedder rather than merging it", async () => {
    const first = index();
    await first.sync([row("m1", "one")]);

    const other: Embedder = { ...createLexicalEmbedder(), name: "text-embedding-3-small" };
    const logged: string[] = [];
    const second = new VectorIndex({ path, embedder: other, onError: (m) => logged.push(m) });
    // Cosine between vectors from two different feature spaces is a meaningless
    // number that would still sort, which is the worst kind of wrong.
    expect(second.size()).toBe(0);
    expect(logged.join(" ")).toMatch(/rebuilding for text-embedding-3-small/);
  });

  it("adopts a cached width when the embedder did not know its own", async () => {
    // A hosted model's width is a property of the model, so `dims: 0` means "ask me
    // later". A cached file settles it without a round trip, which is what lets a
    // restart search immediately instead of only after the next sync.
    const lazy = (dims: number): Embedder => ({
      name: "hosted-model",
      dims,
      semantic: true,
      async embed(texts) {
        return texts.map(() => {
          const v = new Array<number>(8).fill(0);
          v[0] = 1;
          return v;
        });
      },
    });
    const first = new VectorIndex({ path, embedder: lazy(0) });
    await first.sync([row("m1", "one")]);
    expect(first.describe().dims).toBe(8);

    const second = new VectorIndex({ path, embedder: lazy(0) });
    expect(second.describe().dims).toBe(8);
    expect(second.size()).toBe(1);
    expect(second.describe().semantic).toBe(true);
  });

  it("treats a corrupt file as an empty index, logs it, and leaves it on disk", () => {
    writeFileSync(path, "[ not an object", "utf8");
    const logged: string[] = [];
    expect(index({ onError: (m) => logged.push(m) }).size()).toBe(0);
    expect(logged.join(" ")).toMatch(/unreadable vector index/);
    expect(readFileSync(path, "utf8")).toBe("[ not an object");
  });

  it("drops a row whose vector is the wrong width or not numbers", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        embedder: `lexical-hash-${LEXICAL_DIMS}`,
        dims: LEXICAL_DIMS,
        semantic: false,
        rows: [
          { id: "ok", at: 1, hash: "h", v: new Array<number>(LEXICAL_DIMS).fill(0) },
          { id: "short", at: 2, hash: "h", v: [1, 2, 3] },
          {
            id: "nan",
            at: 3,
            hash: "h",
            v: [...new Array<number>(LEXICAL_DIMS - 1).fill(0), "x"],
          },
          { id: "noHash", at: 4, v: new Array<number>(LEXICAL_DIMS).fill(0) },
        ],
      }),
      "utf8",
    );
    expect(index().size()).toBe(1);
  });

  it("clear empties the file and is a no-op the second time", async () => {
    const i = index();
    await i.sync([row("m1", "one")]);
    i.clear();
    expect(i.size()).toBe(0);
    i.clear();
    expect(index().size()).toBe(0);
  });
});
