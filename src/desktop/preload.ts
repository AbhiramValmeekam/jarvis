/**
 * Preload bridge.
 *
 * The renderer is the least-trusted part of the desktop app: it renders model
 * output and, later, web content. It therefore gets no Node access at all
 * (`contextIsolation: true`, `nodeIntegration: false`) and can only reach the
 * runtime through the narrow, explicitly enumerated surface below.
 *
 * Note what is NOT here: no arbitrary `invoke`, no channel name taken from the
 * renderer, no filesystem, no shell. A prompt-injection payload rendered in the
 * HUD can only do what this file allows, and this file allows nothing that
 * isn't already a user-initiated assistant action.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { ActivityEntry, RuntimeStatus, ServerEvent } from "../ipc/contract.js";

export type UiBridge = {
  getStatus(): Promise<RuntimeStatus | null>;
  /** The decision backlog, for a HUD that attached after the fact. */
  getActivity(): Promise<readonly ActivityEntry[]>;
  prompt(text: string): Promise<void>;
  cancel(): Promise<void>;
  setListening(enabled: boolean): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  restartHermes(): Promise<void>;
  restartVoice(): Promise<void>;
  /** Hold-to-talk. `down` is the key state, not a toggle. */
  pushToTalk(down: boolean): Promise<void>;
  say(text: string): Promise<void>;
  /**
   * Answer an outstanding permission request.
   *
   * The decision is a fixed enum, not a free string, and the runtime rejects a
   * requestId it did not issue — so the worst a compromised renderer can do is
   * answer a question the user was already being asked, which it could do by
   * drawing a fake button anyway. It cannot invent a grant for anything else.
   */
  respondToPermission(
    requestId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ): Promise<void>;
  hideWindow(): void;
  /** Subscribe to runtime events. Returns an unsubscribe function. */
  onEvent(handler: (event: ServerEvent) => void): () => void;
  /** Connection state of the UI↔runtime link. */
  onLink(handler: (linked: boolean) => void): () => void;
};

const bridge: UiBridge = {
  getStatus: () => ipcRenderer.invoke("jarvis:get-status"),
  getActivity: () => ipcRenderer.invoke("jarvis:get-activity"),
  prompt: (text: string) => ipcRenderer.invoke("jarvis:prompt", String(text)),
  cancel: () => ipcRenderer.invoke("jarvis:cancel"),
  setListening: (enabled: boolean) =>
    ipcRenderer.invoke("jarvis:set-listening", Boolean(enabled)),
  setMuted: (muted: boolean) => ipcRenderer.invoke("jarvis:set-muted", Boolean(muted)),
  restartHermes: () => ipcRenderer.invoke("jarvis:restart-hermes"),
  restartVoice: () => ipcRenderer.invoke("jarvis:restart-voice"),
  pushToTalk: (down: boolean) => ipcRenderer.invoke("jarvis:push-to-talk", Boolean(down)),
  say: (text: string) => ipcRenderer.invoke("jarvis:say", String(text)),
  respondToPermission: (requestId, decision) =>
    // Coerced here as well as validated in main: the renderer is the untrusted
    // side, so nothing but a string and one of three literals crosses over.
    ipcRenderer.invoke("jarvis:permission-response", String(requestId), String(decision)),
  hideWindow: () => ipcRenderer.send("jarvis:hide-window"),

  onEvent(handler) {
    const listener = (_e: unknown, payload: ServerEvent) => handler(payload);
    ipcRenderer.on("jarvis:event", listener);
    return () => ipcRenderer.off("jarvis:event", listener);
  },

  onLink(handler) {
    const listener = (_e: unknown, linked: boolean) => handler(linked);
    ipcRenderer.on("jarvis:link", listener);
    return () => ipcRenderer.off("jarvis:link", listener);
  },
};

contextBridge.exposeInMainWorld("jarvis", bridge);
