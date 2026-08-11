import { describe, it, expect } from "vitest";
import { eventWantsWindow } from "../src/desktop/event-window.js";
import type { ServerEvent } from "../src/ipc/contract.js";

/**
 * The §62 reboot defect, pinned.
 *
 * Reported after the manual reboot test: the tray icon appeared, but saying
 * "Jarvis" did nothing visible — the user had to click the tray, then say it a
 * second time. The cause was a `win?.` in main.ts: with no window, every event
 * was forwarded into the void, wake included. Nothing failed loudly, which is
 * why it shipped.
 */
describe("eventWantsWindow", () => {
  it("wakes the HUD when the runtime hears its name", () => {
    expect(eventWantsWindow({ type: "state", state: "wake_detected" })).toBe(true);
  });

  it("leaves the window alone for every other state", () => {
    // Especially `idle`: the wake timeout fires one of these a few seconds
    // after every unanswered wake, and it must not pop the HUD by itself.
    for (const state of ["idle", "listening", "thinking", "speaking", "conversation"]) {
      expect(eventWantsWindow({ type: "state", state })).toBe(false);
    }
  });

  it("leaves the window alone for the chatter that arrives constantly", () => {
    // These flow while Jarvis works. Raising a window on any of them would
    // make the shell steal focus mid-sentence, which is worse than the bug.
    const noise: ServerEvent[] = [
      { type: "transcript", text: "what time is it", final: false },
      { type: "reply_chunk", text: "It is " },
      { type: "reply_done", stopReason: "end_turn" },
      { type: "thought", text: "checking the clock" },
      { type: "tool_call", id: "t1", title: "read clock" },
    ];
    for (const e of noise) expect(eventWantsWindow(e)).toBe(false);
  });
});
