/**
 * A stub of the preload bridge, for screenshotting the HUD's live states.
 *
 * This exists only so `scripts/shot-renderer.mjs` can render what the user sees
 * when Jarvis is actually connected — idle, listening, thinking, speaking, and
 * the Command Center's five tabs — without needing a runtime, a microphone, or a
 * Hermes install in the loop.
 *
 * The Command Center fixtures below are deliberately the *unflattering* cases: a
 * scheduler that will not fire, a planted MCP server, and an `mcp_servers` block
 * this reader cannot parse. A screenshot of the healthy path proves the layout;
 * only these prove the honesty rules survive contact with a real DOM.
 *
 * It is never bundled into the app: the real bridge is src/desktop/preload.ts.
 */
const { contextBridge } = require("electron");

const state = process.env.JARVIS_SHOT_STATE || "idle";
const muted = process.env.JARVIS_SHOT_MUTED === "1";
const level = Number(process.env.JARVIS_SHOT_LEVEL || "0");
/** "healthy" flips the fixtures to the everything-is-fine variant. */
const healthy = process.env.JARVIS_SHOT_HEALTHY === "1";

// A malformed env var must not take the whole bridge down with it — a preload
// that throws at module scope leaves the renderer with no `window.jarvis` and
// a confusing "offline" screenshot instead of an error.
let turns = [];
try {
  turns = JSON.parse(process.env.JARVIS_SHOT_TURNS || "[]");
} catch (err) {
  console.error(`[stub-bridge] JARVIS_SHOT_TURNS is not valid JSON: ${err.message}`);
}

const NOW = Date.now();

const status = {
  protocolVersion: 1,
  state,
  startedAt: NOW - 3_600_000,
  hermes: {
    state: "ready",
    pid: 4242,
    sessionId: "sess-1",
    restartCount: 0,
    gaveUpReason: null,
  },
  voice: {
    state: "ready",
    pid: 4310,
    wakeWord: "jarvis",
    device: "Microphone (Realtek)",
    capturing: !muted,
    restartCount: 0,
    gaveUpReason: null,
  },
  subsystems: {
    wakeWord: { state: "available" },
    stt: { state: "available" },
    tts: { state: "available" },
    hermes: { state: "available" },
  },
  listening: !muted,
  muted,
};

/** Two jobs and a stalled ticker: every row must read as conditional. */
const tasks = {
  tasks: [
    {
      id: "job-morning",
      name: "morning digest",
      schedule: "every day at 08:00",
      kind: "cron",
      nextRunAt: NOW + 42 * 60_000,
      lastRunAt: NOW - 22 * 3_600_000,
      lastStatus: "ok",
      lastError: null,
    },
    {
      id: "job-backup",
      name: "verify nightly backup",
      schedule: "every 6h",
      kind: "interval",
      nextRunAt: NOW - 3 * 3_600_000,
      lastRunAt: NOW - 9 * 3_600_000,
      lastStatus: healthy ? "ok" : "error",
      lastError: healthy ? null : "exit 1: destination unreachable",
    },
  ],
  ticker: healthy ? "running" : "never-run",
  willFire: healthy,
  ...(healthy
    ? {}
    : {
        warning:
          "Hermes' scheduler has never run on this machine, so none of these will fire. " +
          "Run `hermes gateway install` in a terminal to start it at logon.",
      }),
};

/** A planted entry that must sort above the ordinary ones. */
const mcp = {
  servers: healthy
    ? [
        { name: "github", transport: "stdio", command: "npx", envNames: ["GITHUB_TOKEN"], enabled: true, suspicious: [] },
        { name: "filesystem", transport: "stdio", command: "npx", envNames: [], enabled: true, suspicious: [] },
      ]
    : [
        { name: "github", transport: "stdio", command: "npx", envNames: ["GITHUB_TOKEN"], enabled: true, suspicious: [] },
        {
          name: "updater",
          transport: "stdio",
          command: "bash",
          envNames: [],
          enabled: true,
          suspicious: ['"updater" runs `bash -c` and appends an SSH key to authorized_keys — a known backdoor shape.'],
        },
        { name: "old-notion", transport: "stdio", command: "node", envNames: [], enabled: false, suspicious: [] },
      ],
  configPresent: true,
  unparsed: false,
};

const memory = {
  entries: [
    { id: "m1", text: "deploy notes live in the ops repo, not the app repo", at: NOW - 4 * 86_400_000 },
    { id: "m2", text: "prefers metric units and 24-hour time", at: NOW - 2 * 3_600_000 },
    { id: "m3", text: "the staging database is in frankfurt", at: NOW - 40_000 },
  ],
  maxEntries: 200,
  hermes: { present: true, memoryEntries: 4, userEntries: 2, bytes: 2048 },
};

const skills = {
  skills: [
    { name: "computer-use", description: "Drive the desktop: click, type, and read the screen.", category: "", source: "bundled" },
    { name: "ml-model-porting", description: "Port a model between runtimes and verify parity.", category: "mlops", source: "bundled" },
    { name: "deploy-check", description: "Verify a deploy before it ships.", category: "ops", source: "user" },
  ],
  categories: [
    { category: "general", count: 1 },
    { category: "mlops", count: 1 },
    { category: "ops", count: 1 },
  ],
};

const activity = [
  {
    at: NOW - 5 * 60_000,
    tool: "read_file",
    level: 1,
    category: "read",
    verdict: "allow",
    reason: "Reading a file inside the current project",
    outcome: "verified",
  },
  {
    at: NOW - 3 * 60_000,
    tool: "shell",
    level: 5,
    category: "destructive",
    verdict: "deny",
    reason: "Recursive delete outside any project directory",
  },
  {
    at: NOW - 60_000,
    tool: "open_url",
    level: 2,
    category: "browse",
    verdict: "allow",
    reason: "Opening a dashboard the user named",
    outcome: "unchecked",
  },
];

const handlers = [];

contextBridge.exposeInMainWorld("jarvis", {
  getStatus: async () => status,
  getActivity: async () => activity,
  getTasks: async () => tasks,
  getMcp: async () => mcp,
  getMemory: async () => memory,
  getSkills: async () => skills,
  prompt: async () => {},
  cancel: async () => {},
  setListening: async () => {},
  setMuted: async () => {},
  restartHermes: async () => {},
  restartVoice: async () => {},
  pushToTalk: async () => {},
  say: async () => {},
  respondToPermission: async () => {},
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
