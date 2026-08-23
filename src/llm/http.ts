/**
 * One HTTP POST, shared by the providers that speak to a real API.
 *
 * `fetch` is a global in Node 22, so this is the whole HTTP client — no dependency,
 * which is the constraint, and no wrapper worth the name either. What it does add is
 * the four things both providers would otherwise each get slightly wrong:
 *
 *  1. **A timeout that actually fires.** `AbortSignal.timeout` on the request *and*
 *     on reading the body: a response whose headers arrive and whose body never
 *     finishes is the hang an always-on process cannot afford.
 *  2. **Retryable read from the status, not from the message.** 429 and 5xx are
 *     worth another attempt; 400 and 401 will fail identically forever. Callers
 *     decide what to do with that (`LlmPlanner` falls back rather than waiting),
 *     which is only possible because the classification is a field and not prose.
 *  3. **`retry-after` honoured, and capped.** A provider asking for five minutes is
 *     asking for longer than a mission has, so the wait is bounded and the attempt
 *     abandoned rather than slept through.
 *  4. **Redaction on every path out.** The key is in a header this file sets, so
 *     this file is where an error message gets scrubbed before anyone logs it.
 */
import { LLMUnavailableError, redactSecrets } from "./provider.js";

export interface PostJsonOptions {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly timeoutMs: number;
  /** Literal values to scrub from anything thrown or returned. */
  readonly secrets: readonly string[];
  /** Total attempts, counting the first. 1 disables retrying. */
  readonly attempts?: number;
  readonly log?: (line: string) => void;
  /** Injected by tests and probes; defaults to the global. */
  readonly fetchImpl?: typeof fetch;
}

/** Longest a `retry-after` may make us wait before we give up instead. */
const MAX_RETRY_WAIT_MS = 5_000;

function retryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * The provider's own error text, if it sent one in the shape both APIs use.
 *
 * Anthropic returns `{error: {type, message}}` and OpenAI-compatible servers return
 * `{error: {message}}` or `{error: "…"}`. Anything else falls back to the status,
 * because a proxy's HTML error page is not a message and should not be shown as one.
 */
function providerMessage(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return null;
}

export async function postJson(options: PostJsonOptions): Promise<unknown> {
  const attempts = Math.max(1, options.attempts ?? 2);
  const doFetch = options.fetchImpl ?? fetch;
  let last: LLMUnavailableError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response;
    try {
      response = await doFetch(options.url, {
        method: "POST",
        headers: { ...options.headers, "content-type": "application/json" },
        body: JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (err) {
      // No response at all: DNS, refused connection, or our own abort. All three
      // are worth one more try, and none of them can be told apart usefully here.
      const why = err instanceof Error ? err.message : String(err);
      last = new LLMUnavailableError(
        redactSecrets(`could not reach the model: ${why}`, options.secrets),
        { retryable: true },
      );
      if (attempt < attempts) continue;
      throw last;
    }

    const text = await readBody(response, options.timeoutMs, options.secrets);
    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }

    if (response.ok) {
      if (payload === null) {
        throw new LLMUnavailableError(
          redactSecrets(`the model returned ${response.status} with a body that is not JSON`, options.secrets),
        );
      }
      return payload;
    }

    const detail = providerMessage(payload) ?? `HTTP ${response.status}`;
    last = new LLMUnavailableError(
      redactSecrets(`the model refused the request: ${detail}`, options.secrets),
      { retryable: retryable(response.status), status: response.status },
    );
    if (!last.retryable || attempt >= attempts) throw last;

    const wait = retryAfterMs(response.headers.get("retry-after"));
    if (wait > MAX_RETRY_WAIT_MS) {
      options.log?.(`the model asked for a ${Math.round(wait / 1000)}s wait, which is longer than this call has`);
      throw last;
    }
    options.log?.(`model returned ${response.status}; retrying once in ${wait}ms`);
    await sleep(wait);
  }

  throw last ?? new LLMUnavailableError("the model produced no response and no error");
}

/**
 * Read the body under its own clock.
 *
 * `AbortSignal.timeout` on the request covers time-to-headers; a body that stops
 * arriving mid-stream is a separate hang, and this is the second half of point 1.
 */
async function readBody(response: Response, timeoutMs: number, secrets: readonly string[]): Promise<string> {
  try {
    return await Promise.race([
      response.text(),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new LLMUnavailableError("the model stopped sending mid-response", { retryable: true })),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    if (err instanceof LLMUnavailableError) throw err;
    throw new LLMUnavailableError(
      redactSecrets(`could not read the model's response: ${err instanceof Error ? err.message : String(err)}`, secrets),
      { retryable: true },
    );
  }
}

/** `retry-after` in seconds, or a short default when the header is absent. */
function retryAfterMs(header: string | null): number {
  if (header === null) return 500;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  return 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
