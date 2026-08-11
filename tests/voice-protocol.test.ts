/**
 * Tests for the voice wire protocol.
 *
 * This parser sits on the boundary where *transcribed speech* enters the
 * runtime. Under §52 that is untrusted data: whatever was said near the
 * microphone, plus whatever a malfunctioning daemon decides to print. So the
 * cases that matter here are the hostile and the malformed ones, not the happy
 * path — a parser that only survives well-formed input is not a boundary.
 */
import { describe, it, expect } from "vitest";
import {
  LineBuffer,
  VOICE_PROTOCOL_VERSION,
  encodeCommand,
  parseVoiceEvent,
  sanitizeSpeechText,
} from "../src/voice/voice-protocol.js";

describe("encodeCommand", () => {
  it("emits exactly one newline-terminated JSON line", () => {
    const line = encodeCommand({ type: "speak", text: "hello" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({ type: "speak", text: "hello" });
  });

  it("keeps embedded newlines inside the JSON string, not the framing", () => {
    // A reply containing a newline must not become two frames.
    const line = encodeCommand({ type: "speak", text: "a\nb" });
    expect(line.split("\n").filter((l) => l).length).toBe(1);
    expect(JSON.parse(line).text).toBe("a\nb");
  });

  it("exposes a protocol version", () => {
    expect(VOICE_PROTOCOL_VERSION).toBe(1);
  });
});

describe("sanitizeSpeechText", () => {
  it("strips ANSI escapes so a transcript cannot forge log output", () => {
    const evil = `\u001b[31mFAILED\u001b[0m`;
    const out = sanitizeSpeechText(evil);
    expect(out).not.toContain("\u001b");
    expect(out).toContain("FAILED");
  });

  it("removes NUL and C1 control characters", () => {
    expect(sanitizeSpeechText("a\u0000b\u009fc")).toBe("a b c");
  });

  it("flattens a transcript to a single line", () => {
    expect(sanitizeSpeechText("line one\nline two\r\nthree")).toBe(
      "line one line two three",
    );
  });

  it("collapses runs of whitespace and trims", () => {
    expect(sanitizeSpeechText("  hey   jarvis  ")).toBe("hey jarvis");
  });

  it("bounds length so one utterance cannot become a document", () => {
    expect(sanitizeSpeechText("x".repeat(20_000)).length).toBe(8_000);
  });

  it("leaves ordinary speech untouched", () => {
    expect(sanitizeSpeechText("what time is it?")).toBe("what time is it?");
  });
});

describe("parseVoiceEvent", () => {
  it("parses a ready frame", () => {
    const e = parseVoiceEvent(
      JSON.stringify({
        type: "ready",
        wakeWord: "hey_jarvis",
        device: "Mic",
        sttModel: "base.en",
        ttsVoice: "amy",
        sampleRate: 16000,
        capture: true,
      }),
    );
    expect(e).toEqual({
      type: "ready",
      wakeWord: "hey_jarvis",
      device: "Mic",
      sttModel: "base.en",
      ttsVoice: "amy",
      sampleRate: 16000,
      capture: true,
    });
  });

  it("nulls the engines that failed to load rather than inventing names", () => {
    const e = parseVoiceEvent(JSON.stringify({ type: "ready", capture: false }));
    expect(e).toMatchObject({
      type: "ready",
      wakeWord: null,
      sttModel: null,
      ttsVoice: null,
      capture: false,
    });
  });

  it("sanitizes transcripts on the way in", () => {
    const e = parseVoiceEvent(
      JSON.stringify({ type: "final", text: "open\u001b[2J notepad", ms: 12 }),
    );
    expect(e).toEqual({ type: "final", text: "open [2J notepad", ms: 12 });
  });

  it("omits `reason` rather than setting it undefined", () => {
    const e = parseVoiceEvent(JSON.stringify({ type: "final", text: "hi", ms: 1 }));
    expect(e && "reason" in e).toBe(false);
  });

  it("clamps the orb's level input", () => {
    expect(parseVoiceEvent(`{"type":"level","rms":9}`)).toEqual({ type: "level", rms: 1 });
    expect(parseVoiceEvent(`{"type":"level","rms":-4}`)).toEqual({ type: "level", rms: 0 });
    // NaN would propagate into a CSS transform and blank the orb.
    expect(parseVoiceEvent(`{"type":"level","rms":"loud"}`)).toEqual({
      type: "level",
      rms: 0,
    });
  });

  it("coerces wrong-typed fields to safe defaults instead of passing them through", () => {
    const e = parseVoiceEvent(
      JSON.stringify({ type: "speech_end", ms: "soon", truncated: "yes" }),
    );
    expect(e).toEqual({ type: "speech_end", ms: 0, truncated: false });
  });

  it("rejects a score of Infinity", () => {
    expect(parseVoiceEvent(`{"type":"wake","score":1e999}`)).toEqual({
      type: "wake",
      score: 0,
    });
  });

  it.each([
    ["blank", "   "],
    ["not JSON", "hello there"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON scalar", `"ready"`],
    ["null", "null"],
    ["an unknown type", `{"type":"shutdown_now"}`],
    ["a missing type", `{"text":"hi"}`],
    ["a non-string type", `{"type":7}`],
  ])("drops %s", (_label, line) => {
    expect(parseVoiceEvent(line)).toBeNull();
  });

  it("drops an oversized frame rather than propagating it", () => {
    const huge = JSON.stringify({ type: "final", text: "x".repeat(300_000), ms: 0 });
    expect(parseVoiceEvent(huge)).toBeNull();
  });

  it("ignores extra fields an attacker or a newer daemon might add", () => {
    const e = parseVoiceEvent(
      JSON.stringify({ type: "wake", score: 0.9, __proto__: { polluted: true } }),
    );
    expect(e).toEqual({ type: "wake", score: 0.9 });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("parses the remaining event types", () => {
    expect(parseVoiceEvent(`{"type":"muted","muted":true,"capturing":false}`)).toEqual({
      type: "muted",
      muted: true,
      capturing: false,
    });
    expect(parseVoiceEvent(`{"type":"barge_in","trigger":"wake"}`)).toEqual({
      type: "barge_in",
      trigger: "wake",
    });
    expect(parseVoiceEvent(`{"type":"speaking_start","ms":30,"id":"t1"}`)).toEqual({
      type: "speaking_start",
      ms: 30,
      id: "t1",
    });
    expect(parseVoiceEvent(`{"type":"speaking_done","ms":900,"id":null}`)).toEqual({
      type: "speaking_done",
      ms: 900,
      id: null,
    });
    expect(parseVoiceEvent(`{"type":"speaking_stopped"}`)).toEqual({
      type: "speaking_stopped",
      reason: "stopped",
      id: null,
    });
    // The id says *what* was interrupted. A barge-in over the wake
    // acknowledgement must not read as a barge-in over an answer.
    expect(
      parseVoiceEvent(`{"type":"speaking_stopped","reason":"barge_in","id":"wake-ack"}`),
    ).toEqual({
      type: "speaking_stopped",
      reason: "barge_in",
      id: "wake-ack",
    });
    expect(parseVoiceEvent(`{"type":"wake_timeout","ms":6000}`)).toEqual({
      type: "wake_timeout",
      ms: 6000,
    });
    expect(parseVoiceEvent(`{"type":"speech_start","reason":"vad"}`)).toEqual({
      type: "speech_start",
      reason: "vad",
    });
    expect(parseVoiceEvent(`{"type":"listening","listening":false}`)).toEqual({
      type: "listening",
      listening: false,
    });
    expect(parseVoiceEvent(`{"type":"conversation","open":true}`)).toEqual({
      type: "conversation",
      open: true,
    });
    expect(parseVoiceEvent(`{"type":"pong","id":"p"}`)).toEqual({ type: "pong", id: "p" });
    expect(parseVoiceEvent(`{"type":"stopped"}`)).toEqual({ type: "stopped" });
    expect(parseVoiceEvent(`{"type":"log","line":"loaded"}`)).toEqual({
      type: "log",
      line: "loaded",
    });
  });

  it("gives errors and unavailability a reason even when the daemon omits one", () => {
    expect(parseVoiceEvent(`{"type":"error"}`)).toEqual({
      type: "error",
      message: "unknown error",
      fatal: false,
    });
    expect(parseVoiceEvent(`{"type":"unavailable"}`)).toEqual({
      type: "unavailable",
      subsystem: "voice",
      reason: "no reason given",
    });
  });
});

describe("LineBuffer", () => {
  it("emits nothing until a line is terminated", () => {
    const b = new LineBuffer();
    expect(b.push(`{"type":"wa`)).toEqual([]);
    expect(b.push(`ke","score":1}\n`)).toEqual([`{"type":"wake","score":1}`]);
  });

  it("splits several lines arriving in one chunk", () => {
    const b = new LineBuffer();
    expect(b.push("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  it("keeps the trailing partial for the next chunk", () => {
    const b = new LineBuffer();
    expect(b.push("a\nb")).toEqual(["a"]);
    expect(b.flush()).toEqual(["b"]);
  });

  it("flushes nothing when the remainder is blank", () => {
    const b = new LineBuffer();
    b.push("a\n  ");
    expect(b.flush()).toEqual([]);
  });

  it("drops an unterminated flood instead of buffering it forever", () => {
    const b = new LineBuffer(64);
    expect(b.push("x".repeat(200))).toEqual([]);
    expect(b.flush()).toEqual([]);
  });

  it("survives a byte-at-a-time stream", () => {
    const b = new LineBuffer();
    const src = `{"type":"stopped"}\n`;
    const out: string[] = [];
    for (const ch of src) out.push(...b.push(ch));
    expect(out).toEqual([`{"type":"stopped"}`]);
  });
});
