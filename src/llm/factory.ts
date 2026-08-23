/**
 * Choosing a provider, and refusing to pretend there is one.
 *
 * Every branch here ends in a provider *and* a display-safe reason, because "why is
 * Jarvis planning deterministically?" is a question a user will ask and the answer is
 * always one of a handful of specific things: no key, a key for a provider that was not
 * selected, an agent that has not come up yet, or a deliberate `offline`.
 *
 * Three rules:
 *
 *  - **`available: true` is a promise.** A provider is only built when the thing it
 *    needs is actually present. That is why `auto` will not reach for the
 *    OpenAI-compatible adapter on the strength of its default `127.0.0.1:8080` — a
 *    provider pointed at a server nobody started would report itself available and
 *    fail every mission, which is worse than a planner that says it is deterministic.
 *  - **A misconfiguration is a reason, not an exception.** `config.ts` drops bad input
 *    and comes up; so does this. An explicit `llmProvider: "anthropic"` with no key
 *    produces an `OfflineProvider` whose note says exactly that.
 *  - **Keys come from the environment, never from config.** `config.json` sits in
 *    `%APPDATA%` beside files the UI can be pointed at; `.env` and the process
 *    environment are where a secret belongs. Nothing in this file returns a key, and
 *    the reason strings are built from `describeSecret`, which counts characters.
 */
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic-provider.js";
import { describeSecret, type EnvMap } from "./env.js";
import { HermesProvider, type HermesAsk } from "./hermes-provider.js";
import { OfflineProvider } from "./offline.js";
import { OpenAiCompatibleProvider, DEFAULT_OPENAI_BASE_URL } from "./openai-compatible.js";
import { LLMUnavailableError, type LLMProvider } from "./provider.js";

/** What `config.json` may ask for. `auto` is the default and picks by what is present. */
export type LlmProviderName = "auto" | "anthropic" | "openai-compatible" | "hermes" | "offline";

export const LLM_PROVIDER_NAMES: readonly LlmProviderName[] = [
  "auto",
  "anthropic",
  "openai-compatible",
  "hermes",
  "offline",
];

/** The subset of `JarvisConfig` this layer reads. Kept narrow so tests need no config. */
export interface LlmSettings {
  readonly provider?: LlmProviderName;
  readonly model?: string;
  readonly baseUrl?: string;
  /** Passed only to the OpenAI-compatible adapter; see `llmVision` in `config.ts`. */
  readonly vision?: boolean;
  readonly timeoutMs?: number;
}

export interface CreateProviderDeps {
  readonly settings?: LlmSettings;
  /** From `loadEnv`: the process environment plus `.env` for anything it did not set. */
  readonly env: EnvMap;
  /** Present only when the runtime has a supervised agent to offer. */
  readonly hermes?: { readonly ask: HermesAsk; readonly ready: () => boolean };
  readonly log?: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
}

export interface ProviderChoice {
  readonly provider: LLMProvider;
  /** One line, display-safe, always present. Says how, never with what. */
  readonly reason: string;
}

/** The variables read, in one place so the `.env.example` can be checked against it. */
export const ENV_KEYS = {
  anthropicKey: "ANTHROPIC_API_KEY",
  anthropicBaseUrl: "ANTHROPIC_BASE_URL",
  openaiKey: "OPENAI_API_KEY",
  openaiBaseUrl: "OPENAI_BASE_URL",
  provider: "JARVIS_LLM_PROVIDER",
  model: "JARVIS_LLM_MODEL",
} as const;

function trimmed(value: string | undefined): string {
  return value === undefined ? "" : value.trim();
}

/**
 * The provider name to honour.
 *
 * Config wins, because it is the deliberate setting a user edited. The environment gets
 * a say only when config is silent — which is how a probe selects a provider without
 * writing to the user's real `config.json`.
 */
function requestedName(deps: CreateProviderDeps): LlmProviderName {
  const fromConfig = deps.settings?.provider;
  if (fromConfig !== undefined) return fromConfig;
  const fromEnv = trimmed(deps.env[ENV_KEYS.provider]).toLowerCase();
  const match = LLM_PROVIDER_NAMES.find((name) => name === fromEnv);
  return match ?? "auto";
}

function anthropic(deps: CreateProviderDeps, key: string): ProviderChoice {
  const model = trimmed(deps.settings?.model) || trimmed(deps.env[ENV_KEYS.model]) || DEFAULT_ANTHROPIC_MODEL;
  const baseUrl = trimmed(deps.settings?.baseUrl) || trimmed(deps.env[ENV_KEYS.anthropicBaseUrl]);
  const options = {
    apiKey: key,
    model,
    ...(baseUrl === "" ? {} : { baseUrl }),
    ...(deps.settings?.timeoutMs === undefined ? {} : { timeoutMs: deps.settings.timeoutMs }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };
  return {
    provider: new AnthropicProvider(options),
    reason: `Anthropic ${model}; ${ENV_KEYS.anthropicKey} ${describeSecret(key)}`,
  };
}

function openAi(deps: CreateProviderDeps, key: string, baseUrl: string): ProviderChoice {
  const model = trimmed(deps.settings?.model) || trimmed(deps.env[ENV_KEYS.model]);
  const options = {
    ...(baseUrl === "" ? {} : { baseUrl }),
    ...(key === "" ? {} : { apiKey: key }),
    ...(model === "" ? {} : { model }),
    ...(deps.settings?.vision === true ? { acceptsImages: true } : {}),
    ...(deps.settings?.timeoutMs === undefined ? {} : { timeoutMs: deps.settings.timeoutMs }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };
  const where = baseUrl === "" ? DEFAULT_OPENAI_BASE_URL : baseUrl;
  return {
    provider: new OpenAiCompatibleProvider(options),
    // A base URL is a host the user typed, not a secret, and naming it is the whole
    // difference between "why is this failing" and "I pointed it at the wrong port".
    reason: `OpenAI-compatible server at ${where}; ${ENV_KEYS.openaiKey} ${describeSecret(key === "" ? undefined : key)}`,
  };
}

function hermes(deps: CreateProviderDeps): ProviderChoice | null {
  if (deps.hermes === undefined) return null;
  return {
    provider: new HermesProvider({
      ask: deps.hermes.ask,
      ready: deps.hermes.ready,
      ...(deps.settings?.timeoutMs === undefined ? {} : { timeoutMs: deps.settings.timeoutMs }),
    }),
    reason: "the supervised agent, which is slower than an API and reports no token counts",
  };
}

function offline(reason: string): ProviderChoice {
  return { provider: new OfflineProvider(reason), reason };
}

export function createProvider(deps: CreateProviderDeps): ProviderChoice {
  const name = requestedName(deps);
  const anthropicKey = trimmed(deps.env[ENV_KEYS.anthropicKey]);
  const openaiKey = trimmed(deps.env[ENV_KEYS.openaiKey]);
  const openaiBaseUrl = trimmed(deps.settings?.baseUrl) || trimmed(deps.env[ENV_KEYS.openaiBaseUrl]);

  try {
    switch (name) {
      case "offline":
        return offline("no model, by configuration");

      case "anthropic":
        if (anthropicKey === "") {
          return offline(`llmProvider is "anthropic" but ${ENV_KEYS.anthropicKey} is not set`);
        }
        return anthropic(deps, anthropicKey);

      case "openai-compatible":
        // Explicitly chosen, so the default local URL is a legitimate answer: someone
        // who set this has a server. `auto` gets no such benefit of the doubt.
        return openAi(deps, openaiKey, openaiBaseUrl);

      case "hermes": {
        const chosen = hermes(deps);
        return chosen ?? offline('llmProvider is "hermes" but no agent was offered to this runtime');
      }

      case "auto":
      default: {
        if (anthropicKey !== "") return anthropic(deps, anthropicKey);
        if (openaiKey !== "" || openaiBaseUrl !== "") return openAi(deps, openaiKey, openaiBaseUrl);
        const chosen = hermes(deps);
        if (chosen !== null && chosen.provider.available) return chosen;
        return offline(
          `no model configured (${ENV_KEYS.anthropicKey} ${describeSecret(deps.env[ENV_KEYS.anthropicKey])}, ` +
            `${ENV_KEYS.openaiKey} ${describeSecret(deps.env[ENV_KEYS.openaiKey])})`,
        );
      }
    }
  } catch (err) {
    // A provider constructor rejected its own configuration. Same posture as a bad
    // config clause: come up without it and say why, rather than failing to boot.
    const why = err instanceof LLMUnavailableError || err instanceof Error ? err.message : String(err);
    return offline(`the configured model could not be prepared: ${why}`);
  }
}
