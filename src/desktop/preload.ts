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
import type { RuntimeStatus, ServerEvent } from "../ipc/contract.js";

export type UiBridge = {
  getStatus(): Promise<RuntimeStatus | null>;
  prompt(text: string): Promise<void>;
  cancel(): Promise<void>;
  setListening(enabled: boolean): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  restartHermes(): Promise<void>;
  hideWindow(): void;
  /** Subscribe to runtime events. Returns an unsubscribe function. */
  onEvent(handler: (event: ServerEvent) => void): () => void;
  /** Connection state of the UI↔runtime link. */
  onLink(handler: (linked: boolean) => void): () => void;
};

const bridge: UiBridge = {
  getStatus: () => ipcRenderer.invoke("jarvis:get-status"),
  prompt: (text: string) => ipcRenderer.invoke("jarvis:prompt", String(text)),
  cancel: () => ipcRenderer.invoke("jarvis:cancel"),
  setListening: (enabled: boolean) =>
    ipcRenderer.invoke("jarvis:set-listening", Boolean(enabled)),
  setMuted: (muted: boolean) => ipcRenderer.invoke("jarvis:set-muted", Boolean(muted)),
  restartHermes: () => ipcRenderer.invoke("jarvis:restart-hermes"),
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
