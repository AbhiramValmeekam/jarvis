/**
 * Wire contract between the Jarvis runtime and the Python voice daemon.
 *
 * Transport is line-delimited JSON over the daemon's stdio: events out on its
 * stdout, commands in on its stdin, human logs on stderr. Same shape as the
 * ACP transport proven in Phase 1, for the same reason — it is trivially
 * framed, trivially logged, and survives a process restart cleanly.
 *
 * Everything here is pure. The parser is the security boundary for this
 * subsystem: the daemon's output carries *transcribed speech*, which is
 * whatever happened to be said near the microphone, and by §52 that is
 * untrusted data. So parsing never trusts a field's presence or type, and a
 * malformed or unknown line is dropped rather than allowed to become a
 * half-populated event object.
 */

/** Bumped when the shape below changes incompatibly. */
export const VOICE_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// daemon → runtime
// ---------------------------------------------------------------------------

export type VoiceEvent =
  /** Models loaded; fields are null when that engine failed to load. */
  | {
      type: "ready";
      wakeWord: string | null;
      device: string | null;
      sttModel: string | null;
      ttsVoice: string | null;
      sampleRate: number;
      capture: boolean;
    }
  /** Wake word fired. The latency budget is measured from this event. */
  | { type: "wake"; score: number }
  | { type: "speech_start"; reason: string }
  | { type: "speech_end"; ms: number; truncated: boolean }
  /** Final transcript. `text` may be empty — say nothing rather than guess. */
  | { type: "final"; text: string; ms: number; reason?: string }
  /** Woke, but nobody spoke. */
  | { type: "wake_timeout"; ms: number }
  | { type: "barge_in"; trigger: string }
  | { type: "speaking_start"; ms: number; id: string | null }
  | { type: "speaking_done"; ms: number; id: string | null }
  | { type: "speaking_stopped"; reason: string }
  /** Microphone level, for the orb. */
  | { type: "level"; rms: number }
  | { type: "muted"; muted: boolean; capturing: boolean }
  | { type: "listening"; listening: boolean }
  | { type: "conversation"; open: boolean }
  | { type: "pong"; id: string | null }
  | { type: "error"; message: string; fatal: boolean }
  /** A subsystem is honestly not working, with the reason (§4). */
  | { type: "unavailable"; subsystem: string; reason: string }
  | { type: "log"; line: string }
  /**
   * Measurement only: the daemon just handed the models the audio frame the
   * latency budget is timed from. Emitted solely by `--device file:…`, so a
   * real run never produces one.
   *
   * It is a stdout event rather than a log line because the two pipes are not
   * ordered against each other, and the whole point of this event is when it
   * arrived. The runtime ignores it; scripts/probe-voice.ts is the only reader.
   */
  | { type: "feed_mark"; index: number }
  | { type: "stopped" };

export type VoiceEventType = VoiceEvent["type"];

// ---------------------------------------------------------------------------
// runtime → daemon
// ---------------------------------------------------------------------------

export type VoiceCommand =
  | { type: "speak"; text: string; id?: string }
  | { type: "stop_speaking"; reason?: string }
  | { type: "set_muted"; muted: boolean }
  | { type: "set_listening"; enabled: boolean }
  /** Open the follow-up window: speech alone starts a turn, no wake word. */
  | { type: "set_conversation"; open: boolean }
  | { type: "ptt"; down: boolean }
  | { type: "ping"; id?: string }
  | { type: "shutdown" };

export function encodeCommand(cmd: VoiceCommand): string {
  return `${JSON.stringify(cmd)}\n`;
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/** Anything longer than this is not an event we produced. */
const MAX_LINE_BYTES = 256 * 1024;
/** Transcripts are speech, not documents. Bound them before they propagate. */
const MAX_TEXT_CHARS = 8_000;

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function nullableStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Strip control characters from text that came in over the microphone.
 *
 * A transcript reaches a terminal, a log file and a UI. Whisper will not
 * normally emit an ANSI escape, but "normally" is not a security argument:
 * the cost of stripping is nothing and the cost of being wrong is a spoofed
 * log line. Newlines go too — a transcript is one utterance, one line.
 */
export function sanitizeSpeechText(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

/**
 * Parse one line from the daemon.
 *
 * Returns null for anything that is not a recognisable event: blank lines,
 * malformed JSON, unknown types, oversized frames. Dropping is deliberate —
 * a voice daemon that starts emitting garbage should go quiet, not inject
 * partially-typed objects into the runtime's state machine.
 */
export function parseVoiceEvent(line: string): VoiceEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_LINE_BYTES) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const o = raw as Record<string, unknown>;
  switch (o["type"]) {
    case "ready":
      return {
        type: "ready",
        wakeWord: nullableStr(o["wakeWord"]),
        device: nullableStr(o["device"]),
        sttModel: nullableStr(o["sttModel"]),
        ttsVoice: nullableStr(o["ttsVoice"]),
        sampleRate: num(o["sampleRate"], 16000),
        capture: bool(o["capture"]),
      };
    case "wake":
      return { type: "wake", score: num(o["score"]) };
    case "speech_start":
      return { type: "speech_start", reason: str(o["reason"], "unknown") };
    case "speech_end":
      return {
        type: "speech_end",
        ms: num(o["ms"]),
        truncated: bool(o["truncated"]),
      };
    case "final": {
      const text = sanitizeSpeechText(str(o["text"]));
      const reason = nullableStr(o["reason"]);
      return {
        type: "final",
        text,
        ms: num(o["ms"]),
        ...(reason === null ? {} : { reason }),
      };
    }
    case "wake_timeout":
      return { type: "wake_timeout", ms: num(o["ms"]) };
    case "barge_in":
      return { type: "barge_in", trigger: str(o["trigger"], "unknown") };
    case "speaking_start":
      return { type: "speaking_start", ms: num(o["ms"]), id: nullableStr(o["id"]) };
    case "speaking_done":
      return { type: "speaking_done", ms: num(o["ms"]), id: nullableStr(o["id"]) };
    case "speaking_stopped":
      return { type: "speaking_stopped", reason: str(o["reason"], "stopped") };
    case "level": {
      // Clamped: a NaN or a wild value here would drive the orb's scale.
      const rms = Math.min(1, Math.max(0, num(o["rms"])));
      return { type: "level", rms };
    }
    case "muted":
      return { type: "muted", muted: bool(o["muted"]), capturing: bool(o["capturing"]) };
    case "listening":
      return { type: "listening", listening: bool(o["listening"]) };
    case "conversation":
      return { type: "conversation", open: bool(o["open"]) };
    case "pong":
      return { type: "pong", id: nullableStr(o["id"]) };
    case "feed_mark":
      return { type: "feed_mark", index: num(o["index"]) };
    case "error":
      return {
        type: "error",
        message: sanitizeSpeechText(str(o["message"], "unknown error")),
        fatal: bool(o["fatal"]),
      };
    case "unavailable":
      return {
        type: "unavailable",
        subsystem: str(o["subsystem"], "voice"),
        reason: sanitizeSpeechText(str(o["reason"], "no reason given")),
      };
    case "log":
      return { type: "log", line: sanitizeSpeechText(str(o["line"])) };
    case "stopped":
      return { type: "stopped" };
    default:
      return null;
  }
}

/**
 * Incremental splitter for a stdout stream.
 *
 * A chunk boundary can land anywhere, including mid-JSON, so lines are only
 * emitted once terminated. The buffer is capped: a daemon that writes an
 * unterminated megabyte is malfunctioning, and holding it all in memory would
 * turn that into the runtime's problem too.
 */
export class LineBuffer {
  private buf = "";

  constructor(private readonly maxBytes = MAX_LINE_BYTES) {}

  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let idx = this.buf.indexOf("\n");
    while (idx !== -1) {
      lines.push(this.buf.slice(0, idx));
      this.buf = this.buf.slice(idx + 1);
      idx = this.buf.indexOf("\n");
    }
    if (this.buf.length > this.maxBytes) this.buf = "";
    return lines;
  }

  /** Whatever is left when the stream ends. */
  flush(): string[] {
    const rest = this.buf;
    this.buf = "";
    return rest.trim() ? [rest] : [];
  }
}
