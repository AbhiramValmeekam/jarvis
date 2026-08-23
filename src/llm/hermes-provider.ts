/**
 * Hermes as a model, which it is only just barely.
 *
 * Hermes is already supervised by the runtime as an ACP child, already has a session,
 * and already answers questions — so a Jarvis with no API key and a working Hermes has
 * a model available, and refusing to use it would be leaving a real capability on the
 * floor. This adapter makes it reachable through the same interface as the HTTP ones.
 *
 * Three honest caveats, all of them the reason the factory ranks this provider last:
 *
 *  1. **It is slow.** ~16 s to first token measured in Phase 9. That is survivable for
 *     one plan at the start of a mission and not survivable inside a replan loop, so
 *     `LlmReplanner` is configured with an HTTP provider or not at all.
 *  2. **It is an agent, not a completion endpoint.** It has its own tools and its own
 *     consent prompts. Asking it for a plan can in principle make it *do* things —
 *     which is why the request says to answer with JSON and nothing else, and why any
 *     tool call it makes still goes through the runtime's existing permission path
 *     rather than through the mission's. Nothing here can widen a grant.
 *  3. **It reports no token counts.** ACP's `session/prompt` returns a stop reason and
 *     no usage, so `usage` is zeros. That is stated rather than estimated: an invented
 *     token count on a cost display is exactly the kind of plausible fiction §43 is
 *     about.
 *
 * `src/llm` must not depend on `src/hermes` — the LLM layer is used by probes and tests
 * that have no business spawning an agent — so the session is injected as one function.
 * The runtime supplies it; this file never learns what is behind it.
 */
import {
  DEFAULT_LLM_TIMEOUT_MS,
  LLMUnavailableError,
  refuseImage,
  type LLMProvider,
  type LLMRequest,
  type LLMResult,
  type ProviderHealth,
} from "./provider.js";

/** What the runtime injects: one turn, collected. Mirrors `HermesAdapter.sendMessage`. */
export type HermesAsk = (prompt: string) => Promise<{ text: string; stopReason: string }>;

export interface HermesProviderOptions {
  readonly ask: HermesAsk;
  /** Whether the agent is ready *right now*. Read on every `available` check. */
  readonly ready: () => boolean;
  /** Shown on the wire as the model name; the agent's own name is fine. */
  readonly model?: string;
  readonly timeoutMs?: number;
}

export class HermesProvider implements LLMProvider {
  readonly name = "hermes";
  readonly model: string;
  /** A real model answers. Slow and side-effect-capable, but not a mock. */
  readonly simulated = false;
  /**
   * False because of this seam, not because of the agent behind it.
   *
   * That model may well read images — the runtime asks it exactly that question
   * elsewhere, for the `read screen` intent. But `HermesAsk` carries a string, and an
   * image cannot cross a string. Reporting true here and then sending the prompt
   * without the picture is the failure this flag exists to prevent.
   */
  readonly acceptsImages = false;

  private readonly ask: HermesAsk;
  private readonly ready: () => boolean;
  private readonly timeoutMs: number;

  constructor(options: HermesProviderOptions) {
    this.ask = options.ask;
    this.ready = options.ready;
    this.model = options.model?.trim() || "hermes";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  }

  /**
   * Live, not remembered.
   *
   * The other providers are configured once and stay configured; Hermes crashes, gets
   * restarted, and is unavailable in between. A cached `true` here would send a plan
   * request into a dead pipe and turn a clean fallback into a timeout.
   */
  get available(): boolean {
    return this.ready();
  }

  async complete(req: LLMRequest): Promise<LLMResult> {
    if (req.image) refuseImage(this.name, this.model);
    if (!this.ready()) {
      // Retryable: the supervisor restarts it, so a later mission may well succeed.
      throw new LLMUnavailableError("the agent is not ready", { retryable: true });
    }

    const started = Date.now();
    // One string, because ACP has no system role. The instructions go first and are
    // labelled, which is the same shape `memory-prompt.ts` uses to keep a section of a
    // prompt from being mistaken for the task.
    const prompt =
      req.system !== undefined && req.system.trim() !== ""
        ? `${req.system}\n\n---\n\n${req.prompt}`
        : req.prompt;

    let answer: { text: string; stopReason: string };
    try {
      answer = await withTimeout(this.ask(prompt), req.timeoutMs ?? this.timeoutMs);
    } catch (err) {
      if (err instanceof LLMUnavailableError) throw err;
      throw new LLMUnavailableError(
        `the agent could not answer: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true },
      );
    }

    if (answer.stopReason === "refusal") {
      throw new LLMUnavailableError("the agent declined to answer this request");
    }
    if (answer.text.trim() === "") {
      throw new LLMUnavailableError(`the agent returned no text (stop reason: ${answer.stopReason})`);
    }

    return {
      text: answer.text,
      provider: this.name,
      model: this.model,
      simulated: false,
      stopReason: answer.stopReason,
      // Not available over ACP. Zeros, and the note says so.
      usage: { inputTokens: 0, outputTokens: 0 },
      ms: Date.now() - started,
    };
  }

  health(): ProviderHealth {
    const ready = this.ready();
    return {
      name: this.name,
      model: this.model,
      available: ready,
      simulated: false,
      acceptsImages: false,
      note: ready
        ? "using the supervised agent; slow, and it reports no token counts"
        : "the supervised agent is not ready",
    };
  }
}

/**
 * A clock over a promise that has none.
 *
 * `sendMessage` resolves when the agent finishes its turn, and an agent that has
 * decided to think for ten minutes is indistinguishable from one that has wedged. The
 * turn is left running — cancelling it belongs to whoever owns the session — but this
 * call stops waiting.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new LLMUnavailableError(`the agent did not answer within ${Math.round(ms / 1000)}s`, { retryable: true })),
        ms,
      );
      timer.unref?.();
    }),
  ]);
}
