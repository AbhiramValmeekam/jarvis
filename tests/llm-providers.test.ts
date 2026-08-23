/**
 * The three adapters and the factory that picks between them.
 *
 * Two questions run through the whole file. The first is whether each adapter sends
 * the wire shape the API it names actually accepts — which for Anthropic means
 * asserting the *absence* of `temperature` and `budget_tokens`, because those are the
 * two fields a future edit is most likely to add back from memory and they are a 400
 * on every current model. The second is whether `available: true` is ever a lie: a
 * provider that reports itself ready and then 401s on every call would make a mission
 * fail for a reason the user cannot see, so the factory only builds one when the thing
 * it needs is present, and that matrix is asserted case by case.
 */
import { describe, it, expect } from "vitest";
import { fakeFetch, jsonResponse as json } from "./helpers/fake-fetch.js";
import { AnthropicProvider, ANTHROPIC_VERSION, DEFAULT_ANTHROPIC_MODEL } from "../src/llm/anthropic-provider.js";
import { OpenAiCompatibleProvider } from "../src/llm/openai-compatible.js";
import { HermesProvider } from "../src/llm/hermes-provider.js";
import { OfflineProvider } from "../src/llm/offline.js";
import { createProvider, ENV_KEYS, type LlmSettings } from "../src/llm/factory.js";
import { LLMUnavailableError } from "../src/llm/provider.js";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";

/** One Anthropic-shaped 200. */
function reply(over: Record<string, unknown> = {}): Response {
  return json(200, {
    model: "claude-opus-5-20260101",
    stop_reason: "end_turn",
    content: [{ type: "text", text: '{"steps":[]}' }],
    usage: { input_tokens: 11, output_tokens: 7 },
    ...over,
  });
}

describe("AnthropicProvider", () => {
  it("refuses to exist without a key", () => {
    // The alternative is a provider that says available:true and 401s forever.
    expect(() => new AnthropicProvider({ apiKey: "   " })).toThrow(LLMUnavailableError);
  });

  it("sends the Messages API shape, and nothing the current models reject", async () => {
    const f = fakeFetch([reply()]);
    const provider = new AnthropicProvider({ apiKey: KEY, fetchImpl: f.impl });

    const out = await provider.complete({ prompt: "plan this", system: "be brief", maxTokens: 2_048 });

    expect(f.last().url).toBe("https://api.anthropic.com/v1/messages");
    expect(f.last().headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": ANTHROPIC_VERSION });
    expect(f.last().body).toEqual({
      model: DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 2_048,
      messages: [{ role: "user", content: "plan this" }],
      system: "be brief",
    });
    expect(out.text).toBe('{"steps":[]}');
    expect(out.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(out.simulated).toBe(false);
  });

  it("carries no sampling parameter and no thinking budget", async () => {
    const f = fakeFetch([reply()]);

    await new AnthropicProvider({ apiKey: KEY, fetchImpl: f.impl }).complete({ prompt: "p" });

    // These are 400s on Opus 5, Fable 5, Sonnet 5 and Opus 4.7/4.8. Asserting the
    // absence is the point: `LLMRequest` has no field for either, so the only way
    // one comes back is an edit written from an older memory of this API.
    const body = f.last().body as Record<string, unknown>;
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
    expect(body).not.toHaveProperty("budget_tokens");
    expect(body).not.toHaveProperty("thinking");
    // Omitted rather than sent empty: `system: ""` is a real field with no content.
    expect(body).not.toHaveProperty("system");
  });

  it("skips thinking blocks when it collects the text", async () => {
    const f = fakeFetch([
      reply({
        content: [
          { type: "thinking", thinking: "the user probably wants…" },
          { type: "text", text: "the answer" },
        ],
      }),
    ]);

    const out = await new AnthropicProvider({ apiKey: KEY, fetchImpl: f.impl }).complete({ prompt: "p" });

    // §51: a chain of thought is not the answer and is not ours to surface. A caller
    // that got it concatenated in would try to parse it as the plan.
    expect(out.text).toBe("the answer");
  });

  it("treats a refusal as a failure even though it arrives as a 200", async () => {
    const f = fakeFetch([reply({ stop_reason: "refusal", content: [] })]);

    await expect(new AnthropicProvider({ apiKey: KEY, fetchImpl: f.impl }).complete({ prompt: "p" })).rejects.toThrow(
      /declined to answer/,
    );
  });

  it("hands a truncated answer back rather than throwing on it", async () => {
    const f = fakeFetch([reply({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"steps":[{"too' }] })]);

    const out = await new AnthropicProvider({ apiKey: KEY, fetchImpl: f.impl }).complete({ prompt: "p" });

    // The planner checks this field and falls back; a bare failure would tell it less.
    expect(out.stopReason).toBe("max_tokens");
  });

  it("fails on a 200 with no text at all", async () => {
    const f = fakeFetch([reply({ content: [] })]);

    await expect(new AnthropicProvider({ apiKey: KEY, fetchImpl: f.impl }).complete({ prompt: "p" })).rejects.toThrow(
      /returned no text/,
    );
  });

  it("appends to a gateway base URL and never names the key in its health", () => {
    const health = new AnthropicProvider({ apiKey: KEY, baseUrl: "https://gw.example.test/", model: "m" }).health();

    expect(health).toEqual({
      name: "anthropic",
      model: "m",
      available: true,
      simulated: false,
      acceptsImages: true,
      note: "configured for https://gw.example.test/v1/messages",
    });
    expect(JSON.stringify(health)).not.toContain(KEY);
  });
});

/** One chat-completions-shaped 200. */
function chat(over: Record<string, unknown> = {}, choice: Record<string, unknown> = {}): Response {
  return json(200, {
    model: "qwen3-8b",
    choices: [{ message: { content: "hello" }, finish_reason: "stop", ...choice }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
    ...over,
  });
}

describe("OpenAiCompatibleProvider", () => {
  it("sends no Authorization header when there is no key", async () => {
    const f = fakeFetch([chat()]);

    await new OpenAiCompatibleProvider({ fetchImpl: f.impl }).complete({ prompt: "p" });

    // A local llama.cpp wants no header at all, and rejecting a blank key would lock
    // out the one setup a user can run with no account.
    expect(f.last().url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(f.last().headers).not.toHaveProperty("authorization");
    expect(f.last().body).toMatchObject({ model: "local-model", stream: false });
  });

  it("sends a bearer token when there is one, and puts system in a message", async () => {
    const f = fakeFetch([chat()]);

    await new OpenAiCompatibleProvider({ apiKey: "sk-local-1234567890abcdef", fetchImpl: f.impl }).complete({
      prompt: "p",
      system: "s",
    });

    expect(f.last().headers.authorization).toBe("Bearer sk-local-1234567890abcdef");
    expect((f.last().body as { messages: unknown }).messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "p" },
    ]);
  });

  it("translates finish_reason into the vocabulary the rest of the code checks", async () => {
    const truncated = await new OpenAiCompatibleProvider({
      fetchImpl: fakeFetch([chat({}, { finish_reason: "length" })]).impl,
    }).complete({ prompt: "p" });
    const done = await new OpenAiCompatibleProvider({ fetchImpl: fakeFetch([chat()]).impl }).complete({ prompt: "p" });

    // `length` here is `max_tokens` on Anthropic, and a caller that had to know both
    // vocabularies would end up checking only one.
    expect(truncated.stopReason).toBe("max_tokens");
    expect(done.stopReason).toBe("end_turn");
  });

  it("treats a content filter as a refusal", async () => {
    const f = fakeFetch([chat({}, { finish_reason: "content_filter", message: { content: "" } })]);

    await expect(new OpenAiCompatibleProvider({ fetchImpl: f.impl }).complete({ prompt: "p" })).rejects.toThrow(
      /declined to answer/,
    );
  });

  it("reads array content and ignores a sibling reasoning field", async () => {
    const f = fakeFetch([
      chat({}, { message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], reasoning_content: "hidden" } }),
    ]);

    const out = await new OpenAiCompatibleProvider({ fetchImpl: f.impl }).complete({ prompt: "p" });

    expect(out.text).toBe("ab");
    expect(out.text).not.toContain("hidden");
  });

  it("reports the model the server actually served", async () => {
    const f = fakeFetch([chat()]);

    const out = await new OpenAiCompatibleProvider({ model: "requested", fetchImpl: f.impl }).complete({ prompt: "p" });

    expect(out.model).toBe("qwen3-8b");
    expect(out.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });
});

describe("HermesProvider", () => {
  it("reads readiness live rather than remembering it", async () => {
    let ready = false;
    const provider = new HermesProvider({ ready: () => ready, ask: async () => ({ text: "x", stopReason: "end_turn" }) });

    expect(provider.available).toBe(false);
    expect(provider.health().available).toBe(false);
    ready = true;
    // The agent crashes and gets restarted; a cached true would send a plan request
    // into a dead pipe and turn a clean fallback into a timeout.
    expect(provider.available).toBe(true);
    expect(provider.health().note).toContain("no token counts");
  });

  it("refuses retryably when the agent is down", async () => {
    const provider = new HermesProvider({ ready: () => false, ask: async () => ({ text: "x", stopReason: "end_turn" }) });

    await expect(provider.complete({ prompt: "p" })).rejects.toMatchObject({ retryable: true });
  });

  it("labels the instructions in the one string ACP accepts", async () => {
    const seen: string[] = [];
    const provider = new HermesProvider({
      ready: () => true,
      ask: async (prompt) => {
        seen.push(prompt);
        return { text: "answer", stopReason: "end_turn" };
      },
    });

    const out = await provider.complete({ prompt: "the task", system: "the rules" });

    // ACP has no system role, so the sections are separated the way `memory-prompt.ts`
    // separates its own — a prompt section must not read as the task.
    expect(seen[0]).toBe("the rules\n\n---\n\nthe task");
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(out.simulated).toBe(false);
  });

  it("stops waiting on an agent that has wedged", async () => {
    const provider = new HermesProvider({
      ready: () => true,
      ask: () => new Promise(() => {}),
      timeoutMs: 20,
    });

    await expect(provider.complete({ prompt: "p" })).rejects.toMatchObject({ retryable: true });
  });

  it("reports a refusal and an empty turn as failures", async () => {
    const refuse = new HermesProvider({ ready: () => true, ask: async () => ({ text: "", stopReason: "refusal" }) });
    const empty = new HermesProvider({ ready: () => true, ask: async () => ({ text: "  ", stopReason: "end_turn" }) });

    await expect(refuse.complete({ prompt: "p" })).rejects.toThrow(/declined/);
    await expect(empty.complete({ prompt: "p" })).rejects.toThrow(/no text/);
  });
});

function choose(env: Record<string, string>, settings?: LlmSettings, hermesReady?: boolean) {
  return createProvider({
    env,
    ...(settings === undefined ? {} : { settings }),
    ...(hermesReady === undefined
      ? {}
      : { hermes: { ready: () => hermesReady, ask: async () => ({ text: "x", stopReason: "end_turn" }) } }),
  });
}

describe("createProvider", () => {
  it("picks Anthropic on a key, and says so without saying what", () => {
    const { provider, reason } = choose({ [ENV_KEYS.anthropicKey]: KEY });

    expect(provider.name).toBe("anthropic");
    expect(provider.available).toBe(true);
    expect(reason).toContain(`set (${KEY.length} characters)`);
    expect(reason).not.toContain(KEY);
  });

  it("will not select a local server on the strength of a default URL", () => {
    const { provider, reason } = choose({});

    // Nobody said there was a server on 127.0.0.1:8080. A provider pointed at one
    // that was never started would report itself available and fail every mission.
    expect(provider.name).toBe("offline");
    expect(reason).toContain("no model configured");
    expect(reason).toContain("not set");
  });

  it("selects a local server once a URL says there is one", () => {
    const { provider, reason } = choose({ [ENV_KEYS.openaiBaseUrl]: "http://127.0.0.1:1234/v1" });

    expect(provider.name).toBe("openai-compatible");
    expect(reason).toContain("http://127.0.0.1:1234/v1");
    expect(reason).toContain("not set");
  });

  it("falls to the agent only when the agent is actually up", () => {
    expect(choose({}, undefined, true).provider.name).toBe("hermes");
    expect(choose({}, undefined, false).provider.name).toBe("offline");
  });

  it("turns an explicit provider with nothing behind it into a reason, not a crash", () => {
    const { provider, reason } = choose({}, { provider: "anthropic" });

    expect(provider).toBeInstanceOf(OfflineProvider);
    expect(reason).toBe('llmProvider is "anthropic" but ANTHROPIC_API_KEY is not set');
    expect(provider.health().note).toBe(reason);
  });

  it("honours an explicit offline as a setting, not as a fault", () => {
    const { provider, reason } = choose({ [ENV_KEYS.anthropicKey]: KEY }, { provider: "offline" });

    // How you turn the model off without deleting your key.
    expect(provider.name).toBe("offline");
    expect(reason).toBe("no model, by configuration");
  });

  it("trusts an explicitly chosen local server with no URL and no key", () => {
    expect(choose({}, { provider: "openai-compatible" }).provider.name).toBe("openai-compatible");
  });

  it("says which agent is missing when hermes is chosen and none was offered", () => {
    expect(choose({}, { provider: "hermes" }).reason).toContain("no agent was offered");
  });

  it("lets config win over the environment, and the environment speak when config is silent", () => {
    const env = { [ENV_KEYS.anthropicKey]: KEY, [ENV_KEYS.provider]: "offline" };

    // A probe can select a provider through the environment without writing to the
    // user's real config.json; a config the user edited outranks it either way.
    expect(choose(env).provider.name).toBe("offline");
    expect(choose(env, { provider: "auto" }).provider.name).toBe("anthropic");
  });

  it("prefers the configured model over the environment's", () => {
    const env = { [ENV_KEYS.anthropicKey]: KEY, [ENV_KEYS.model]: "from-env" };

    expect(choose(env).provider.model).toBe("from-env");
    expect(choose(env, { model: "from-config" }).provider.model).toBe("from-config");
  });

  it("ignores a provider name it does not know", () => {
    expect(choose({ [ENV_KEYS.provider]: "gpt5-please" }).provider.name).toBe("offline");
    expect(choose({ [ENV_KEYS.anthropicKey]: KEY, [ENV_KEYS.provider]: "nonsense" }).provider.name).toBe("anthropic");
  });
});

/**
 * A picture on the wire.
 *
 * Two adapters can carry an image and two cannot, and the difference has to be
 * answerable *before* anything asks the user for their screen — a capture taken for
 * a model that was always going to refuse it is a consent prompt spent for nothing.
 * So these assert the wire shape where an image is supported, and the refusal
 * arriving without a round trip where it is not.
 */
describe("an image, per adapter", () => {
  const PICTURE = { data: "aGVsbG8=", mimeType: "image/png" } as const;

  it("sends the Anthropic block shape, with the picture before the question", async () => {
    const f = fakeFetch([reply()]);

    await new AnthropicProvider({ apiKey: KEY, fetchImpl: f.impl }).complete({
      prompt: "what is wrong here",
      image: PICTURE,
    });

    // Image first: a question asked after the image it is about is answered better,
    // and a planner reading a screenshot is exactly that question.
    expect((f.last().body as { messages: unknown[] }).messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          { type: "text", text: "what is wrong here" },
        ],
      },
    ]);
  });

  it("leaves a request with no picture in the string form it has always used", async () => {
    const f = fakeFetch([reply()]);

    await new AnthropicProvider({ apiKey: KEY, fetchImpl: f.impl }).complete({ prompt: "plan this" });

    // Adding vision must not change the shape of every text call that already worked.
    expect((f.last().body as { messages: unknown[] }).messages).toEqual([
      { role: "user", content: "plan this" },
    ]);
  });

  it("refuses an image on a text-only local server without spending the request", async () => {
    const f = fakeFetch([chat()]);
    const provider = new OpenAiCompatibleProvider({ fetchImpl: f.impl });

    expect(provider.acceptsImages).toBe(false);
    await expect(provider.complete({ prompt: "p", image: PICTURE })).rejects.toThrow(
      /cannot be shown an image/,
    );
    // Before the call, not after: a 400 from the endpoint costs a round trip and
    // arrives as a provider fault rather than as a stated limitation.
    expect(f.count()).toBe(0);
  });

  it("sends a data URL when the endpoint was declared image-capable", async () => {
    const f = fakeFetch([chat()]);

    await new OpenAiCompatibleProvider({ acceptsImages: true, fetchImpl: f.impl }).complete({
      prompt: "what is wrong here",
      image: PICTURE,
    });

    // chat-completions vocabulary, which is what llama.cpp, LM Studio, vLLM and
    // OpenRouter implement — not the Responses API's `input_image`.
    const messages = (f.last().body as { messages: Array<{ content: unknown }> }).messages;
    expect(messages[0]?.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
      { type: "text", text: "what is wrong here" },
    ]);
  });

  it("refuses an image at the ACP seam rather than dropping it", async () => {
    let asked = 0;
    const provider = new HermesProvider({
      ready: () => true,
      ask: async () => {
        asked += 1;
        return { text: "x", stopReason: "end_turn" };
      },
    });

    expect(provider.acceptsImages).toBe(false);
    await expect(provider.complete({ prompt: "p", image: PICTURE })).rejects.toThrow(
      /cannot be shown an image/,
    );
    // Sending the prompt without the picture is the failure this flag exists to
    // prevent: the answer would be a confident description of a screenshot the model
    // never saw, which is the §43 failure with a picture attached.
    expect(asked).toBe(0);
  });

  it("answers the capability question on every provider, in health as well", () => {
    const providers = [
      new AnthropicProvider({ apiKey: KEY }),
      new OpenAiCompatibleProvider(),
      new HermesProvider({ ready: () => true, ask: async () => ({ text: "x", stopReason: "end_turn" }) }),
      new OfflineProvider(),
    ];

    // Required rather than optional on `LLMProvider`, so "cannot see" and "did not
    // say" cannot be the same answer to a caller deciding whether to ask the user for
    // their screen.
    for (const p of providers) {
      expect(typeof p.acceptsImages, p.name).toBe("boolean");
      expect(p.health().acceptsImages, p.name).toBe(p.acceptsImages);
    }
  });

  it("takes the vision claim from configuration rather than from a model name", () => {
    const url = { [ENV_KEYS.openaiBaseUrl]: "http://127.0.0.1:1234/v1" };

    // Nothing on the wire distinguishes a text-only llama.cpp from a vision model on
    // OpenRouter until a request fails, so the default is the cheaper mistake.
    expect(choose(url).provider.acceptsImages).toBe(false);
    expect(choose(url, { vision: true }).provider.acceptsImages).toBe(true);
    // Anthropic's is not configurable: a text-only Claude fails with its own name in
    // the 400, which is a better answer than a table of guesses about model names.
    expect(choose({ [ENV_KEYS.anthropicKey]: KEY }, { vision: false }).provider.acceptsImages).toBe(true);
  });

  it("keeps the picture out of the log when a retry says why it retried", async () => {
    const lines: string[] = [];
    const f = fakeFetch([json(429, { error: "slow down" }, { "retry-after": "0" }), reply()]);

    await new AnthropicProvider({
      apiKey: KEY,
      fetchImpl: f.impl,
      log: (line) => void lines.push(line),
    }).complete({ prompt: "p", image: { data: "QUJDREVGRw==", mimeType: "image/png" } });

    expect(lines.join(" ")).toContain("retrying once");
    expect(lines.join(" ")).not.toContain("QUJDREVGRw==");
  });
});
