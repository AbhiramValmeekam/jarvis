import { describe, it, expect } from "vitest";
import {
  orbMode,
  orbLook,
  orbScale,
  canSubmit,
  wakeWordPhrase,
  wakeWordPhrases,
  type HudFacts,
} from "../src/ui/hud-model.js";

const facts = (over: Partial<HudFacts> = {}): HudFacts => ({
  connected: true,
  state: "idle",
  muted: false,
  listening: true,
  hermesState: "ready",
  ...over,
});

describe("orb mode", () => {
  it("maps assistant states to the matching visual", () => {
    expect(orbMode(facts({ state: "idle" }))).toBe("idle");
    expect(orbMode(facts({ state: "listening" }))).toBe("listening");
    expect(orbMode(facts({ state: "wake_detected" }))).toBe("listening");
    expect(orbMode(facts({ state: "thinking" }))).toBe("thinking");
    expect(orbMode(facts({ state: "executing" }))).toBe("thinking");
    expect(orbMode(facts({ state: "speaking" }))).toBe("speaking");
  });

  it("never shows listening while the microphone is muted", () => {
    // The single most important honesty rule in the UI.
    expect(orbMode(facts({ muted: true, state: "listening" }))).toBe("muted");
    expect(orbMode(facts({ muted: true, state: "idle" }))).toBe("muted");
  });

  it("shows offline instead of a stale live state", () => {
    expect(orbMode(facts({ connected: false, state: "speaking" }))).toBe("offline");
    expect(orbMode(facts({ connected: false, state: "listening" }))).toBe("offline");
    expect(orbMode(facts({ connected: false, muted: true }))).toBe("offline");
  });

  it("surfaces a dead Hermes as an error even when the state looks calm", () => {
    expect(orbMode(facts({ state: "idle", hermesState: "failed" }))).toBe("error");
  });

  it("prefers connection truth over error, and error over mute", () => {
    expect(orbMode(facts({ connected: false, state: "error" }))).toBe("offline");
    expect(orbMode(facts({ state: "error", muted: true }))).toBe("error");
  });
});

describe("orb look", () => {
  it("gives every mode a distinct colour and a human label", () => {
    const modes = ["offline", "muted", "idle", "listening", "thinking", "speaking", "error"] as const;
    const colors = new Set<string>();
    for (const m of modes) {
      const look = orbLook(
        facts(
          m === "offline"
            ? { connected: false }
            : m === "muted"
              ? { muted: true }
              : m === "error"
                ? { state: "error" }
                : { state: m === "idle" ? "idle" : m },
        ),
      );
      expect(look.label.length, m).toBeGreaterThan(0);
      colors.add(look.color);
    }
    expect(colors.size).toBe(modes.length);
  });

  it("animates only when something is actually happening", () => {
    expect(orbLook(facts({ connected: false })).animation).toBe("none");
    expect(orbLook(facts({ muted: true })).animation).toBe("none");
    expect(orbLook(facts({ state: "error" })).animation).toBe("none");
    // Idle still breathes — it signals "alive and waiting", which is true.
    expect(orbLook(facts({ state: "idle" })).animation).toBe("breathe");
  });

  it("tells the user what to do when idle", () => {
    expect(orbLook(facts({ state: "idle" })).label).toMatch(/Jarvis/);
  });

  it("names the phrase the loaded model actually answers to", () => {
    // Telling the user to say "hey_jarvis" would be telling them the wrong thing.
    // The orb gets the shortest form it answers to: "Jarvis" is true for the
    // `hey_jarvis` model (measured — see wakeWordPhrases) and fits on one line.
    const look = orbLook(facts({ voiceState: "ready", capturing: true, wakeWord: "hey_jarvis" }));
    expect(look.mode).toBe("idle");
    expect(look.label).toBe("Say “Jarvis”");
  });

  it("falls back to Jarvis when there is no model to name", () => {
    expect(wakeWordPhrase(null)).toBe("Jarvis");
    expect(wakeWordPhrase(undefined)).toBe("Jarvis");
    expect(wakeWordPhrase("alexa")).toBe("Alexa");
    expect(wakeWordPhrase("hey-jarvis")).toBe("Hey Jarvis");
  });
});

describe("both wake phrases", () => {
  // The user's requirement: "jarvis" alone has to work as well as "hey jarvis".
  // The daemon does the work; this pins the copy that tells them so, and pins it
  // to not over-promise for a model where it would be untrue.
  it("offers the bare name and the full phrase, shortest first", () => {
    expect(wakeWordPhrases("hey_jarvis")).toEqual(["Jarvis", "Hey Jarvis"]);
    expect(wakeWordPhrases("hey-jarvis")).toEqual(["Jarvis", "Hey Jarvis"]);
    expect(wakeWordPhrases("okay_jarvis")).toEqual(["Jarvis", "Okay Jarvis"]);
  });

  it("offers only the full phrase for any other name", () => {
    // `NAME_CORE` in voice/daemon.py is "jarvis" and nothing else, so the
    // transcript path cannot recognise a bare "mycroft" — and the acoustic model
    // firing on one has never been measured. Both make this the honest answer.
    expect(wakeWordPhrases("alexa")).toEqual(["Alexa"]);
    expect(wakeWordPhrases("hey_mycroft")).toEqual(["Hey Mycroft"]);
    expect(wakeWordPhrases("jarvis")).toEqual(["Jarvis"]);
    expect(wakeWordPhrases(null)).toEqual(["Jarvis"]);
  });

  it("does not treat a non-filler first word as droppable", () => {
    // "Computer Jarvis" is not a phrase where "Jarvis" alone is known to work.
    expect(wakeWordPhrases("computer_jarvis")).toEqual(["Computer Jarvis"]);
  });
});

describe("orb honesty about the microphone", () => {
  // The rule these pin: "idle" promises the user that saying "Jarvis" will
  // work. That promise is only allowed when audio is genuinely being captured.
  const withVoice = (state: string, capturing: boolean, over: Partial<HudFacts> = {}) =>
    facts({ voiceState: state, capturing, ...over });

  it("stays idle when the daemon is really capturing", () => {
    expect(orbMode(withVoice("ready", true))).toBe("idle");
  });

  it("says deaf when the daemon is up but not capturing", () => {
    // A running process is not a working microphone.
    expect(orbMode(withVoice("ready", false))).toBe("deaf");
  });

  it("says deaf when the daemon failed or was never started", () => {
    expect(orbMode(withVoice("failed", false))).toBe("deaf");
    expect(orbMode(withVoice("stopped", false))).toBe("deaf");
  });

  it("still reads idle for a status that predates voice reporting", () => {
    // Old runtime, no voice field: absence of news is not "the mic is dead".
    expect(orbMode(facts({ state: "idle" }))).toBe("idle");
  });

  it("keeps the higher-priority truths above deafness", () => {
    expect(orbMode(withVoice("failed", false, { connected: false }))).toBe("offline");
    expect(orbMode(withVoice("failed", false, { muted: true }))).toBe("muted");
    expect(orbMode(withVoice("failed", false, { state: "thinking" }))).toBe("thinking");
    expect(orbMode(withVoice("failed", false, { state: "speaking" }))).toBe("speaking");
  });

  it("tells the user what still works instead of just going dark", () => {
    const look = orbLook(withVoice("failed", false));
    expect(look.mode).toBe("deaf");
    expect(look.label).toMatch(/type/i);
    expect(look.animation).toBe("none");
  });

  it("distinguishes loading models from voice being broken", () => {
    // One resolves itself in a few seconds; the other needs the user.
    for (const s of ["starting", "restarting"]) {
      const look = orbLook(withVoice(s, false));
      expect(look.label, s).toMatch(/starting/i);
      expect(look.animation, s).toBe("breathe");
    }
  });

  it("does not reuse the muted or offline colour for deafness", () => {
    // Three different problems; the user should be able to tell them apart.
    const deaf = orbLook(withVoice("failed", false)).color;
    expect(deaf).not.toBe(orbLook(facts({ muted: true })).color);
    expect(deaf).not.toBe(orbLook(facts({ connected: false })).color);
  });
});

describe("orbScale", () => {
  it("responds to microphone level only while listening", () => {
    expect(orbScale(0.8, "listening")).toBeCloseTo(1.28);
    expect(orbScale(0.8, "thinking")).toBe(1);
    expect(orbScale(0.8, "muted")).toBe(1);
  });

  it("clamps out-of-range and non-finite levels", () => {
    // An un-clamped RMS spike would throw the orb off-screen.
    expect(orbScale(50, "listening")).toBe(1.35);
    expect(orbScale(-4, "listening")).toBe(1);
    expect(orbScale(Number.NaN, "listening")).toBe(1);
    expect(orbScale(Number.POSITIVE_INFINITY, "listening")).toBe(1);
  });

  it("keeps the orb visible in silence", () => {
    expect(orbScale(0, "listening")).toBe(1);
  });
});

describe("canSubmit", () => {
  it("refuses to send while disconnected", () => {
    expect(canSubmit(facts({ connected: false }), "hello")).toBe(false);
  });

  it("refuses blank input", () => {
    expect(canSubmit(facts(), "   ")).toBe(false);
    expect(canSubmit(facts(), "")).toBe(false);
  });

  it("allows real input on a live link", () => {
    expect(canSubmit(facts(), "what time is it")).toBe(true);
  });
});
