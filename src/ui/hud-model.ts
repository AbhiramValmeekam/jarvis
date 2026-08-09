/**
 * Presentation rules for the HUD, kept separate from React so they can be
 * tested without a DOM.
 *
 * The orb is the main signal in the whole product: if it says "listening" when
 * the mic is off, or "thinking" when the runtime is unreachable, the assistant
 * is lying to the user about its own state. Hence the honesty rules below and
 * the tests that pin them.
 */

export type OrbMode =
  | "offline"
  | "muted"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "error"
  /** Runtime is fine; the wake word is not running. Typing still works. */
  | "deaf";

export interface HudFacts {
  connected: boolean;
  state: string;
  muted: boolean;
  listening: boolean;
  hermesState: string;
  /** The voice daemon's state; "unknown" when the status predates it. */
  voiceState?: string;
  /** True only when audio is genuinely being captured right now. */
  capturing?: boolean;
  /** Wake-word model id, so the orb can name the phrase that actually works. */
  wakeWord?: string | null;
}

export interface OrbLook {
  mode: OrbMode;
  /** Tailwind-ish colour token for the core. */
  color: string;
  label: string;
  /** Which keyframe animation to run, if any. */
  animation: "breathe" | "ripple" | "spin" | "none";
  /** Rings emitted outward — used for listening/speaking energy. */
  rings: number;
}

const BUSY = new Set(["understanding", "thinking", "executing", "local_action"]);

export function orbMode(f: HudFacts): OrbMode {
  // Order is a priority list, and it is deliberate: connection truth first,
  // then microphone truth, then activity. Anything else would let a stale
  // "speaking" outrank "the runtime is gone".
  if (!f.connected) return "offline";
  if (f.state === "error" || f.hermesState === "failed") return "error";
  if (f.muted) return "muted";
  if (f.state === "speaking") return "speaking";
  if (f.state === "listening" || f.state === "wake_detected") return "listening";
  if (BUSY.has(f.state)) return "thinking";
  // Idle is the one state that makes a promise — "say Jarvis". Only keep that
  // promise when a daemon is actually capturing; otherwise say so, because an
  // idle orb over a dead microphone is the exact failure this project forbids.
  if (f.voiceState !== undefined && !f.capturing) return "deaf";
  return "idle";
}

/** Voice states that resolve on their own, so the orb should say "wait". */
function isStartingUp(voiceState: string | undefined): boolean {
  return voiceState === "starting" || voiceState === "restarting";
}

const LOOKS: Record<OrbMode, Omit<OrbLook, "mode">> = {
  offline: {
    color: "#475569",
    label: "Runtime not connected",
    animation: "none",
    rings: 0,
  },
  muted: {
    color: "#94a3b8",
    label: "Microphone off",
    animation: "none",
    rings: 0,
  },
  idle: {
    color: "#38bdf8",
    label: "Say “Jarvis”",
    animation: "breathe",
    rings: 0,
  },
  listening: {
    color: "#22d3ee",
    label: "Listening",
    animation: "ripple",
    rings: 3,
  },
  thinking: {
    color: "#fbbf24",
    label: "Thinking",
    animation: "spin",
    rings: 1,
  },
  speaking: {
    color: "#a78bfa",
    label: "Speaking",
    animation: "ripple",
    rings: 2,
  },
  error: {
    color: "#f87171",
    label: "Something went wrong",
    animation: "none",
    rings: 0,
  },
  deaf: {
    color: "#64748b",
    label: "Voice off — type instead",
    animation: "none",
    rings: 0,
  },
};

export function orbLook(f: HudFacts): OrbLook {
  const mode = orbMode(f);
  const look = { mode, ...LOOKS[mode] };
  // Loading models takes a few seconds. That is worth distinguishing from
  // voice being broken: one resolves itself, the other needs the user.
  if (mode === "deaf" && isStartingUp(f.voiceState)) {
    return { ...look, label: "Starting voice…", animation: "breathe" };
  }
  // Name the phrase the running model actually answers to, not a guess.
  if (mode === "idle" && f.wakeWord) {
    return { ...look, label: `Say “${wakeWordPhrase(f.wakeWord)}”` };
  }
  return look;
}

/**
 * Turn a wake-word model id into something a human can be asked to say.
 *
 * The ids come from the model files (`hey_jarvis`, `alexa`), and telling the
 * user to say "hey_jarvis" is telling them the wrong thing. Falls back to
 * "Jarvis" only when there is no model to name at all.
 */
export function wakeWordPhrase(wakeWord: string | null | undefined): string {
  if (!wakeWord) return "Jarvis";
  const words = wakeWord.replace(/[_-]+/g, " ").trim().split(/\s+/);
  return words.map((w) => (w[0] ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

/**
 * Scale the orb by microphone level.
 *
 * Clamped, because an un-clamped RMS spike makes the orb jump off-screen, and
 * floored above zero so silence still shows a live orb rather than nothing.
 */
export function orbScale(rms: number, mode: OrbMode): number {
  if (mode !== "listening") return 1;
  const safe = Number.isFinite(rms) ? Math.max(0, Math.min(1, rms)) : 0;
  return 1 + safe * 0.35;
}

/** Whether the composer should accept input right now. */
export function canSubmit(f: HudFacts, text: string): boolean {
  return f.connected && text.trim().length > 0;
}
