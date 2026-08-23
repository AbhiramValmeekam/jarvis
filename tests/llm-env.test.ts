/**
 * The LLM layer's foundations: reading `.env`, saying whether a key is set without
 * saying what it is, finding JSON in a model's prose, and refusing when there is no
 * model at all.
 *
 * These four are tested together because they share one property, which is the only
 * property worth asserting about them: none of them may ever put a secret in a string
 * that something else is going to log, show, or send over the pipe. The rest — a
 * quoted value, a fenced JSON object — is ordinary parsing, and it is here because
 * `.env` is a file a person edits by hand and gets slightly wrong.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSecret, loadEnv, parseEnv } from "../src/llm/env.js";
import { LLMUnavailableError, extractJson, redactSecrets } from "../src/llm/provider.js";
import { OfflineProvider } from "../src/llm/offline.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-env-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseEnv", () => {
  it("reads the shapes a person actually writes", () => {
    const env = parseEnv(
      [
        "# a comment",
        "",
        "ANTHROPIC_API_KEY=sk-ant-plain",
        'OPENAI_BASE_URL="http://127.0.0.1:8080/v1"',
        "export JARVIS_LLM_MODEL='claude-opus-5'",
        "  SPACED = value  ",
      ].join("\n"),
    );

    expect(env).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-plain",
      OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
      JARVIS_LLM_MODEL: "claude-opus-5",
      SPACED: "value",
    });
  });

  it("ends an unquoted value at a trailing comment but not inside quotes", () => {
    const env = parseEnv(['A=abc # a note', 'B="abc # not a note"', "C=abc#glued"].join("\n"));

    expect(env.A).toBe("abc");
    expect(env.B).toBe("abc # not a note");
    // No space before the `#`, so it is part of the value — a `#` is legal in a key.
    expect(env.C).toBe("abc#glued");
  });

  it("skips lines that are not settings rather than inventing keys", () => {
    const env = parseEnv(
      ["justwords", "=novalue", "9BAD=x", "HAS-DASH=x", "EMPTY=", 'QUOTED_EMPTY=""'].join("\n"),
    );

    // An empty value is dropped, so `describeSecret` says "not set" rather than
    // "set (0 characters)" for a key someone commented out by deleting the value.
    expect(env).toEqual({});
  });
});

describe("loadEnv", () => {
  it("lets the real environment win over the file", () => {
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=from-file\nOPENAI_BASE_URL=from-file\n");

    const env = loadEnv(dir, undefined, { ANTHROPIC_API_KEY: "from-shell" });

    // A key exported in the launching shell is a more deliberate statement than a
    // file left in a checkout; a file shadowing it is how the wrong key gets used.
    expect(env.ANTHROPIC_API_KEY).toBe("from-shell");
    expect(env.OPENAI_BASE_URL).toBe("from-file");
  });

  it("notes counts and never a value", () => {
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=sk-ant-secretvalue\nSHADOWED=x\n");
    const notes: string[] = [];

    loadEnv(dir, (line) => notes.push(line), { SHADOWED: "kept" });

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("1 of 2 setting(s) applied");
    expect(notes.join("\n")).not.toContain("sk-ant-secretvalue");
    expect(notes.join("\n")).not.toContain("ANTHROPIC_API_KEY");
  });

  it("comes up without a file rather than failing", () => {
    const notes: string[] = [];

    const env = loadEnv(dir, (line) => notes.push(line), { PATH: "/usr/bin" });

    expect(env.PATH).toBe("/usr/bin");
    expect(notes[0]).toContain("no .env in");
  });
});

describe("describeSecret", () => {
  it("answers whether, and how long, and nothing else", () => {
    expect(describeSecret(undefined)).toBe("not set");
    expect(describeSecret("   ")).toBe("not set");
    // The length separates the two failures a user hits — nothing set, and a
    // truncated paste — and reveals nothing usable.
    expect(describeSecret("sk-ant-abc")).toBe("set (10 characters)");
    expect(describeSecret("sk-ant-abc")).not.toContain("sk-ant");
  });
});

describe("extractJson", () => {
  it("finds the object inside a fence and a preamble", () => {
    const text = 'Sure, here is the plan:\n```json\n{"steps":[{"tool":"git_status"}]}\n```\nHope that helps.';

    expect(extractJson(text)).toEqual({ steps: [{ tool: "git_status" }] });
  });

  it("does not end at a brace inside a string", () => {
    // A greedy regex would stop at the first `}`, which is inside the title, and
    // hand back half an object — a plan missing its verification step.
    expect(extractJson('{"title":"Build {the app}","ok":true}')).toEqual({
      title: "Build {the app}",
      ok: true,
    });
  });

  it("survives an escaped quote", () => {
    expect(extractJson('{"title":"say \\"hi\\"","n":1}')).toEqual({ title: 'say "hi"', n: 1 });
  });

  it("returns null for prose and for a broken object", () => {
    // Null is a real answer: a model that produced no JSON produced no plan, and
    // inventing one from its prose is the failure §43 names.
    expect(extractJson("I searched the web and everything is fine.")).toBeNull();
    expect(extractJson('{"steps":[}')).toBeNull();
    expect(extractJson('{"unterminated":"')).toBeNull();
  });
});

describe("redactSecrets", () => {
  it("removes a literal key wherever it appears", () => {
    const key = "sk-ant-api03-abcdefghijklmnop";

    const out = redactSecrets(`bad request for ${key} at ${key}`, [key]);

    expect(out).not.toContain(key);
    expect(out).toBe("bad request for [redacted] at [redacted]");
  });

  it("ignores a short 'secret' so an empty key cannot blank the message", () => {
    expect(redactSecrets("HTTP 429 from the gateway", [""])).toBe("HTTP 429 from the gateway");
    expect(redactSecrets("model a1b2 refused", ["a1b2"])).toBe("model a1b2 refused");
  });

  it("catches key shapes it was never given", () => {
    const out = redactSecrets("echoed: sk-ant-api03-zzzzzzzzzzzz and sk-proj-abcdefghijklmnopqrstuvwx", []);

    expect(out).not.toContain("sk-ant-api03");
    expect(out).not.toContain("sk-proj-abcdefghijklmnopqrstuvwx");
  });
});

describe("OfflineProvider", () => {
  it("refuses instead of producing plan-shaped text", async () => {
    const provider = new OfflineProvider("ANTHROPIC_API_KEY is not set");

    expect(provider.available).toBe(false);
    expect(provider.simulated).toBe(true);
    await expect(provider.complete()).rejects.toBeInstanceOf(LLMUnavailableError);
    // Not retryable: nothing about waiting configures a provider.
    await expect(provider.complete()).rejects.toMatchObject({ retryable: false });
  });

  it("carries its reason to the wire, where the UI shows it", () => {
    expect(new OfflineProvider("no model, by configuration").health()).toEqual({
      name: "offline",
      model: "none",
      available: false,
      simulated: true,
      acceptsImages: false,
      note: "no model, by configuration",
    });
  });
});
