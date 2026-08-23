/**
 * The provider for a Jarvis with no model configured, which is most of them.
 *
 * It refuses. That is the whole implementation, and it is the point: the plausible
 * alternative — a stand-in that produces plan-shaped text so the pipeline "works"
 * offline — is precisely what §43 forbids. A mission that ran steps a stub invented
 * would show a user real consent dialogs for real commands chosen by nothing.
 *
 * So `available` is false, `simulated` is true, and `complete` throws every time.
 * The callers in `src/missions` are written around that: `LlmPlanner` falls back to
 * `DeterministicPlanner`, which is a real planner with real rules, and the mission
 * says `planner: "deterministic"` on the wire. Nothing pretends.
 *
 * `simulated: true` on something that never answers may read oddly. It is the
 * honest value: the flag means "a capability behind this is mocked or absent", and
 * absent is the case here. It is also what makes a UI that surfaces the flag say
 * *no model* rather than saying nothing.
 */
import { LLMUnavailableError, type LLMProvider, type LLMResult, type ProviderHealth } from "./provider.js";

export class OfflineProvider implements LLMProvider {
  readonly name = "offline";
  readonly model = "none";
  readonly simulated = true;
  readonly available = false;
  /** There is no model here at all, so there is certainly not one that can see. */
  readonly acceptsImages = false;

  /** Why there is no model, in the user's terms. Display-safe, never a key. */
  private readonly reason: string;

  constructor(reason = "no model is configured") {
    this.reason = reason;
  }

  async complete(): Promise<LLMResult> {
    // Not retryable: nothing about waiting changes an unconfigured provider.
    throw new LLMUnavailableError(this.reason);
  }

  health(): ProviderHealth {
    return {
      name: this.name,
      model: this.model,
      available: false,
      simulated: true,
      acceptsImages: false,
      note: this.reason,
    };
  }
}
