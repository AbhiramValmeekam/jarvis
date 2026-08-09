/**
 * The headless contract, tested against envelopes the CLI really produced.
 *
 * The two central fixtures here are not invented. They are trimmed copies of
 * actual stdout from `claude -p --output-format json` on this machine during the
 * Phase 7 contract probe, and they are here because both of them read as success
 * to a careless caller:
 *
 *   API_503   exit 0, subtype "success", is_error true
 *   DENIED    exit 0, is_error FALSE, terminal_reason "completed", no file written
 *
 * A test suite written from the documented happy path would pass while the
 * integration silently reported failed work as done.
 */
import { describe, it, expect } from "vitest";
import {
  buildArgs,
  parseClaudeJson,
  classifyResult,
  speakResult,
} from "../src/coding/claude-cli.js";

/** Real 503 from the configured gateway. Exit code was 0. */
const API_503 = JSON.stringify({
  is_error: true,
  num_turns: 1,
  session_id: "a82cd579-46ca-4fec-8aaa-a6d52f63869d",
  total_cost_usd: 0,
  terminal_reason: "api_error",
  subtype: "success",
  api_error_status: 503,
  result: "API Error: 503 no available channel for model",
  duration_ms: 179640,
  permission_denials: [],
});

/** Real refused write. `is_error` was false and no file appeared. */
const DENIED = JSON.stringify({
  is_error: false,
  num_turns: 3,
  session_id: "3f8a1c2e-0000-4000-8000-000000000001",
  total_cost_usd: 0.0343,
  terminal_reason: "completed",
  subtype: "success",
  api_error_status: null,
  result: "The write to probe.txt was declined at the permission prompt, so no file was created.",
  duration_ms: 21000,
  permission_denials: [
    { tool_name: "Write", tool_use_id: "toolu_01", tool_input: { file_path: "x" } },
  ],
});

const OK = JSON.stringify({
  is_error: false,
  num_turns: 2,
  session_id: "10fe9058-8432-4c3d-9401-406c95fd25b7",
  total_cost_usd: 0.021,
  terminal_reason: "completed",
  api_error_status: null,
  result: "PROBE_OK",
  duration_ms: 3122,
  permission_denials: [],
});

describe("buildArgs", () => {
  it("terminates the flags with -- so a prompt is never read as one", () => {
    const args = buildArgs({ prompt: "--version", permissionMode: "acceptEdits" });
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("--version");
  });

  it("passes an empty tool list through instead of dropping the flag", () => {
    // `--tools ""` is how a read-only question is asked. If the empty string is
    // treated as "unset", a question about code silently gains write access.
    const args = buildArgs({ prompt: "explain this", permissionMode: "plan", tools: [] });
    const i = args.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("");
  });

  it("uses --tools, not the retired --allowedTools", () => {
    const args = buildArgs({ prompt: "x", permissionMode: "acceptEdits", tools: ["Read"] });
    expect(args).not.toContain("--allowedTools");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read");
  });

  it("pins no model unless asked", () => {
    // The model in the original notes is unroutable on this gateway (503). A
    // default here would hard-code someone else's routing table.
    expect(buildArgs({ prompt: "x", permissionMode: "acceptEdits" })).not.toContain("--model");
    expect(
      buildArgs({ prompt: "x", permissionMode: "acceptEdits", model: "sonnet" }),
    ).toContain("sonnet");
  });

  it("always states a permission mode", () => {
    // Unset means the CLI's interactive default, under which every tool call is
    // put to a prompt no one can answer and the run reports success having done
    // nothing. The type makes it required; this asserts it reaches the argv.
    expect(buildArgs({ prompt: "x", permissionMode: "dontAsk" })).toContain("--permission-mode");
  });

  it("resumes by session id", () => {
    const args = buildArgs({ prompt: "x", permissionMode: "plan", sessionId: "abc" });
    expect(args[args.indexOf("--resume") + 1]).toBe("abc");
  });
});

describe("parseClaudeJson", () => {
  it("reads a real result", () => {
    const j = parseClaudeJson(OK);
    expect(j.result).toBe("PROBE_OK");
    expect(j.session_id).toBe("10fe9058-8432-4c3d-9401-406c95fd25b7");
    expect(j.is_error).toBe(false);
  });

  it("refuses empty output rather than calling it an empty answer", () => {
    expect(() => parseClaudeJson("   ")).toThrow(/no output/);
  });

  it("refuses a stack trace", () => {
    expect(() => parseClaudeJson("Error: ENOENT\n  at foo")).toThrow(/did not return JSON/);
  });

  it("refuses JSON that is not a result envelope", () => {
    expect(() => parseClaudeJson('{"ok":true}')).toThrow(/without a result field/);
    expect(() => parseClaudeJson("[1,2]")).toThrow(/non-object/);
  });

  it("does not spill an unbounded child's output into the error", () => {
    const huge = "x".repeat(50_000);
    expect(() => parseClaudeJson(huge)).toThrow(/^claude did not return JSON: x{1,140}$/);
  });

  it("drops malformed denial entries instead of trusting the shape", () => {
    const j = parseClaudeJson(
      JSON.stringify({ result: "", session_id: "s", permission_denials: [null, 7, { tool_name: "Bash" }] }),
    );
    expect(j.permission_denials).toEqual([{ tool_name: "Bash" }]);
  });
});

describe("classifyResult", () => {
  it("calls a 503 a failure even though the CLI exited 0 and said success", () => {
    const r = classifyResult(parseClaudeJson(API_503), 179640);
    expect(r.status).toBe("failed");
    expect(r.detail).toMatch(/API error 503/);
  });

  it("calls a refused write refused even though is_error was false", () => {
    // The load-bearing test of this phase. The CLI reported no error, the
    // terminal reason was "completed", and the file did not exist.
    const r = classifyResult(parseClaudeJson(DENIED), 21000);
    expect(r.status).toBe("refused");
    expect(r.denied).toEqual(["Write"]);
    expect(r.detail).toMatch(/not permitted/);
  });

  it("deduplicates a tool denied several times", () => {
    const many = JSON.stringify({
      result: "",
      session_id: "s",
      is_error: false,
      permission_denials: [{ tool_name: "Bash" }, { tool_name: "Bash" }, { tool_name: "Edit" }],
    });
    expect(classifyResult(parseClaudeJson(many), 1).denied).toEqual(["Bash", "Edit"]);
  });

  it("reports a clean run as reported, never as verified", () => {
    const r = classifyResult(parseClaudeJson(OK), 3122);
    expect(r.status).toBe("reported");
    // The word matters. Nothing in this file has looked at the code.
    expect(r.detail).toMatch(/not independently verified/);
  });

  it("has no ok field to mistake for a verdict", () => {
    expect("ok" in classifyResult(parseClaudeJson(OK), 1)).toBe(false);
  });

  it("prefers the API error over a denial list from a turn that never ran", () => {
    const both = JSON.stringify({
      result: "",
      session_id: "s",
      is_error: true,
      api_error_status: 429,
      permission_denials: [{ tool_name: "Write" }],
    });
    expect(classifyResult(parseClaudeJson(both), 1).status).toBe("failed");
  });
});

describe("speakResult", () => {
  const r = (over: Partial<ReturnType<typeof classifyResult>>) => ({
    ...classifyResult(parseClaudeJson(OK), 1),
    ...over,
  });

  it("never says done about work it has not checked", () => {
    const said = speakResult(r({ status: "reported" }), "the refactor");
    expect(said).toMatch(/says it finished/);
    expect(said).toMatch(/not checked/);
  });

  it("says out loud when tools were blocked", () => {
    const said = speakResult(r({ status: "refused", denied: ["Write"] }), "the fix");
    expect(said).toMatch(/blocked from using Write/);
    expect(said).toMatch(/not finished/);
  });

  it("warns that a timeout can leave half-finished work", () => {
    expect(speakResult(r({ status: "timed-out" }), "the build")).toMatch(/half done/);
  });
});
