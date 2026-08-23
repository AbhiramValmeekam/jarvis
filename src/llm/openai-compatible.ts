/**
 * Any server that speaks the OpenAI chat-completions shape.
 *
 * Which is most of them: llama.cpp, LM Studio, Ollama's compatibility endpoint, vLLM,
 * OpenRouter, and the paid API itself. One adapter covers all of it because the only
 * things this layer needs — one prompt in, one string out, token counts, a reason it
 * stopped — sit in the same fields everywhere.
 *
 * Two things differ from `anthropic-provider.ts` and both are deliberate:
 *
 *  - **The key is optional.** A local llama.cpp on `127.0.0.1:8080` wants no
 *    `Authorization` header and rejecting a blank key would lock out the one setup a
 *    user can run with no account at all. Absent key means the header is omitted, not
 *    sent empty.
 *  - **`finish_reason` is translated, not passed through.** The wire word for a
 *    truncated answer is `length` here and `max_tokens` on Anthropic. `LLMResult`
 *    says a caller must check that field before trusting `text`, and a caller that
 *    had to know both vocabularies would eventually check only one. So this file
 *    normalises to the Anthropic spelling and says so.
 *
 * `simulated` is false: a real model answered. Whether it is a *good* model is not
 * something this layer claims either way — that is what `planner: "llm"` plus a
 * validated step graph is for.
 */
import { postJson } from "./http.js";
import {
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  LLMUnavailableError,
  redactSecrets,
  refuseImage,
  type LLMProvider,
  type LLMRequest,
  type LLMResult,
  type ProviderHealth,
} from "./provider.js";

/** Where a local server usually listens, and what `llmBaseUrl` defaults to. */
export const DEFAULT_OPENAI_BASE_URL = "http://127.0.0.1:8080/v1";

export interface OpenAiCompatibleOptions {
  /** Including the version segment: `http://127.0.0.1:8080/v1`. */
  readonly baseUrl?: string;
  /** Omitted from the request entirely when absent or blank. */
  readonly apiKey?: string;
  readonly model?: string;
  /**
   * Whether the endpoint behind `baseUrl` can read an image. Defaults to false.
   *
   * There is no way to find out by asking: a text-only server answers the same
   * `/v1/models` as a multimodal one. So this is the deployment stating a fact about
   * its own server, and the provider reports exactly what it was told.
   */
  readonly acceptsImages?: boolean;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
}

/**
 * `finish_reason` in the vocabulary the rest of the codebase checks.
 *
 * Unknown values pass through unchanged rather than becoming `"unknown"`: a server
 * that invented its own reason has said something, and flattening it would lose the
 * one clue in a log line about why a plan came back empty.
 */
function normaliseFinish(reason: unknown): string {
  if (typeof reason !== "string" || reason === "") return "unknown";
  if (reason === "length") return "max_tokens";
  if (reason === "stop") return "end_turn";
  if (reason === "content_filter") return "refusal";
  return reason;
}

interface ContentPart {
  readonly type?: unknown;
  readonly text?: unknown;
}

/**
 * The assistant's text.
 *
 * `content` is a string on nearly every server and an array of parts on a few, and a
 * couple of reasoning models put their thinking in a sibling `reasoning_content` field
 * — which is not read here, both because it is not the answer and because §51 says a
 * hidden chain of thought is not ours to surface.
 */
function textOf(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0] as { message?: { content?: unknown } } | null;
  const content = first?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content as readonly ContentPart[]) {
      if (part !== null && typeof part === "object" && typeof part.text === "string") parts.push(part.text);
    }
    return parts.join("");
  }
  return "";
}

function finishOf(payload: unknown): string {
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "unknown";
  return normaliseFinish((choices[0] as { finish_reason?: unknown } | null)?.finish_reason);
}

function usageOf(payload: unknown): { inputTokens: number; outputTokens: number } {
  const usage = (payload as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object") return { inputTokens: 0, outputTokens: 0 };
  const input = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  const output = (usage as { completion_tokens?: unknown }).completion_tokens;
  return {
    inputTokens: typeof input === "number" && Number.isFinite(input) ? input : 0,
    outputTokens: typeof output === "number" && Number.isFinite(output) ? output : 0,
  };
}

/**
 * The user message, as a bare string or as blocks when there is a picture.
 *
 * `image_url` with a data URL is the chat-completions vocabulary for an image, and it
 * is what llama.cpp's server, LM Studio, vLLM and OpenRouter all implement — the
 * newer `input_image` block belongs to the Responses API, which is not the shape this
 * adapter speaks. The text form is kept for requests with no image so that adding
 * vision changes nothing about the calls that were already working.
 */
function contentFor(req: LLMRequest): unknown {
  if (!req.image) return req.prompt;
  return [
    {
      type: "image_url",
      image_url: { url: `data:${req.image.mimeType};base64,${req.image.data}` },
    },
    { type: "text", text: req.prompt },
  ];
}

export class OpenAiCompatibleProvider implements LLMProvider {
  readonly name = "openai-compatible";
  readonly model: string;
  readonly simulated = false;
  readonly available = true;
  /**
   * Declared, not guessed.
   *
   * This one adapter covers a local text-only llama.cpp and a vision model on
   * OpenRouter, and nothing on the wire distinguishes them until a request fails. So
   * the answer comes from configuration (`llmVision`) and defaults to false: a false
   * here costs a user with a vision endpoint one config line, while a true would spend
   * a screen-capture consent prompt on a model that was always going to 400. Asking
   * for the user's screen and then discovering nothing could read it is the more
   * expensive mistake, because the screenshot was already taken.
   */
  readonly acceptsImages: boolean;

  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly log: ((line: string) => void) | undefined;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: OpenAiCompatibleOptions = {}) {
    const base = (options.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
    this.url = `${base}/chat/completions`;
    this.apiKey = options.apiKey?.trim() ?? "";
    // A local server serves whatever it was started with and ignores this, but it is
    // still sent: a gateway in front of several models needs to be told which one.
    this.model = options.model?.trim() || "local-model";
    this.acceptsImages = options.acceptsImages === true;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    this.log = options.log;
    this.fetchImpl = options.fetchImpl;
  }

  async complete(req: LLMRequest): Promise<LLMResult> {
    const started = Date.now();
    const messages: Array<{ role: string; content: unknown }> = [];
    if (req.system !== undefined && req.system.trim() !== "") {
      messages.push({ role: "system", content: req.system });
    }
    if (req.image && !this.acceptsImages) refuseImage(this.name, this.model);
    messages.push({ role: "user", content: contentFor(req) });

    const headers: Record<string, string> = {};
    if (this.apiKey !== "") headers.authorization = `Bearer ${this.apiKey}`;

    const payload = await postJson({
      url: this.url,
      headers,
      body: {
        model: this.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages,
        stream: false,
      },
      timeoutMs: req.timeoutMs ?? this.timeoutMs,
      // Empty strings are filtered by `redactSecrets`'s length check, so passing the
      // key unconditionally is safe when there isn't one.
      secrets: [this.apiKey],
      log: this.log,
      fetchImpl: this.fetchImpl,
    });

    const stopReason = finishOf(payload);
    const text = textOf(payload);
    if (stopReason === "refusal") {
      throw new LLMUnavailableError("the model declined to answer this request");
    }
    if (text.trim() === "") {
      throw new LLMUnavailableError(
        redactSecrets(`the model returned no text (stop reason: ${stopReason})`, [this.apiKey]),
      );
    }

    return {
      text,
      provider: this.name,
      model: (() => {
        const served = (payload as { model?: unknown }).model;
        return typeof served === "string" && served !== "" ? served : this.model;
      })(),
      simulated: false,
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
      acceptsImages: this.acceptsImages,
      note: `configured for ${this.url}${this.apiKey === "" ? " (no key)" : ""}`
        + (this.acceptsImages ? ", declared image-capable" : ""),
    };
  }
}
