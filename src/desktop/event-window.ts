import type { ServerEvent } from "../ipc/contract.js";

/**
 * A received runtime event may demand the shell's main window.
 *
 * This is a decision the Electron main process has to make on every event, and
 * it is the one that cost the §62 reboot test: after a reboot the shell starts
 * minimized, `win` is null, and every event used to be forwarded into the void.
 * The wake state is the event that must be able to *create* the window — the
 * user says the name and the HUD has to appear, minimised launch or not. It is
 * kept out of main.ts so the rule can be pinned by a test; main.ts just calls
 * `showWindow()` when this says so.
 */
export function eventWantsWindow(e: ServerEvent): boolean {
  return e.type === "state" && e.state === "wake_detected";
}
