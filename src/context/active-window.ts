/**
 * Reading the foreground window.
 *
 * The only file in Phase 6 that touches Win32. Everything it produces goes
 * through `window-facts`, which is where the redaction and trust rules live and
 * where they are tested; this file's job is to get the raw values and to fail
 * honestly when it cannot.
 *
 * **Pulled, never streamed.** There is no polling loop and no subscription here.
 * A caller asks, once, and gets one answer. §50 forbids secretly streaming audio,
 * and the same principle applies with more force to the screen: a background
 * process sampling every window title you open, forever, is surveillance whatever
 * it is called. `read()` runs when something asks a question that needs it.
 *
 * **A short cache, for a different reason than performance.** Two questions in
 * the same breath ("what am I looking at" → "summarise it") should see one
 * window, not two — and spawning PowerShell twice for one utterance also costs
 * about a second. The TTL is small enough that a stale answer cannot outlive the
 * user's attention.
 *
 * The script is a fixed constant. Nothing derived from an utterance, a model, or
 * a window title is ever concatenated into it.
 */
import { execFile } from "node:child_process";
import { encodePwsh } from "../local-intents/executors.js";
import { toWindowFacts, type RawWindow, type WindowFacts } from "./window-facts.js";

/** Long enough to join two questions in one breath; too short to go stale. */
export const CACHE_MS = 1_500;
const TIMEOUT_MS = 5_000;

/**
 * `GetForegroundWindow` plus the owning process.
 *
 * `$ProgressPreference` is silenced because PowerShell writes its progress
 * stream to stderr as CLIXML, which a caller reading stderr for errors would
 * otherwise report as one. `[Console]::OutputEncoding` is forced to UTF-8
 * because without it the console codepage mangles anything non-ASCII — a real
 * title on this machine came back with its first character replaced by `?`, and
 * a mangled title is a wrong fact, not a cosmetic one.
 *
 * `GetWindowTextW` is the wide version explicitly. The ANSI one would produce
 * the same class of silent corruption inside the API rather than at the console.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Language CSharp @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class JarvisFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string Title(IntPtr h) {
    var sb = new StringBuilder(1024);
    GetWindowTextW(h, sb, 1024);
    return sb.ToString();
  }
}
'@
$h = [JarvisFg]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { '{"none":true}'; exit 0 }
$owner = 0
[void][JarvisFg]::GetWindowThreadProcessId($h, [ref]$owner)
$p = Get-Process -Id $owner -ErrorAction SilentlyContinue
[pscustomobject]@{
  title = [JarvisFg]::Title($h)
  pid = $owner
  process = if ($p) { $p.ProcessName } else { '' }
} | ConvertTo-Json -Compress
`;

export type WindowRead =
  | { ok: true; window: WindowFacts }
  /**
   * Nothing is focused, which is a real state — the lock screen, a desktop with
   * no windows. Distinct from a failure, because "I could not tell" and "there
   * is nothing there" are different answers and only one is an apology.
   */
  | { ok: true; window: null }
  | { ok: false; reason: string };

export interface ActiveWindowDeps {
  run?(file: string, args: readonly string[]): Promise<string>;
  now?(): number;
}

export class ActiveWindow {
  private cached: { at: number; result: WindowRead } | null = null;
  private inflight: Promise<WindowRead> | null = null;
  private readonly run: (file: string, args: readonly string[]) => Promise<string>;
  private readonly now: () => number;

  constructor(deps: ActiveWindowDeps = {}) {
    this.run = deps.run ?? defaultRun;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Forget the cached answer. Used when the caller knows focus moved. */
  invalidate(): void {
    this.cached = null;
  }

  async read(): Promise<WindowRead> {
    const fresh = this.cached && this.now() - this.cached.at < CACHE_MS;
    if (fresh && this.cached) return this.cached.result;
    // Two callers in the same tick share one PowerShell rather than racing to
    // spawn two — which would also let them disagree about the same instant.
    if (this.inflight) return this.inflight;

    this.inflight = this.readUncached()
      .then((result) => {
        this.cached = { at: this.now(), result };
        return result;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async readUncached(): Promise<WindowRead> {
    let stdout: string;
    try {
      stdout = await this.run("powershell.exe", encodePwsh(SCRIPT));
    } catch (err) {
      // Reported, not swallowed into "no window". The caller needs to be able
      // to say "I could not check" rather than "nothing is focused".
      return { ok: false, reason: describe(err) };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return { ok: false, reason: "could not parse the window read" };
    }
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, reason: "the window read returned nothing usable" };
    }

    const o = parsed as Record<string, unknown>;
    if (o["none"] === true) return { ok: true, window: null };

    const raw: RawWindow = {
      title: typeof o["title"] === "string" ? o["title"] : "",
      pid: typeof o["pid"] === "number" ? o["pid"] : 0,
      process: typeof o["process"] === "string" ? o["process"] : "",
      path: null,
    };
    // A window with no owning process is not a window we can describe honestly.
    if (!raw.process) return { ok: true, window: null };
    return { ok: true, window: toWindowFacts(raw) };
  }
}

function defaultRun(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
