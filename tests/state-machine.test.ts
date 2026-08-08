import { describe, it, expect, vi } from "vitest";
import {
  AssistantStateMachine,
  type AssistantEvent,
  type AssistantState,
} from "../src/runtime/state-machine.js";

/** Machine with controllable timers so the 30s window is testable instantly. */
function makeMachine(opts = {}) {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const sm = new AssistantStateMachine({
    conversationMs: 30_000,
    wakeTimeoutMs: 6_000,
    setTimer: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      timers.push(entry);
      return entry as unknown as NodeJS.Timeout;
    },
    clearTimer: (t) => {
      (t as unknown as { cancelled: boolean }).cancelled = true;
    },
    ...opts,
  });
  const fireLast = () => {
    const live = timers.filter((t) => !t.cancelled);
    const last = live[live.length - 1];
    if (!last) throw new Error("no armed timer");
    last.cancelled = true;
    last.fn();
  };
  return { sm, timers, fireLast };
}

/** Drive the machine to a given state through the normal happy path. */
function driveTo(sm: AssistantStateMachine, target: AssistantState): void {
  const path: AssistantEvent[] = [
    "wake",
    "speech_start",
    "speech_end",
    "route_agent",
    "execute",
    "speak",
    "spoken",
  ];
  for (const e of path) {
    if (sm.state === target) return;
    sm.handle(e);
  }
  if (sm.state !== target) throw new Error(`could not reach ${target}`);
}

describe("AssistantStateMachine", () => {
  it("starts idle", () => {
    const { sm } = makeMachine();
    expect(sm.state).toBe("idle");
    expect(sm.isIdle).toBe(true);
  });

  it("walks the documented happy path", () => {
    const { sm } = makeMachine();
    const seen: string[] = [];
    sm.on("state", (s: string) => seen.push(s));

    sm.handle("wake");
    sm.handle("speech_start");
    sm.handle("speech_end");
    sm.handle("route_agent");
    sm.handle("execute");
    sm.handle("speak");
    sm.handle("spoken");

    expect(seen).toEqual([
      "wake_detected",
      "listening",
      "understanding",
      "thinking",
      "executing",
      "speaking",
      "conversation",
    ]);
  });

  it("routes trivial commands through LOCAL_ACTION, skipping THINKING", () => {
    const { sm } = makeMachine();
    sm.handle("wake");
    sm.handle("speech_start");
    sm.handle("speech_end");
    sm.handle("route_local");

    expect(sm.state).toBe("local_action");
    sm.handle("speak");
    expect(sm.state).toBe("speaking");
  });

  it("leaves SPEAKING only when playback actually ends", () => {
    const { sm } = makeMachine();
    driveTo(sm, "speaking");

    // The events that mean "audio was handed off" must NOT end the state.
    for (const e of ["speak", "execute", "route_agent"] as AssistantEvent[]) {
      sm.handle(e);
      expect(sm.state).toBe("speaking");
    }

    sm.handle("spoken");
    expect(sm.state).toBe("conversation");
  });

  it("accepts follow-ups during the conversation window without a wake word", () => {
    const { sm } = makeMachine();
    driveTo(sm, "conversation");

    sm.handle("speech_start");
    expect(sm.state).toBe("listening");
  });

  it("closes the conversation window after the configured 30s", () => {
    const { sm, timers, fireLast } = makeMachine();
    driveTo(sm, "conversation");

    const armed = timers.filter((t) => !t.cancelled).at(-1);
    expect(armed?.ms).toBe(30_000);

    fireLast();
    expect(sm.state).toBe("idle");
    expect(sm.isIdle).toBe(true);
  });

  it("returns to idle if a wake word is followed by silence", () => {
    const { sm, timers, fireLast } = makeMachine();
    sm.handle("wake");

    const armed = timers.filter((t) => !t.cancelled).at(-1);
    expect(armed?.ms).toBe(6_000);

    fireLast();
    expect(sm.state).toBe("idle");
  });

  it("cancels the conversation timer when a follow-up begins", () => {
    const { sm, timers } = makeMachine();
    driveTo(sm, "conversation");
    const conversationTimer = timers.at(-1)!;

    sm.handle("speech_start");

    expect(conversationTimer.cancelled).toBe(true);
  });

  it("lets barge-in interrupt from every active state", () => {
    const states: AssistantState[] = [
      "wake_detected",
      "listening",
      "understanding",
      "thinking",
      "executing",
      "speaking",
      "conversation",
    ];
    for (const s of states) {
      const { sm } = makeMachine();
      driveTo(sm, s);
      expect(sm.state).toBe(s);

      const t = sm.handle("barge_in");
      expect(t, `barge_in should be legal from ${s}`).not.toBeNull();
      expect(sm.state).toBe("listening");
    }
  });

  it("ignores barge-in when idle — there is nothing to interrupt", () => {
    const { sm } = makeMachine();
    const rejected = vi.fn();
    sm.on("rejected", rejected);

    expect(sm.handle("barge_in")).toBeNull();
    expect(sm.state).toBe("idle");
    expect(rejected).toHaveBeenCalledWith({ from: "idle", event: "barge_in" });
  });

  it("ignores illegal events instead of crashing, but reports them", () => {
    const { sm } = makeMachine();
    const rejected = vi.fn();
    sm.on("rejected", rejected);

    // A late VAD callback arriving while idle.
    expect(sm.handle("speech_end")).toBeNull();
    expect(sm.state).toBe("idle");
    expect(rejected).toHaveBeenCalledOnce();
  });

  it("ignores a duplicate wake detection mid-turn", () => {
    const { sm } = makeMachine();
    sm.handle("wake");
    sm.handle("speech_start");

    expect(sm.handle("wake")).toBeNull();
    expect(sm.state).toBe("listening");
  });

  it("routes errors to the error state and recovers", () => {
    const { sm } = makeMachine();
    driveTo(sm, "thinking");

    sm.handle("error");
    expect(sm.state).toBe("error");

    // Must not silently resume a turn from the error state.
    expect(sm.handle("execute")).toBeNull();

    sm.handle("recover");
    expect(sm.state).toBe("idle");
  });

  it("cancel returns to idle from any active state", () => {
    const states: AssistantState[] = [
      "wake_detected",
      "listening",
      "understanding",
      "thinking",
      "executing",
      "speaking",
      "conversation",
    ];
    for (const s of states) {
      const { sm } = makeMachine();
      driveTo(sm, s);
      sm.handle("cancel");
      expect(sm.state, `cancel from ${s}`).toBe("idle");
    }
  });

  it("reset clears pending timers and returns to idle", () => {
    const { sm, timers } = makeMachine();
    driveTo(sm, "conversation");
    const timer = timers.at(-1)!;

    sm.reset();

    expect(sm.state).toBe("idle");
    expect(timer.cancelled).toBe(true);
  });

  it("arms no timer in idle, keeping the idle budget honest", () => {
    const { sm, timers } = makeMachine();
    driveTo(sm, "conversation");
    sm.handle("timeout");

    expect(sm.state).toBe("idle");
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(0);
  });

  it("canHandle agrees with handle", () => {
    const { sm } = makeMachine();
    expect(sm.canHandle("wake")).toBe(true);
    expect(sm.canHandle("spoken")).toBe(false);
    expect(sm.canHandle("barge_in")).toBe(false);

    sm.handle("wake");
    expect(sm.canHandle("speech_start")).toBe(true);
    expect(sm.canHandle("barge_in")).toBe(true);
  });

  it("supports push-to-talk, bypassing the wake word", () => {
    const { sm } = makeMachine();
    sm.handle("speech_start");
    expect(sm.state).toBe("listening");
  });

  it("accepts typed input without a wake word or any audio", () => {
    const { sm } = makeMachine();
    sm.handle("text_input");
    expect(sm.state).toBe("understanding");

    sm.handle("route_agent");
    expect(sm.state).toBe("thinking");
  });

  it("ends a typed turn at conversation, with no speaking step", () => {
    const { sm } = makeMachine();
    const seen: string[] = [];
    sm.on("state", (s: string) => seen.push(s));

    sm.handle("text_input");
    sm.handle("route_agent");
    sm.handle("done");

    expect(seen).toEqual(["understanding", "thinking", "conversation"]);
    // Crucially it never claimed to be speaking when there was no audio.
    expect(seen).not.toContain("speaking");
  });

  it("accepts a typed follow-up during the conversation window", () => {
    const { sm } = makeMachine();
    driveTo(sm, "conversation");

    sm.handle("text_input");
    expect(sm.state).toBe("understanding");
  });

  it("finishes a local action with no reply to speak", () => {
    const { sm } = makeMachine();
    sm.handle("text_input");
    sm.handle("route_local");
    sm.handle("done");
    expect(sm.state).toBe("conversation");
  });

  it("rejects typed input mid-turn", () => {
    const { sm } = makeMachine();
    driveTo(sm, "thinking");
    expect(sm.handle("text_input")).toBeNull();
    expect(sm.state).toBe("thinking");
  });
});
