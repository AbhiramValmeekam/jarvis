/**
 * Start-with-Windows support.
 *
 * Uses the per-user Run key:
 *   HKCU\Software\Microsoft\Windows\CurrentVersion\Run
 *
 * Why this key and not the alternatives:
 *   - HKCU needs no administrator rights, so enabling autostart never prompts
 *     for elevation and never touches machine-wide state.
 *   - HKLM\...\Run would affect every user on the machine and require admin.
 *   - Task Scheduler can run before logon, which Jarvis must not do: it needs
 *     an interactive session for audio and the tray.
 *
 * Deliberately NOT done here: nothing is written at import time or on first
 * run. Autostart is a system change, so it happens only when the user asks —
 * via the tray toggle or the installer. `isEnabled()` is safe to call freely.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const DEFAULT_ENTRY_NAME = "Jarvis";

/** Runs a command and returns stdout. Injected in tests. */
export type Exec = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface AutostartOptions {
  /** Registry value name. */
  entryName?: string;
  exec?: Exec;
  platform?: NodeJS.Platform;
}

export interface AutostartState {
  supported: boolean;
  enabled: boolean;
  /** The command Windows would run, when enabled. */
  command: string | null;
  /** Why it is unsupported or could not be read. */
  detail?: string;
}

/**
 * Quote a command for the Run key.
 *
 * Paths containing spaces (`C:\Program Files\...`) must be quoted or Windows
 * runs the wrong executable — the classic unquoted-service-path mistake. Any
 * embedded quote is stripped rather than escaped, because a quote in a launch
 * path is far more likely to be an injection attempt than a real filename.
 */
export function buildLaunchCommand(exePath: string, args: string[] = []): string {
  const clean = (s: string) => s.replace(/"/g, "");
  const parts = [`"${clean(exePath)}"`, ...args.map((a) => `"${clean(a)}"`)];
  return parts.join(" ");
}

export class AutostartManager {
  private readonly entryName: string;
  private readonly exec: Exec;
  private readonly platform: NodeJS.Platform;

  constructor(options: AutostartOptions = {}) {
    this.entryName = options.entryName ?? DEFAULT_ENTRY_NAME;
    this.exec =
      options.exec ??
      ((file, args) => execFileAsync(file, args, { windowsHide: true }));
    this.platform = options.platform ?? process.platform;
  }

  get isSupported(): boolean {
    return this.platform === "win32";
  }

  /** Read the current state. Never modifies anything. */
  async getState(): Promise<AutostartState> {
    if (!this.isSupported) {
      return {
        supported: false,
        enabled: false,
        command: null,
        detail: `start-with-Windows is only implemented for win32 (running ${this.platform})`,
      };
    }

    try {
      const { stdout } = await this.exec("reg", [
        "query",
        RUN_KEY,
        "/v",
        this.entryName,
      ]);
      const command = parseRegQueryValue(stdout, this.entryName);
      return {
        supported: true,
        enabled: command !== null,
        command,
      };
    } catch (err) {
      // `reg query` exits non-zero when the value is absent, which is the
      // normal "not enabled" case rather than a failure.
      const msg = err instanceof Error ? err.message : String(err);
      if (/unable to find|cannot find|ERROR: The system was unable/i.test(msg)) {
        return { supported: true, enabled: false, command: null };
      }
      return {
        supported: true,
        enabled: false,
        command: null,
        detail: `could not read ${RUN_KEY}: ${msg}`,
      };
    }
  }

  async isEnabled(): Promise<boolean> {
    return (await this.getState()).enabled;
  }

  /**
   * Enable start-with-Windows.
   *
   * `command` should already include any flags needed to start minimised —
   * see `src/desktop/launch.ts` for the canonical launch command.
   */
  async enable(command: string): Promise<void> {
    this.assertSupported();
    if (!command.trim()) throw new Error("autostart command must not be empty");
    await this.exec("reg", [
      "add",
      RUN_KEY,
      "/v",
      this.entryName,
      "/t",
      "REG_SZ",
      "/d",
      command,
      "/f",
    ]);
  }

  async disable(): Promise<void> {
    this.assertSupported();
    try {
      await this.exec("reg", ["delete", RUN_KEY, "/v", this.entryName, "/f"]);
    } catch (err) {
      // Already absent is success, not an error.
      const msg = err instanceof Error ? err.message : String(err);
      if (/unable to find|cannot find/i.test(msg)) return;
      throw err;
    }
  }

  async setEnabled(enabled: boolean, command?: string): Promise<void> {
    if (!enabled) return this.disable();
    if (!command) throw new Error("enabling autostart requires a command");
    return this.enable(command);
  }

  private assertSupported(): void {
    if (!this.isSupported) {
      throw new Error(
        `start-with-Windows is only implemented for win32 (running ${this.platform})`,
      );
    }
  }
}

/**
 * Pull a value out of `reg query` output.
 *
 * Format is a header line, a blank line, then indented `name  TYPE  data`
 * rows. Data may contain spaces, so only the first two columns are split off.
 */
export function parseRegQueryValue(stdout: string, name: string): string | null {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("HKEY_")) continue;
    const match = line.match(/^(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/);
    if (!match) continue;
    const [, foundName, , data] = match;
    if (foundName?.toLowerCase() !== name.toLowerCase()) continue;
    const value = (data ?? "").trim();
    return value.length > 0 ? value : null;
  }
  return null;
}
