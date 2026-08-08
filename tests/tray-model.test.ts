import { describe, it, expect } from "vitest";
import {
  buildTrayView,
  pickIcon,
  hermesLabel,
  REQUIRED_ACTIONS,
  type TrayFacts,
  type TrayActionId,
} from "../src/desktop/tray-model.js";

const facts = (over: Partial<TrayFacts> = {}): TrayFacts => ({
  connected: true,
  state: "idle",
  hermes: {
    state: "ready",
    pid: 4242,
    sessionId: "sess-1",
    restartCount: 0,
    gaveUpReason: null,
  },
  listening: true,
  muted: false,
  autostart: { enabled: false, available: true },
  ...over,
});

const actionIds = (f: TrayFacts): TrayActionId[] =>
  buildTrayView(f)
    .menu.filter((e) => e.kind === "action")
    .map((e) => (e as { id: TrayActionId }).id);

const entry = (f: TrayFacts, id: TrayActionId) =>
  buildTrayView(f).menu.find((e) => e.kind === "action" && e.id === id) as
    | { kind: "action"; id: TrayActionId; label: string; enabled: boolean; checked?: boolean }
    | undefined;

describe("tray menu", () => {
  it("always offers the controls the security model requires", () => {
    // Under every combination the safety controls stay present.
    const combos: Partial<TrayFacts>[] = [
      {},
      { muted: true },
      { listening: false },
      { state: "thinking" },
      { state: "error" },
      { connected: false },
      { hermes: { ...facts().hermes, state: "failed", gaveUpReason: "crashed 3 times" } },
    ];
    for (const c of combos) {
      const ids = actionIds(facts(c));
      for (const required of REQUIRED_ACTIONS) {
        expect(ids, `${required} missing for ${JSON.stringify(c)}`).toContain(required);
      }
    }
  });

  it("keeps Quit clickable even when the runtime is unreachable", () => {
    // Otherwise a wedged runtime would leave no way to stop the app.
    const q = entry(facts({ connected: false }), "quit");
    expect(q?.enabled).toBe(true);
  });

  it("disables runtime-dependent actions while disconnected", () => {
    const f = facts({ connected: false });
    expect(entry(f, "toggle_listening")?.enabled).toBe(false);
    expect(entry(f, "toggle_muted")?.enabled).toBe(false);
    expect(entry(f, "restart_hermes")?.enabled).toBe(false);
    // The window is ours, not the runtime's.
    expect(entry(f, "toggle_window")?.enabled).toBe(true);
  });

  it("labels the listening toggle by what clicking it will do", () => {
    expect(entry(facts({ listening: true }), "toggle_listening")?.label).toBe("Pause Listening");
    expect(entry(facts({ listening: false }), "toggle_listening")?.label).toBe("Resume Listening");
  });

  it("labels the microphone toggle by what clicking it will do", () => {
    expect(entry(facts({ muted: false }), "toggle_muted")?.label).toBe("Disable Microphone");
    expect(entry(facts({ muted: true }), "toggle_muted")?.label).toBe("Enable Microphone");
  });

  it("reflects the real autostart state in the checkbox", () => {
    expect(entry(facts(), "toggle_autostart")?.checked).toBe(false);
    expect(
      entry(facts({ autostart: { enabled: true, available: true } }), "toggle_autostart")?.checked,
    ).toBe(true);
  });

  it("explains why autostart is unavailable rather than leaving a dead checkbox", () => {
    const f = facts({
      autostart: { enabled: false, available: false, reason: "needs a packaged build" },
    });
    const view = buildTrayView(f);

    expect(entry(f, "toggle_autostart")?.enabled).toBe(false);
    expect(view.menu.some((e) => e.kind === "status" && /packaged build/.test(e.text))).toBe(true);
  });

  it("says it is not connected instead of showing a stale idle state", () => {
    const view = buildTrayView(facts({ connected: false, state: "idle" }));
    expect(view.tooltip).toMatch(/Not connected/);
    expect(view.menu.some((e) => e.kind === "status" && /unreachable/.test(e.text))).toBe(true);
  });

  it("never renders two separators in a row or ends with one", () => {
    for (const c of [{}, { connected: false }, { autostart: { enabled: false, available: false } }]) {
      const menu = buildTrayView(facts(c)).menu;
      expect(menu.at(-1)?.kind).not.toBe("separator");
      for (let i = 1; i < menu.length; i++) {
        expect(
          menu[i]!.kind === "separator" && menu[i - 1]!.kind === "separator",
          `double separator at ${i}`,
        ).toBe(false);
      }
    }
  });
});

describe("tray icon", () => {
  it("maps each assistant state to a distinct visual", () => {
    expect(pickIcon(facts({ state: "idle" }))).toBe("idle");
    expect(pickIcon(facts({ state: "listening" }))).toBe("listening");
    expect(pickIcon(facts({ state: "wake_detected" }))).toBe("listening");
    expect(pickIcon(facts({ state: "thinking" }))).toBe("busy");
    expect(pickIcon(facts({ state: "executing" }))).toBe("busy");
    expect(pickIcon(facts({ state: "speaking" }))).toBe("speaking");
    expect(pickIcon(facts({ state: "error" }))).toBe("error");
  });

  it("shows muted over any working state, because the mic really is off", () => {
    expect(pickIcon(facts({ muted: true, state: "thinking" }))).toBe("muted");
    expect(pickIcon(facts({ muted: true, state: "idle" }))).toBe("muted");
  });

  it("shows error when Hermes has given up, even if the state looks idle", () => {
    const f = facts({
      state: "idle",
      hermes: { ...facts().hermes, state: "failed", gaveUpReason: "gave up after 3 restarts" },
    });
    expect(pickIcon(f)).toBe("error");
  });

  it("offline outranks everything — a stale state is not shown as live", () => {
    expect(pickIcon(facts({ connected: false, state: "speaking" }))).toBe("offline");
    expect(pickIcon(facts({ connected: false, muted: true }))).toBe("offline");
  });
});

describe("hermesLabel", () => {
  it("includes the pid when running, so the user can verify it", () => {
    expect(hermesLabel({ state: "ready", pid: 1234, sessionId: "s", restartCount: 0, gaveUpReason: null }))
      .toBe("Hermes: running (pid 1234)");
  });

  it("surfaces the give-up reason instead of just saying stopped", () => {
    expect(
      hermesLabel({
        state: "failed",
        pid: null,
        sessionId: null,
        restartCount: 3,
        gaveUpReason: "gave up after 3 restarts in 60s",
      }),
    ).toMatch(/gave up after 3 restarts/);
  });

  it("distinguishes sleep-suspended from crashed", () => {
    const s = hermesLabel({ state: "suspended", pid: null, sessionId: null, restartCount: 0, gaveUpReason: null });
    expect(s).toMatch(/suspended/);
    expect(s).not.toMatch(/stopped/);
  });
});
