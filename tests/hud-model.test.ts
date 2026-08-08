import { describe, it, expect } from "vitest";
import {
  orbMode,
  orbLook,
  orbScale,
  canSubmit,
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
