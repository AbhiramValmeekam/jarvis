/**
 * A real embedding model, when there is one — and an honest answer when there is not.
 *
 * `memory/vector-index.ts` ships a local lexical embedder that needs nothing and
 * claims nothing. This is the upgrade path: an OpenAI-compatible `/v1/embeddings`
 * endpoint, which is what llama.cpp, LM Studio, Ollama and vLLM all expose, and
 * which is therefore reachable on the same machine with no key and no network.
 *
 * Two things are deliberately absent.
 *
 * **No Anthropic adapter.** The Messages API has no embeddings route. A provider
 * here that took an `ANTHROPIC_API_KEY` and quietly used the lexical embedder would
 * be exactly the fake capability §43 forbids, so a user with only that key is told
 * they have no embedding model and gets the lexical one *labelled as such*.
 *
 * **No batching beyond one request.** The index syncs a few hundred short rows at
 * most, and every server here accepts an array of inputs. A chunker would be code
 * with no caller.
 */
import { postJson } from "./http.js";
import { LLMUnavailableError } from "./provider.js";
import type { Embedder } from "../memory/vector-index.js";
import { createLexicalEmbedder } from "../memory/vector-index.js";

/** The variable that turns this on. The same one the completion layer reads. */
export const EMBED_ENV_KEYS = {
  baseUrl: "OPENAI_BASE_URL",
  key: "OPENAI_API_KEY",
  model: "JARVIS_EMBED_MODEL",
} as const;

/**
 * A default that exists locally rather than one that only exists behind a key.
 *
 * `nomic-embed-text-v1.5` is what Ollama and LM Studio ship as their standard
 * embedding model, so this is the name most likely to work against a server the user
 * already has running. A hosted default would name a model an unkeyed request cannot
 * reach, and the failure would arrive as a 401 that looks like a bug.
 */
export const DEFAULT_EMBED_MODEL = "nomic-embed-text-v1.5";

/** One round trip per sync; a local model on CPU is slower than a chat token stream. */
const DEFAULT_EMBED_TIMEOUT_MS = 30_000;
export interface EmbedderOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly dims?: number;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
}

export interface EmbedderChoice {
  readonly embedder: Embedder;
  /** One display-safe line: which embedder, and how it was configured. Never a key. */
  readonly reason: string;
}

/**
 * Vectors from an OpenAI-compatible server.
 *
 * `dims` is discovered from the first answer rather than configured, because every
 * model has its own width and a mismatch is not something a user should have to know.
 * The index keys its file on `name` *and* `dims`, so a model swap rebuilds rather
 * than mixing two feature spaces — see `VectorIndex.read`.
 */
class HttpEmbedder implements Embedder {
  readonly name: string;
  readonly semantic = true;
  private width: number;
  private readonly options: EmbedderOptions;

  constructor(options: EmbedderOptions, dims: number) {
    this.options = options;
    this.name = `openai:${options.model ?? DEFAULT_EMBED_MODEL}`;
    this.width = dims;
  }

  get dims(): number {
    return this.width;
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];
    const key = this.options.apiKey ?? "";
    const payload = await postJson({
      url: `${this.options.baseUrl.replace(/\/+$/, "")}/embeddings`,
      headers: {
        "content-type": "application/json",
        ...(key === "" ? {} : { authorization: `Bearer ${key}` }),
      },
      body: { model: this.options.model ?? DEFAULT_EMBED_MODEL, input: texts },
      timeoutMs: this.options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS,
      secrets: key === "" ? [] : [key],
      attempts: 2,
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    });
    return this.readVectors(payload, texts.length);
  }
  /**
   * `{data: [{index, embedding: number[]}]}`, read defensively.
   *
   * `index` is honoured rather than assumed: the field exists because the spec does
   * not promise order, and a server that returned them shuffled would otherwise
   * silently pair every row with someone else's meaning — a bug that produces
   * plausible-looking search results and no error anywhere.
   */
  private readVectors(payload: unknown, expected: number): readonly (readonly number[])[] {
    const data = (payload as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      throw new LLMUnavailableError("the embeddings response had no data array");
    }
    const out = new Array<readonly number[] | undefined>(expected).fill(undefined);
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (typeof row !== "object" || row === null) continue;
      const o = row as { index?: unknown; embedding?: unknown };
      const at = typeof o.index === "number" && Number.isInteger(o.index) ? o.index : i;
      if (at < 0 || at >= expected) continue;
      if (!Array.isArray(o.embedding) || o.embedding.length === 0) continue;
      const v: number[] = [];
      for (const x of o.embedding) {
        if (typeof x !== "number" || !Number.isFinite(x)) return this.fail("a non-numeric component");
        v.push(x);
      }
      out[at] = normaliseVector(v);
    }
    const first = out.find((v) => v !== undefined);
    if (!first) return this.fail("no usable vectors");
    // Width is whatever the model actually returned. Set once, then enforced: a
    // server that changes width mid-run is returning vectors from two models.
    if (this.width === 0) this.width = first.length;
    for (const v of out) {
      if (v !== undefined && v.length !== this.width) return this.fail("vectors of differing widths");
    }
    return out.map((v) => v ?? []);
  }

  private fail(what: string): never {
    throw new LLMUnavailableError(`the embeddings response contained ${what}`);
  }
}

/** L2-normalise, so `cosine` is a dot product for these too. */
function normaliseVector(v: readonly number[]): readonly number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  if (sum === 0) return v;
  const scale = 1 / Math.sqrt(sum);
  return v.map((x) => x * scale);
}
export interface CreateEmbedderDeps {
  /** From `loadEnv`: the process environment plus `.env` for anything it did not set. */
  readonly env: Readonly<Record<string, string>>;
  /** `false` forces the lexical embedder even with a server configured. */
  readonly allowRemote?: boolean;
  readonly log?: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Pick an embedder, and say which one out loud.
 *
 * The rule is one line: an OpenAI-compatible base URL means a real model, anything
 * else means the local lexical one. There is no probing round trip at startup — an
 * embedder that cannot be reached fails at `sync`, where `VectorIndex` already
 * reports `degraded` and leaves the existing index alone, and a boot that blocked on
 * a dead port would cost the always-on process its start-up time for a subsystem
 * nothing is waiting on.
 */
export function createEmbedder(deps: CreateEmbedderDeps): EmbedderChoice {
  const baseUrl = (deps.env[EMBED_ENV_KEYS.baseUrl] ?? "").trim();
  const key = (deps.env[EMBED_ENV_KEYS.key] ?? "").trim();
  const model = (deps.env[EMBED_ENV_KEYS.model] ?? "").trim() || DEFAULT_EMBED_MODEL;

  if (deps.allowRemote === false || baseUrl === "") {
    const embedder = createLexicalEmbedder();
    return {
      embedder,
      reason:
        baseUrl === ""
          ? `local ${embedder.name} — lexical, not a model: it matches wording, not meaning ` +
            `(set ${EMBED_ENV_KEYS.baseUrl} for a real embedding model)`
          : `local ${embedder.name} — lexical, not a model, because embeddings are switched off`,
    };
  }

  return {
    embedder: new HttpEmbedder(
      {
        baseUrl,
        ...(key === "" ? {} : { apiKey: key }),
        model,
        ...(deps.log === undefined ? {} : { log: deps.log }),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      },
      0,
    ),
    reason: `${model} at ${baseUrl} — a real embedding model, width discovered on first use`,
  };
}
