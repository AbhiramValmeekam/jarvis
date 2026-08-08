/**
 * The tray's contents, as pure data.
 *
 * The tray is the always-reachable control surface: it exists before any window
 * does, survives every window close, and must keep the two controls the
 * security model requires one click away (SECURITY_MODEL.md — Pause Listening,
 * Disable Microphone) plus Quit, which is the only way to stop the assistant.
 *
 * This file has no Electron import on purpose. It turns a runtime status into a
 * menu description; `tray.ts` renders that description. Logic proven by tests,
 * reality proven by probes — the same split used everywhere else here.
 */
import type { RuntimeStatus } from "../ipc/contract.js";

export type TrayActionId =
  | "toggle_window"
  | "toggle_listening"
  | "toggle_muted"
  | "restart_hermes"
  | "toggle_autostart"
  | "quit";

export type TrayMenuEntry =
  | {
      kind: "action";
      id: TrayActionId;
      label: string;
      enabled: boolean;
      checked?: boolean;
    }
  /** Non-clickable informational row. */
  | { kind: "status"; text: string }
  | { kind: "separator" };

export type TrayIcon =
  | "idle"
  | "listening"
  | "busy"
  | "speaking"
  | "muted"
  | "error"
  | "offline";

export interface TrayView {
  icon: TrayIcon;
  tooltip: string;
  menu: TrayMenuEntry[];
}

/** Everything the tray needs to render. */
export interface TrayFacts {
  /** False when the UI is not attached to a runtime at all. */
  connected: boolean;
  state: string;
  hermes: RuntimeStatus["hermes"];
  listening: boolean;
  muted: boolean;
  autostart: { enabled: boolean; available: boolean; reason?: string };
}

const STATE_LABEL: Record<string, string> = {
  idle: "Idle — say “Jarvis”",
  wake_detected: "Wake word heard",
  listening: "Listening…",
  understanding: "Understanding…",
  local_action: "Running a local action…",
  thinking: "Thinking…",
  executing: "Executing…",
  speaking: "Speaking…",
  conversation: "In conversation",
  error: "Error — needs attention",
};

/** States where Jarvis is actively working on the user's behalf. */
const BUSY_STATES = new Set([
  "understanding",
  "local_action",
  "thinking",
  "executing",
]);

export function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? state;
}

export function hermesLabel(hermes: RuntimeStatus["hermes"]): string {
  switch (hermes.state) {
    case "ready":
      return hermes.pid ? `Hermes: running (pid ${hermes.pid})` : "Hermes: running";
    case "starting":
    case "restarting":
      return "Hermes: starting…";
    case "suspended":
      return "Hermes: suspended (system sleep)";
    case "failed":
      return `Hermes: stopped — ${hermes.gaveUpReason ?? "gave up restarting"}`;
    case "stopped":
      return "Hermes: stopped";
    default:
      return `Hermes: ${hermes.state}`;
  }
}

export function pickIcon(f: TrayFacts): TrayIcon {
  if (!f.connected) return "offline";
  if (f.state === "error" || f.hermes.state === "failed") return "error";
  if (f.muted) return "muted";
  if (f.state === "speaking") return "speaking";
  if (f.state === "listening" || f.state === "wake_detected") return "listening";
  if (BUSY_STATES.has(f.state)) return "busy";
  return "idle";
}

/**
 * Build the tray view.
 *
 * Disconnected is rendered as its own thing rather than as a stale snapshot:
 * showing "Idle" while the runtime is unreachable would be exactly the kind of
 * pretending the project rules forbid.
 */
export function buildTrayView(f: TrayFacts): TrayView {
  const label = f.connected ? stateLabel(f.state) : "Not connected to the runtime";

  const menu: TrayMenuEntry[] = [
    { kind: "status", text: label },
    { kind: "status", text: f.connected ? hermesLabel(f.hermes) : "Runtime: unreachable" },
    { kind: "separator" },
    { kind: "action", id: "toggle_window", label: "Show Jarvis", enabled: true },
    { kind: "separator" },
    {
      kind: "action",
      id: "toggle_listening",
      label: f.listening ? "Pause Listening" : "Resume Listening",
      enabled: f.connected,
      checked: f.listening,
    },
    {
      kind: "action",
      id: "toggle_muted",
      label: f.muted ? "Enable Microphone" : "Disable Microphone",
      enabled: f.connected,
      checked: f.muted,
    },
    { kind: "separator" },
    {
      kind: "action",
      id: "restart_hermes",
      label: "Restart Hermes",
      enabled: f.connected,
    },
    {
      kind: "action",
      id: "toggle_autostart",
      label: "Start with Windows",
      enabled: f.autostart.available,
      checked: f.autostart.enabled,
    },
  ];

  // When autostart cannot work, say why instead of leaving a dead checkbox.
  if (!f.autostart.available && f.autostart.reason) {
    menu.push({ kind: "status", text: f.autostart.reason });
  }

  menu.push(
    { kind: "separator" },
    { kind: "action", id: "quit", label: "Quit Jarvis", enabled: true },
  );

  return { icon: pickIcon(f), tooltip: `Jarvis — ${label}`, menu };
}

/** The controls the security model requires to be always reachable. */
export const REQUIRED_ACTIONS: readonly TrayActionId[] = [
  "toggle_listening",
  "toggle_muted",
  "quit",
];
