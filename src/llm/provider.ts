/**
 * The seam a model plugs into, and the four things it has to admit about itself.
 *
 * Phase 13's mission layer plans and recovers from tables in this repository. That
 * is a working path and it stays the default, so this file's job is not to replace
 * it but to make a model an *option* — which means the mission layer must be able
 * to ask three questions of whatever is behind this interface before it trusts a
 * word of it: is there a model at all, is it real, and what did it cost. Hence
 * `available`, `simulated` and `usage`.
 *
 * What is deliberately absent:
 *
 *  - **No `temperature`, `top_p` or `top_k`.** Not a simplification. Those
 *    parameters were removed on Claude Opus 5, Fable 5, Sonnet 5 and Opus 4.7/4.8,
 *    and sending one now returns a 400 — so a provider-independent request shape
 *    that carried a sampling knob would either fail on the newest models or need
 *    per-model stripping. A planner has no use for one either: the thing we want
 *    from a plan is that it is the same plan twice.
 *  - **No streaming.** A plan is one small JSON object, and nothing may act on it
 *    until the whole graph has been validated against the registry. Streaming would
 *    buy latency a mission cannot spend.
 *  - **No conversation.** One request, one answer, no history. Missions are
 *    stateful; the model calls inside them are not, which stops one bad answer from
 *    shaping the next.
 *
 * Everything that comes out of here is untrusted text (§52). Nothing in this file
 * interprets it — it hands it back, and the callers in `src/missions` validate it
 * against the tool registry before any of it can become a step.
 */

/**
 * One image a prompt is about, already captured and already consented to.
 *
 * Base64 rather than a path, for two reasons that are both about honesty rather than
 * convenience. The provider that reads it is on the far side of a network call, where
 * a path means nothing. And a path would invite the transport to re-read the file at
 * send time — a second read of something the user allowed once, which is precisely
 * what the per-capture consent in `context/screen-capture.ts` is built to prevent.
 *
 * The two types are the two every provider here accepts. A screenshot arrives as PNG
 * and stays PNG; nothing in this repository re-encodes an image, so nothing has to
 * decide what quality loss is acceptable on a picture of the user's screen.
 */
export interface LLMImage {
  /** Base64, with no data-URL prefix. Each transport adds the wrapper it needs. */
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg";
}

/** One completion request. Deliberately small; see the note above on sampling. */
export interface LLMRequest {
  readonly prompt: string;
  /** Instructions that are not the task. Sent as the provider's system field. */
  readonly system?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  /**
   * One image the prompt is asking about.
   *
   * A provider whose `acceptsImages` is false must throw when this is set rather than
   * send the prompt without it. The alternative — dropping the image and answering
   * anyway — produces a confident description of a screenshot the model never saw,
   * which is the §43 failure with a picture attached. `LLMUnavailableError` is the
   * right shape for that refusal: there is no model here that can do this.
   */
  readonly image?: LLMImage;
}

export interface LLMUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LLMResult {
  /** The model's text, concatenated across blocks. Untrusted. */
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  /** True when a mock or absent capability produced this (§43). */
  readonly simulated: boolean;
  /**
   * Why generation stopped, as the provider spelled it.
   *
   * Load-bearing rather than diagnostic: `max_tokens` means the JSON is cut off
   * and `refusal` means there is no answer, and a caller that read `text` without
   * checking would treat both as a plan.
   */
  readonly stopReason: string;
  readonly usage: LLMUsage;
  readonly ms: number;
}

/** What the UI and `get_status` may know about the model. Never a key. */
export interface ProviderHealth {
  readonly name: string;
  readonly model: string;
  readonly available: boolean;
  readonly simulated: boolean;
  /** Whether this model can be shown a picture. Reported, never assumed. */
  readonly acceptsImages: boolean;
  /** One display-safe line. Says how it was configured, never with what. */
  readonly note: string;
}

export interface LLMProvider {
  /** Short, stable, and shown on the wire: `anthropic`, `openai-compatible`, … */
  readonly name: string;
  readonly model: string;
  readonly simulated: boolean;
  /** False means `complete` will throw `LLMUnavailableError`, every time. */
  readonly available: boolean;
  /**
   * Whether `complete` can be given an `image`.
   *
   * Required rather than optional, and false rather than absent on the providers that
   * cannot see, because a caller has to be able to ask before it spends a consent
   * prompt on a capture. `local-intents/executors.ts` already established that order
   * for the agent: check that something can read an image, *then* ask the user for
   * one. A missing field would make "cannot see" and "did not say" the same answer.
   */
  readonly acceptsImages: boolean;
  complete(req: LLMRequest): Promise<LLMResult>;
  health(): ProviderHealth;
}

/**
 * The one error type callers switch on.
 *
 * `retryable` is the provider's reading of its own failure — 429 and 5xx yes, 400
 * and 401 no — and it exists so the planner can decide between falling back to the
 * deterministic path and trying once more, without parsing anyone's message text.
 */
export class LLMUnavailableError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(message: string, options: { retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = "LLMUnavailableError";
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

/**
 * The one sentence a provider says when it is handed a picture it cannot read.
 *
 * Shared so all four providers refuse in the same words, because this sentence is
 * display-safe and reaches the user: a vision objective that cannot run should read
 * the same whether the configured model is Hermes, a text-only endpoint or nothing at
 * all. `retryable` is false — no amount of trying again gives a model eyes.
 */
export function refuseImage(provider: string, model: string): never {
  throw new LLMUnavailableError(
    `${provider} cannot be shown an image, and ${model} was asked to read one`,
    { retryable: false },
  );
}

/**
 * Non-streaming default, and it is not small by accident.
 *
 * Adaptive thinking spends the same output budget the answer does, so a ceiling
 * chosen for the size of a plan (a few hundred tokens of JSON) would truncate the
 * plan on any model that thought first. A cut-off plan is worse than no plan: it
 * parses as far as it goes and then names half a step.
 */
export const DEFAULT_MAX_TOKENS = 16_000;

/** A model call is a network round trip, not a build. */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/**
 * The first JSON object in a model's answer, or null.
 *
 * Models fence their JSON, preface it, and occasionally apologise after it. This
 * scans for the first balanced `{…}` outside a string rather than regex-matching,
 * because a plan's own strings contain braces — a title like `Build {the app}` would
 * end a greedy match in the wrong place.
 *
 * Returning null is a real answer and callers treat it as one: a model that did not
 * produce JSON has not produced a plan, and inventing one from its prose is exactly
 * the failure §43 names.
 */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Remove anything secret-shaped from text that is about to be logged or shown.
 *
 * Providers echo request context into error messages, and a proxy in front of one
 * may echo more than that. This is the last gate before a key could reach the log
 * file, the wire or a permission dialog, so it runs over every provider error —
 * belt and braces over never having put the key in the message in the first place.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    while (out.includes(secret)) out = out.replace(secret, "[redacted]");
  }
  // Key shapes, for the ones we were never given and so cannot match literally.
  return out
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[redacted]");
}
