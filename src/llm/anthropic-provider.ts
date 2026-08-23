/**
 * The Anthropic Messages API, over `fetch`.
 *
 * No SDK. The plan forbids new runtime dependencies (this repository's are React and
 * React DOM, and a packaged Jarvis runs the runtime inside Electron), and one POST to
 * one endpoint does not need one. What it does need is to be right about a wire shape
 * that changed recently, so the three facts most likely to be wrong from memory are
 * fixed here in code and in comments:
 *
 *  - **No sampling parameters.** `temperature`, `top_p` and `top_k` were removed on
 *    Claude Opus 5, Fable 5 and Opus 4.8/4.7; sending one is a 400. `LLMRequest` has
 *    no field for one, so there is nothing here to forget to strip.
 *  - **No `budget_tokens`.** Extended thinking is adaptive on the current models and
 *    `budget_tokens` is a 400. Thinking is *on by default* on Opus 5, which is why
 *    `DEFAULT_MAX_TOKENS` is 16k and not the few hundred a plan's JSON needs: the
 *    thinking shares that budget, and a plan cut off mid-object is worse than none.
 *  - **A refusal is an HTTP 200.** `stop_reason: "refusal"` comes back successful with
 *    no usable content. Reading `content[0].text` without checking is how a mission
 *    ends up planning from an apology.
 *
 * The key lives in a header this file sets and nowhere else. It is never logged, never
 * put in an error, and every message out of here goes through `redactSecrets` anyway,
 * because a proxy in front of the real API may echo the request back in its own error.
 */
import { postJson } from "./http.js";
import {
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  LLMUnavailableError,
  redactSecrets,
  type LLMProvider,
  type LLMRequest,
  type LLMResult,
  type ProviderHealth,
} from "./provider.js";

/** The version header is required and pinned; it is not a model version. */
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * The default model, and the reason it is this one.
 *
 * Opus 5 is the most capable current model and a plan is a small answer to a hard
 * question — the token count is trivial next to being wrong about which step comes
 * first. A deployment that wants cheaper sets `llmModel`.
 */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** For a gateway or proxy. No trailing slash; `/v1/messages` is appended. */
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
}

interface TextBlock {
  readonly type?: unknown;
  readonly text?: unknown;
}

/**
 * The model's words, concatenated across text blocks.
 *
 * Blocks that are not text — thinking summaries, tool use — are skipped rather than
 * stringified. A thinking block is not the answer and §51 says it is not ours to show
 * either; a caller that got one concatenated into `text` would try to parse it.
 */
function textOf(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as readonly TextBlock[]) {
    if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function usageOf(payload: unknown): { inputTokens: number; outputTokens: number } {
  const usage = (payload as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object") return { inputTokens: 0, outputTokens: 0 };
  const input = (usage as { input_tokens?: unknown }).input_tokens;
  const output = (usage as { output_tokens?: unknown }).output_tokens;
  return {
    inputTokens: typeof input === "number" && Number.isFinite(input) ? input : 0,
    outputTokens: typeof output === "number" && Number.isFinite(output) ? output : 0,
  };
}

function stringField(payload: unknown, key: string, fallback: string): string {
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : fallback;
}

/**
 * The user message: a bare string, or blocks when there is a picture.
 *
 * Two shapes rather than always-blocks, because the string form is what every text
 * request in this repository has sent since Phase 14 and a wire change nobody needed
 * is a wire change nobody tested. The image goes *before* the text: Anthropic's own
 * guidance is that a question asked after the image it is about is answered better,
 * and a planner reading a screenshot is exactly that question.
 */
function contentFor(req: LLMRequest): unknown {
  if (!req.image) return req.prompt;
  return [
    {
      type: "image",
      source: { type: "base64", media_type: req.image.mimeType, data: req.image.data },
    },
    { type: "text", text: req.prompt },
  ];
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;
  /** A real model behind a real key. The one provider for which this is false. */
  readonly simulated = false;
  readonly available = true;
  /**
   * Opus 5 reads images, and so does every Claude model this provider would be
   * pointed at. Hardcoded true rather than derived from `this.model`, because a
   * table of which model names can see would be a guess about a name a deployment
   * chose — and the honest failure for a text-only Claude is the API's own 400,
   * which arrives with the model's name in it.
   */
  readonly acceptsImages = true;

  private readonly apiKey: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly log: ((line: string) => void) | undefined;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: AnthropicOptions) {
    if (options.apiKey.trim() === "") {
      // Constructing one without a key would produce a provider that reports
      // `available: true` and 401s on every call, which is the one lie this layer
      // must not tell. The factory builds an `OfflineProvider` instead.
      throw new LLMUnavailableError("an Anthropic key is required to build this provider");
    }
    this.apiKey = options.apiKey.trim();
    this.model = options.model?.trim() || DEFAULT_ANTHROPIC_MODEL;
    const base = (options.baseUrl?.trim() || ANTHROPIC_BASE_URL).replace(/\/+$/, "");
    this.url = `${base}/v1/messages`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.log = options.log;
    this.fetchImpl = options.fetchImpl;
  }

  async complete(req: LLMRequest): Promise<LLMResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: "user", content: contentFor(req) }],
    };
    // Omitted rather than sent empty: `system: ""` is a real field with no content,
    // and the API is entitled to treat that differently from its absence.
    if (req.system !== undefined && req.system.trim() !== "") body.system = req.system;

    const payload = await postJson({
      url: this.url,
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body,
      timeoutMs: req.timeoutMs ?? this.timeoutMs,
      secrets: [this.apiKey],
      log: this.log,
      fetchImpl: this.fetchImpl,
    });

    const stopReason = stringField(payload, "stop_reason", "unknown");
    const text = textOf(payload);

    // A refusal is a 200 with nothing in it. Not retryable: the same request will be
    // declined the same way, and the caller's fallback is a real planner (§43).
    if (stopReason === "refusal") {
      throw new LLMUnavailableError("the model declined to answer this request");
    }
    if (text.trim() === "") {
      throw new LLMUnavailableError(
        redactSecrets(`the model returned no text (stop reason: ${stopReason})`, [this.apiKey]),
      );
    }

    return {
      // Untrusted from here on (§52). Nothing in this file parses it.
      text,
      provider: this.name,
      model: stringField(payload, "model", this.model),
      simulated: false,
      // `max_tokens` is handed back rather than thrown on: the caller can say
      // "the plan was cut off" honestly, which is more use than a bare failure.
      stopReason,
      usage: usageOf(payload),
      ms: Date.now() - started,
    };
  }

  health(): ProviderHealth {
    return {
      name: this.name,
      model: this.model,
      available: true,
      simulated: false,
      acceptsImages: true,
      // The endpoint, never the key. `describeSecret` is what answers "is a key set".
      note: `configured for ${this.url}`,
    };
  }
}
