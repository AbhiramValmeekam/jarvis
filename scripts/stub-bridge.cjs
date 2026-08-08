/**
 * A stub of the preload bridge, for screenshotting the HUD's live states.
 *
 * This exists only so `scripts/shot-renderer.mjs` can render what the user sees
 * when Jarvis is actually connected — idle, listening, thinking, speaking —
 * without needing a runtime and a microphone in the loop.
 *
 * It is never bundled into the app: the real bridge is src/desktop/preload.ts.
 */
const { contextBridge } = require("electron");

const state = process.env.JARVIS_SHOT_STATE || "idle";
const muted = process.env.JARVIS_SHOT_MUTED === "1";
const level = Number(process.env.JARVIS_SHOT_LEVEL || "0");

// A malformed env var must not take the whole bridge down with it — a preload
// that throws at module scope leaves the renderer with no `window.jarvis` and
// a confusing "offline" screenshot instead of an error.
let turns = [];
try {
  turns = JSON.parse(process.env.JARVIS_SHOT_TURNS || "[]");
} catch (err) {
  console.error(`[stub-bridge] JARVIS_SHOT_TURNS is not valid JSON: ${err.message}`);
}

const status = {
  protocolVersion: 1,
  state,
  startedAt: 0,
  hermes: {
    state: "ready",
    pid: 4242,
    sessionId: "sess-1",
    restartCount: 0,
    gaveUpReason: null,
  },
  subsystems: {
    wakeWord: { state: "unavailable", detail: "not implemented yet (Phase 3)" },
    stt: { state: "unavailable", detail: "not implemented yet (Phase 3)" },
    tts: { state: "unavailable", detail: "not implemented yet (Phase 3)" },
    hermes: { state: "available" },
  },
  listening: !muted,
  muted,
};

const handlers = [];

contextBridge.exposeInMainWorld("jarvis", {
  getStatus: async () => status,
  prompt: async () => {},
  cancel: async () => {},
  setListening: async () => {},
  setMuted: async () => {},
  restartHermes: async () => {},
  hideWindow: () => {},
  onEvent: (h) => {
    handlers.push(h);
    // Replay a scripted conversation plus a mic level, so the screenshot shows
    // the HUD as it looks mid-use rather than empty.
    setTimeout(() => {
      for (const t of turns) {
        if (t.role === "you") h({ type: "transcript", text: t.text, final: true });
        else h({ type: "reply_chunk", text: t.text });
      }
      if (turns.length) h({ type: "reply_done", stopReason: "end_turn" });
      if (level > 0) h({ type: "level", rms: level });
    }, 100);
    return () => {};
  },
  onLink: (h) => {
    setTimeout(() => h(true), 20);
    return () => {};
  },
});
