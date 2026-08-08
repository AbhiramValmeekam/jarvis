/**
 * Where Windows should point when it starts Jarvis at logon.
 *
 * The subtlety: a dev run is `electron.exe <project>`, whose `execPath` is
 * `node_modules/electron/dist/electron.exe`. Registering that would produce an
 * autostart entry that launches a bare Electron with no app — it would appear
 * to work, then break the moment node_modules is reinstalled or the project
 * moves. So autostart is only offered for a packaged build, and in dev we say
 * plainly that it is unavailable instead of registering something broken.
 */
import { buildLaunchCommand } from "../system/autostart.js";

/** The flag that tells a fresh instance to come up in the tray, not on screen. */
export const START_MINIMIZED_FLAG = "--minimized";

/**
 * The flag that makes a packaged build run as the headless runtime instead of
 * the desktop shell.
 *
 * A packaged app ships one executable. The shell needs to start the runtime,
 * and re-launching itself with this flag is how it does that without shipping
 * a second binary or a Node install.
 */
export const RUNTIME_MODE_FLAG = "--runtime";

export interface LaunchContext {
  /** `process.execPath`. */
  execPath: string;
  /** Electron's `app.isPackaged`. */
  isPackaged: boolean;
}

export type LaunchTarget =
  | { available: true; command: string }
  | { available: false; reason: string };

export function resolveAutostartCommand(ctx: LaunchContext): LaunchTarget {
  if (!ctx.isPackaged) {
    return {
      available: false,
      reason:
        "start-with-Windows needs a packaged build — a development run has no stable executable to register",
    };
  }
  if (!ctx.execPath) {
    return { available: false, reason: "could not determine the executable path" };
  }
  return {
    available: true,
    command: buildLaunchCommand(ctx.execPath, [START_MINIMIZED_FLAG]),
  };
}

/** True when this process was launched by the autostart entry. */
export function startedMinimized(argv: readonly string[]): boolean {
  return argv.includes(START_MINIMIZED_FLAG);
}

/**
 * True when this process should be the headless runtime, not the shell.
 *
 * Checked before Electron sets up any window, so a runtime-mode launch never
 * flashes a UI or claims the shell's single-instance lock.
 */
export function isRuntimeMode(argv: readonly string[]): boolean {
  return argv.includes(RUNTIME_MODE_FLAG);
}
