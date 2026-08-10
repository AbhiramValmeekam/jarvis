/**
 * Carrying out a matched local intent.
 *
 * This is the only file in Phase 4 that touches the machine, which makes it the
 * only one that can do damage. Three rules shape all of it:
 *
 * 1. **No shell, ever.** Every call is `execFile` with an argv array, so there
 *    is no string for a quote or a `&&` to break out of. Nothing derived from an
 *    utterance is ever interpolated into a command line — the one free-text slot
 *    (`app`) is resolved to a catalog key by the matcher and the *catalog's* own
 *    launch spec is used, never the spoken words.
 * 2. **Read-only, or reversible.** Nothing here deletes, moves, or overwrites a
 *    user file. Volume and mute are restorable, a screenshot creates a new file
 *    under an allow-listed root, lock is a session state. There is deliberately
 *    no local intent that can lose data.
 * 3. **Report failure as failure.** An executor that cannot do its job says so
 *    and names the reason. It does not return a cheerful string it has not
 *    earned — the project forbids pretending (§4), and a "volume set" reply over
 *    an unchanged volume is exactly that.
 *
 * PowerShell is used for the Windows APIs that have no plain executable, via
 * `-EncodedCommand`, so the script is a base64 argv element rather than a
 * command line. The scripts are fixed constants in this file; none is built from
 * input.
 */
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { assertContained } from "../system/path-safety.js";
import type { IntentMatch, LocalIntentId } from "./intent-model.js";
import type { WindowRead } from "../context/active-window.js";
import type { Referent } from "../context/conversation-context.js";
import type { CaptureRequest, CaptureResult } from "../context/screen-capture.js";
import {
  findProject,
  describeProject,
  type ProjectEntry,
} from "../context/project-registry.js";
import type { MemoryEntry, MemoryStore } from "../memory/memory-store.js";
import type { HermesMemoryFile } from "../memory/hermes-memory.js";
import { summariseSkills, type Skill } from "../memory/skill-catalog.js";
import { speakTasks } from "../tasks/speak-tasks.js";
import type { TaskSnapshot } from "../tasks/cron-store.js";
import { speakMcp } from "../mcp/speak-mcp.js";
import type { McpSnapshot } from "../mcp/mcp-store.js";

export interface ExecOutcome {
  ok: boolean;
  /** What Jarvis should say. One sentence, already user-facing. */
  speech: string;
  /** Machine-readable detail for the audit log. */
  detail?: string;
  /**
   * What this action was actually about, when it was about something nameable.
   *
   * Set by the executor rather than inferred by the caller, because the executor
   * is the only code that knows what it really acted on — it is holding the
   * registry entry or the window read. A caller reconstructing this from the
   * utterance would be guessing, and the guess would then be what "it" means in
   * the next sentence.
   *
   * Only ever a canonical key from a registry, a catalog, or a live read. Never
   * anything the user said.
   */
  subject?: Referent;
  /**
   * Something for the agent to look at, produced by this turn.
   *
   * Set only by an intent whose entire purpose is to obtain a payload the agent
   * needs and the local layer cannot interpret — today that is one intent,
   * `screen.read`. The local engine never sends this anywhere itself; it hands it
   * back to the runtime, which is the only component holding an agent session.
   *
   * Not part of `detail`, and never logged: `detail` goes to the audit file and
   * this is image bytes.
   */
  handoff?: { kind: "image"; data: Uint8Array; mimeType: string };
}

/** An app the machine can launch, as the catalog knows it. */
export interface AppEntry {
  /** Display name, for the reply. */
  name: string;
  /**
   * How to start it. Either an executable plus fixed args, or a shell-protocol
   * URI (`spotify:`, `ms-settings:`) which is handed to the shell handler as a
   * single argument rather than parsed.
   */
  launch: { kind: "exec"; file: string; args?: readonly string[] } | { kind: "uri"; uri: string };
}

export interface ExecutorDeps {
  /** Run a program with an argv array. Never a shell string. */
  run(file: string, args: readonly string[], opts?: RunOptions): Promise<string>;
  /**
   * Start a program and do not wait for it.
   *
   * Separate from `run` because the two have opposite success conditions: `run`
   * wants an exit code, and an app the user just asked to open should outlive
   * the call.
   *
   * Resolves once the process is confirmed spawned, rejects if it could not be.
   * Not `void`: `spawn` reports a missing executable asynchronously, so a
   * synchronous signature could only ever claim success it had not verified.
   */
  launch(file: string, args: readonly string[]): Promise<void>;
  /** The catalog, keyed as the matcher's `app` slot. */
  apps: ReadonlyMap<string, AppEntry>;
  /** Directories a screenshot may be written to. */
  screenshotRoots: readonly string[];
  /** Injected so tests are not tied to the wall clock. */
  now(): Date;
  /** Mic mute is runtime state, not a Windows setting — the runtime owns it. */
  setMicMuted(muted: boolean): boolean;
  isMicMuted(): boolean;
  /**
   * Read the foreground window, or explain why not.
   *
   * Injected rather than constructed here so this file keeps its property of
   * touching the machine only through `run` and `launch`, and so the intent can
   * be tested without a focused window. The reader owns its own PowerShell and
   * its own short cache; see `context/active-window.ts` for why there is no
   * polling behind it.
   */
  readActiveWindow?(): Promise<WindowRead>;
  /**
   * Capture the screen, having asked the user first.
   *
   * The gate, not the camera: consent, rate limiting and the session cap all live
   * behind this one call (`context/screen-capture.ts`), so no executor can reach
   * a raw screenshot without passing them. Optional, so a build with no capture
   * wired says "I can't" rather than pretending.
   */
  captureScreen?(request: CaptureRequest): Promise<CaptureResult>;
  /**
   * Whether the attached agent accepts images.
   *
   * Read before consent is requested. Without it the honest failure — the model
   * cannot see — would arrive *after* the user had already agreed to be
   * photographed.
   */
  agentAcceptsImages?(): boolean;
  /**
   * The user's projects, or an empty list if none are configured.
   *
   * A function rather than a value so the scan stays lazy and so a project
   * cloned after boot is found on the next ask without restarting Jarvis.
   */
  projects?(): readonly ProjectEntry[];
  /**
   * The roots the user nominated, whether or not anything was found in them.
   *
   * Separate from `projects` so an empty registry can be explained rather than
   * just reported. "I found nothing under the folders you gave me" and "you
   * haven't told me where to look" are different problems with different fixes,
   * and a single "no projects" would send the second user hunting through a
   * folder that was never the issue.
   */
  projectRoots?(): readonly string[];
  /**
   * Jarvis' own memory. Optional, so a build without one says so rather than
   * silently discarding what it was asked to remember.
   *
   * Deliberately not Hermes' store — see the header of `memory/memory-store.ts`.
   */
  memory?: MemoryStore;
  /**
   * What Hermes remembers, read-only.
   *
   * A function, so the answer reflects the files as they are now: Hermes writes
   * them during its own turns, and a value captured at boot would go stale the
   * first time the agent learned something.
   */
  hermesMemory?(): readonly HermesMemoryFile[];
  /**
   * The installed skills. A function for the same reason as `projects`: a skill
   * installed after boot should be listed on the next ask, not the next restart.
   */
  skills?(): readonly Skill[];
  /**
   * What Hermes has scheduled, and whether its scheduler is alive.
   *
   * A function, like the others, so the answer is read at the moment of asking.
   * That matters more here than anywhere else in this interface: the value being
   * reported is partly *how long ago something last happened*, which is wrong
   * the instant it is cached.
   */
  tasks?(): TaskSnapshot;
  /**
   * The MCP servers Hermes is configured with, read from its `config.yaml`.
   *
   * A function for the same reason as the rest, plus one specific to MCP: the
   * user may run `hermes mcp add` in a terminal while Jarvis is running, and
   * the next question about it should reflect that rather than the file as it
   * looked at boot.
   */
  mcp?(): McpSnapshot;
}

// --- process helper --------------------------------------------------------

export interface RunOptions {
  timeoutMs?: number;
  /**
   * Extra environment for the child. Used to hand a validated path to a script
   * without splicing it into the script text.
   *
   * Merged onto the parent environment, which is also why nothing here logs it:
   * the runtime's own environment may hold credentials, and §53 forbids printing
   * them.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Largest stdout to accept, in bytes. Defaults to 1 MiB.
   *
   * Raised only by the screen capture, whose payload is an image rather than a
   * line of text. It matters more than a limit usually does: `execFile` truncates
   * at the cap and reports success, so a too-small buffer does not fail — it
   * hands back a prefix that still decodes, into something that is not the
   * picture that was taken.
   */
  maxBufferBytes?: number;
  /**
   * Directory to run in. Defaults to the runtime's own, which is right for the
   * local intents (they name absolute paths) and wrong for anything asking a
   * question *about* a directory — `work-check.ts` runs `git status` and a test
   * script, and silently answering about the wrong repository there would grade
   * the assistant's own tests as the delegated work's verdict.
   */
  cwd?: string;
  /**
   * Run through the platform shell.
   *
   * Off by default and deliberately awkward to reach: on Windows this
   * concatenates the argv into one command line (Node DEP0190). Set only where
   * every argument is a literal and the target is a batch shim that cannot be
   * spawned directly — see `coding/resolve-npm.ts`.
   */
  shell?: boolean;
}

/**
 * `execFile` with a timeout and no shell.
 *
 * The timeout matters: a local intent exists to be fast, and a PowerShell call
 * that hangs would leave the user with a silent assistant. Failing at 5 s and
 * saying so is better than waiting.
 */
export function nodeRunner(
  file: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      [...args],
      {
        timeout: opts.timeoutMs ?? 5_000,
        windowsHide: true,
        maxBuffer: opts.maxBufferBytes ?? 1 << 20,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.shell ? { shell: true } : {}),
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(String(stderr || err.message).trim().split("\n")[0] ?? "failed"));
          return;
        }
        resolvePromise(String(stdout));
      },
    );
  });
}

/**
 * Where a screenshot may be written.
 *
 * One directory, inside the user's own Pictures folder. Narrow on purpose:
 * `assertContained` is only as strong as the allow-list it is handed, and
 * "anywhere under the profile" would let a path that survives canonicalisation
 * still land somewhere the user would not expect. Returns empty rather than a
 * guessed path when the environment says nothing — the executor refuses on an
 * empty list, and refusing beats writing to a folder nobody chose.
 */
export function defaultScreenshotRoots(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const profile = env["USERPROFILE"];
  return profile ? [`${profile}\\Pictures\\Jarvis`] : [];
}

/**
 * Start a program without waiting for it, and without adopting it.
 *
 * `detached` plus `unref` so the app survives a runtime restart and does not
 * keep the event loop alive. stdio is ignored rather than piped: nobody reads
 * it, and a full pipe buffer would eventually block the child.
 *
 * Resolves on `spawn`, which fires only once the process really exists, and
 * rejects on `error`, which is how a missing executable arrives. Waiting for one
 * of the two is what makes "Opening Spotify." a claim rather than a guess.
 */
export function nodeLauncher(file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, [...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: false, // it is a window the user asked for
    });
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
    child.once("error", (err) => reject(err));
  });
}

/**
 * Wrap a fixed PowerShell script for `-EncodedCommand`.
 *
 * UTF-16LE base64 is what PowerShell expects. The point is that the script
 * travels as one opaque argv element, so quoting cannot be broken — and every
 * caller below passes a constant.
 */
export function encodePwsh(script: string): readonly string[] {
  // Note what is absent: `-ExecutionPolicy Bypass`. Execution policy governs
  // script *files*, not `-EncodedCommand`, so it would loosen a Windows security
  // setting for no functional gain. `-NoProfile` is here for the opposite
  // reason — it keeps a user's profile script out of a path Jarvis relies on.
  return [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

const PWSH = "powershell.exe";

// --- fixed PowerShell scripts ----------------------------------------------
//
// Constants, every one of them. Nothing derived from an utterance is ever
// concatenated into these; the only variable data is a numeric volume level,
// which is validated to 0-100 by the matcher and re-checked below.

/**
 * Speaker volume through Core Audio (`IAudioEndpointVolume`).
 *
 * This is the documented per-endpoint API, so a level is a real scalar rather
 * than a count of simulated key presses — "set it to 40" lands on 40, and a
 * read-back afterwards is meaningful. The COM interface has to be declared to
 * PowerShell because no cmdlet exposes it; the declaration is fixed text.
 *
 * The operation and the level arrive in the environment, the same way the
 * screenshot destination does. Not as argv: PowerShell refuses positional
 * arguments after `-EncodedCommand` ("a command is already specified"), so
 * `$args` is never populated on this path. Environment is the better answer
 * anyway — an env value is read as data and never parsed as script, so there is
 * still nothing spliced into this string. The script clamps before applying, so
 * even a bug upstream cannot push the scalar out of range.
 */
const AUDIO_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int NotImpl1(); int NotImpl2();
  int GetChannelCount(out uint c);
  int SetMasterVolumeLevel(float level, Guid ctx);
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int GetMasterVolumeLevel(out float level);
  int GetMasterVolumeLevelScalar(out float level);
  int SetChannelVolumeLevel(uint ch, float level, Guid ctx);
  int SetChannelVolumeLevelScalar(uint ch, float level, Guid ctx);
  int GetChannelVolumeLevel(uint ch, out float level);
  int GetChannelVolumeLevelScalar(uint ch, out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int cls, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int NotImpl1();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice dev);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public static class Audio {
  static IAudioEndpointVolume Endpoint() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));
    var iid = typeof(IAudioEndpointVolume).GUID; object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static float Get() { float v; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v)); return v; }
  public static void Set(float v) {
    if (v < 0f) v = 0f; if (v > 1f) v = 1f;
    Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(v, Guid.Empty));
  }
  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m)); return m; }
  public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Endpoint().SetMute(m, Guid.Empty)); }
}
'@
switch ($env:JARVIS_AUDIO_OP) {
  'get'    { }
  'set'    { [Audio]::Set([single]([int]$env:JARVIS_AUDIO_LEVEL / 100.0)); [Audio]::SetMute($false) }
  'mute'   { [Audio]::SetMute($true) }
  'unmute' { [Audio]::SetMute($false) }
}
Write-Output ("{0}|{1}" -f [int][Math]::Round([Audio]::Get() * 100), [Audio]::GetMute().ToString().ToLower())
`;

const LOCK_SCRIPT = "rundll32.exe";

/** Battery, from WMI. Read-only. */
const BATTERY_SCRIPT = `
$b = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $b) { Write-Output "none" }
else { Write-Output ("{0}|{1}" -f $b.EstimatedChargeRemaining, $b.BatteryStatus) }
`;

/**
 * CPU and memory.
 *
 * `Get-Counter` for CPU rather than the WMI LoadPercentage, which is a
 * point-in-time sample that reads 0 as often as not.
 *
 * `String.raw` is load-bearing: the counter path contains `\P` and `\%`, which
 * are not valid JS escapes and get silently collapsed to `P` and `%` in an
 * ordinary template literal. That produced a path PowerShell could not resolve,
 * and the only symptom was "I couldn't read the system counters."
 */
const RESOURCES_SCRIPT = String.raw`
$cpu = (Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 1).CounterSamples[0].CookedValue
$os = Get-CimInstance Win32_OperatingSystem
$total = $os.TotalVisibleMemorySize
$free = $os.FreePhysicalMemory
Write-Output ("{0:N0}|{1:N0}|{2:N0}" -f $cpu, (($total - $free) / 1MB * 1KB), ($total / 1MB * 1KB))
`;

/**
 * Screenshot of the virtual screen, saved as PNG.
 *
 * The destination is passed as a separate argv element and validated against
 * the allow-list before we get here, so the script reads it from the
 * environment rather than having it spliced in.
 */
const SCREENSHOT_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$dir = Split-Path -Parent $env:JARVIS_SHOT_PATH
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($env:JARVIS_SHOT_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output $env:JARVIS_SHOT_PATH
`;

// --- helpers ---------------------------------------------------------------

/** Speaker level and mute, as the audio script reports them. */
function parseAudio(out: string): { level: number; muted: boolean } | null {
  const line = out.trim().split("\n").pop()?.trim() ?? "";
  const m = /^(\d{1,3})\|(true|false)$/.exec(line);
  if (!m) return null;
  return { level: Number(m[1]), muted: m[2] === "true" };
}

/**
 * Drive the speaker endpoint, and report where it ended up.
 *
 * Every operation answers with the resulting level and mute state, which is what
 * lets the executors below state what happened rather than what was asked for.
 * `null` means the endpoint did not answer in the expected shape — treated as a
 * failure everywhere, never as a silent success.
 *
 * Exported because `scripts/probe-local.ts` has to read the real level and mute
 * state before it changes them and put both back afterwards; a probe that leaves
 * the volume wherever it happened to finish is one nobody runs twice.
 */
export async function audioEndpoint(
  run: ExecutorDeps["run"],
  op: "get" | "set" | "mute" | "unmute",
  value?: number,
): Promise<{ level: number; muted: boolean } | null> {
  const out = await run(PWSH, encodePwsh(AUDIO_SCRIPT), {
    timeoutMs: 8_000,
    env: {
      JARVIS_AUDIO_OP: op,
      // Always present, so the child never inherits a stale value from a
      // previous call's environment.
      JARVIS_AUDIO_LEVEL: String(value === undefined ? 0 : Math.round(value)),
    },
  });
  return parseAudio(out);
}

const audio = (
  d: ExecutorDeps,
  op: "get" | "set" | "mute" | "unmute",
  value?: number,
): Promise<{ level: number; muted: boolean } | null> => audioEndpoint(d.run, op, value);

/** 12-hour clock, because that is how the time gets said out loud. */
function spokenTime(at: Date): string {
  const h = at.getHours();
  const m = at.getMinutes();
  const hour = h % 12 === 0 ? 12 : h % 12;
  const suffix = h < 12 ? "AM" : "PM";
  return m === 0
    ? `${hour} o'clock ${suffix}`
    : `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// --- executors -------------------------------------------------------------

type Executor = (m: IntentMatch, d: ExecutorDeps) => Promise<ExecOutcome>;

const clock: Executor = async (_m, d) => ({
  ok: true,
  speech: `It's ${spokenTime(d.now())}.`,
});

const today: Executor = async (_m, d) => {
  const at = d.now();
  return {
    ok: true,
    speech: `It's ${DAYS[at.getDay()]}, ${MONTHS[at.getMonth()]} ${at.getDate()}, ${at.getFullYear()}.`,
  };
};

/**
 * Set the speaker level.
 *
 * The reply states the level read back from the device, not the level asked
 * for. They are normally the same; when a device quantises, saying what actually
 * happened is the difference between reporting and pretending.
 */
const volumeSet: Executor = async (m, d) => {
  const want = m.slots.level;
  if (want === undefined || !Number.isFinite(want) || want < 0 || want > 100) {
    return { ok: false, speech: "I need a level between 0 and 100.", detail: `level=${want}` };
  }
  const after = await audio(d, "set", Math.round(want));
  if (!after) return { ok: false, speech: "I couldn't change the volume.", detail: "unreadable" };
  return { ok: true, speech: `Volume ${after.level}%.`, detail: `level=${after.level}` };
};

/** Relative change, applied to whatever the level actually is right now. */
const volumeStep = (direction: 1 | -1): Executor => async (m, d) => {
  const before = await audio(d, "get");
  if (!before) return { ok: false, speech: "I couldn't read the volume.", detail: "unreadable" };
  const step = m.slots.step ?? 10;
  const target = Math.max(0, Math.min(100, before.level + direction * step));
  const after = await audio(d, "set", target);
  if (!after) return { ok: false, speech: "I couldn't change the volume.", detail: "unreadable" };
  return { ok: true, speech: `Volume ${after.level}%.`, detail: `${before.level}→${after.level}` };
};

const volumeMute = (muted: boolean): Executor => async (_m, d) => {
  const after = await audio(d, muted ? "mute" : "unmute");
  if (!after) {
    return {
      ok: false,
      speech: `I couldn't ${muted ? "mute" : "unmute"} the speakers.`,
      detail: "unreadable",
    };
  }
  // Report the device's state, not the request. A mute that did not take must
  // not be announced as one.
  if (after.muted !== muted) {
    return { ok: false, speech: "The speakers didn't change.", detail: `muted=${after.muted}` };
  }
  return {
    ok: true,
    speech: muted ? "Speakers muted." : `Speakers on, ${after.level}%.`,
  };
};

/**
 * Microphone mute.
 *
 * Runtime state, not a Windows setting: Jarvis owns its own capture, and muting
 * the OS input device would also mute every other app. Deliberately never
 * reports success it cannot confirm — a user who is told the mic is off must be
 * right about that.
 */
const micMute = (muted: boolean): Executor => async (_m, d) => {
  const applied = d.setMicMuted(muted);
  if (!applied || d.isMicMuted() !== muted) {
    return {
      ok: false,
      speech: `I couldn't ${muted ? "mute" : "unmute"} the microphone.`,
      detail: "voice daemon did not accept the change",
    };
  }
  return {
    ok: true,
    speech: muted ? "Microphone off. Say nothing — I'm not listening." : "Microphone on.",
  };
};

/**
 * Screenshot to an allow-listed directory.
 *
 * The filename is generated here from the clock, never from the utterance, and
 * the whole path goes through `assertContained` before PowerShell sees it. So
 * the destination cannot be steered by anything that was said near the
 * microphone, and it cannot land outside the configured roots.
 */
const screenshot: Executor = async (_m, d) => {
  const root = d.screenshotRoots[0];
  if (!root) {
    return {
      ok: false,
      speech: "I don't have a folder I'm allowed to save screenshots to.",
      detail: "no screenshot roots configured",
    };
  }
  const at = d.now();
  const stamp =
    `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-` +
    `${String(at.getDate()).padStart(2, "0")}_${String(at.getHours()).padStart(2, "0")}` +
    `${String(at.getMinutes()).padStart(2, "0")}${String(at.getSeconds()).padStart(2, "0")}`;

  let target: string;
  try {
    target = assertContained(join(root, `jarvis-${stamp}.png`), d.screenshotRoots);
  } catch (err) {
    return {
      ok: false,
      speech: "I couldn't find a safe place to save that.",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  await d.run(PWSH, encodePwsh(SCREENSHOT_SCRIPT), {
    timeoutMs: 15_000,
    env: { JARVIS_SHOT_PATH: target },
  });
  return { ok: true, speech: `Saved to ${target}.`, detail: target };
};

/**
 * Lock the session.
 *
 * `LockWorkStation` via rundll32 — the documented call, and a session state
 * rather than a security change. Nothing is closed and nothing is lost.
 */
const lock: Executor = async (_m, d) => {
  await d.run(LOCK_SCRIPT, ["user32.dll,LockWorkStation"], { timeoutMs: 5_000 });
  return { ok: true, speech: "Locking." };
};

const battery: Executor = async (_m, d) => {
  const out = (await d.run(PWSH, encodePwsh(BATTERY_SCRIPT), { timeoutMs: 8_000 })).trim();
  if (out === "none" || !out) {
    // A desktop has no battery. That is an answer, not a failure.
    return { ok: true, speech: "This machine doesn't have a battery.", detail: "no battery" };
  }
  const m = /^(\d{1,3})\|(\d+)$/.exec(out.split("\n").pop()?.trim() ?? "");
  if (!m) return { ok: false, speech: "I couldn't read the battery.", detail: out.slice(0, 80) };

  const pct = Number(m[1]);
  // Win32_Battery.BatteryStatus: 2 means running on AC.
  const charging = m[2] === "2";
  return {
    ok: true,
    speech: charging ? `${pct}% and charging.` : `${pct}%, on battery.`,
    detail: `pct=${pct} status=${m[2]}`,
  };
};

const resources: Executor = async (_m, d) => {
  const out = (await d.run(PWSH, encodePwsh(RESOURCES_SCRIPT), { timeoutMs: 10_000 })).trim();
  const m = /^([\d,]+)\|([\d,]+)\|([\d,]+)$/.exec(out.split("\n").pop()?.trim() ?? "");
  if (!m) {
    return { ok: false, speech: "I couldn't read the system counters.", detail: out.slice(0, 80) };
  }
  const n = (s: string): number => Number(s.replace(/,/g, ""));
  const cpu = n(m[1] ?? "0");
  const usedGb = n(m[2] ?? "0") / 1024;
  const totalGb = n(m[3] ?? "0") / 1024;
  return {
    ok: true,
    speech: `CPU ${cpu}%, memory ${usedGb.toFixed(1)} of ${totalGb.toFixed(1)} gigabytes.`,
    detail: `cpu=${cpu} usedMb=${n(m[2] ?? "0")} totalMb=${n(m[3] ?? "0")}`,
  };
};

/**
 * Launch an app from the catalog.
 *
 * The spoken name is used for nothing but the reply. What gets executed is the
 * catalog's own `launch` spec, looked up by the canonical key the matcher
 * resolved — so an utterance cannot name an executable, only select one that was
 * already registered.
 */
const launch: Executor = async (m, d) => {
  const key = m.slots.app;
  const entry = key ? d.apps.get(key) : undefined;
  if (!entry) {
    return {
      ok: false,
      speech: "I don't know how to open that.",
      detail: `unknown app key: ${key ?? "(none)"}`,
    };
  }
  // Detached, and not awaited for exit. `run` waits for the child to finish,
  // which for an app the user just asked to open means waiting until they close
  // it — the launch would "time out" while succeeding.
  try {
    if (entry.launch.kind === "exec") {
      await d.launch(entry.launch.file, entry.launch.args ?? []);
    } else {
      // explorer.exe hands a URI to the registered protocol handler. Deliberately
      // not `cmd /c start`, which would put a shell in the path for no reason.
      await d.launch("explorer.exe", [entry.launch.uri]);
    }
  } catch (err) {
    return {
      ok: false,
      speech: `I couldn't open ${entry.name}.`,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, speech: `Opening ${entry.name}.`, detail: entry.launch.kind };
};

/**
 * Say what projects Jarvis knows about.
 *
 * "None" and "none configured" are different answers and get different words: a
 * user who nominated a root and got nothing has a problem to fix, and one who
 * nominated nothing has a setting to write. Reporting both as "no projects"
 * would leave the first believing their folder is empty.
 */
const listProjects: Executor = async (_m, d) => {
  const all = d.projects?.() ?? [];
  if (all.length === 0) {
    const roots = d.projectRoots?.() ?? [];
    return roots.length === 0
      ? {
          ok: true,
          speech:
            "I don't know where your projects are yet. Tell me which folders to look in and I'll find them.",
          detail: "no roots configured",
        }
      : {
          ok: true,
          speech: `I didn't find any projects in the ${roots.length === 1 ? "folder" : `${roots.length} folders`} you gave me.`,
          detail: `roots=${roots.length} found=0`,
        };
  }
  // Read a few, count the rest. Fifteen project names spoken aloud is not an
  // answer, it is a filibuster.
  const head = all.slice(0, 5).map((p) => p.name);
  const rest = all.length - head.length;
  const list = head.join(", ");
  return {
    ok: true,
    speech:
      rest > 0
        ? `I know ${all.length} projects, including ${list}.`
        : `${all.length === 1 ? "One project" : `${all.length} projects`}: ${list}.`,
    detail: `count=${all.length}`,
  };
};

/**
 * Open a project folder in Explorer.
 *
 * The path comes from the registry, never from the utterance: `findProject`
 * matches spoken words against entries discovered by scanning, and what gets
 * handed to Explorer is that entry's own `dir`. So the worst an utterance can do
 * is select a folder the user already nominated, or fail to select one — it
 * cannot describe a path. That is the same guarantee `app.launch` gives, and it
 * matters more here because a directory is an argument rather than a fixed
 * executable.
 */
const openProject: Executor = async (m, d) => {
  const spoken = m.slots.project;
  const all = d.projects?.() ?? [];
  const found = spoken ? findProject(spoken, all) : ({ kind: "none" } as const);

  if (found.kind === "none") {
    return {
      ok: false,
      speech: "I don't have a project by that name.",
      detail: `no registry match (${all.length} known)`,
    };
  }
  if (found.kind === "ambiguous") {
    // Asked, not guessed — the same rule as bare "mute". Opening the wrong
    // repo is recoverable, but it is still Jarvis deciding something it was in
    // a position to ask about.
    const names = found.candidates.map((p) => describeProject(p)).join(", or ");
    return {
      ok: false,
      speech: `I know more than one of those: ${names}. Which one?`,
      detail: `ambiguous: ${found.candidates.length} candidates`,
    };
  }

  try {
    await d.launch("explorer.exe", [found.project.dir]);
  } catch (err) {
    return {
      ok: false,
      speech: `I couldn't open ${found.project.name}.`,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  // The path is deliberately absent from the detail. It is the user's directory
  // layout, it goes in a log that persists, and the project name already
  // answers "what did it open" (§53).
  return {
    ok: true,
    speech: `Opening ${found.project.name}.`,
    detail: `project=${found.project.name} kind=${found.project.kind}`,
    // The registry's key, so "open it again" a moment later resolves to this
    // same directory rather than re-running a match that could now be ambiguous.
    subject: { kind: "project", key: found.project.key, label: found.project.name },
  };
};

/**
 * Say what window is in front.
 *
 * Local on purpose. The answer needs no model, and sending the title of whatever
 * you are looking at to a hosted one to be told what it says would be the
 * privacy cost of the feature with none of the benefit.
 *
 * Three replies, not two, for the reason the whole project keeps returning to:
 * "nothing is focused" and "I could not check" are different facts, and reading
 * the second as the first would have Jarvis calmly describe an empty desktop
 * every time the read failed.
 */
const activeWindow: Executor = async (_m, d) => {
  if (!d.readActiveWindow) {
    return {
      ok: false,
      speech: "I can't see your windows right now.",
      detail: "no window reader configured",
    };
  }
  const r = await d.readActiveWindow();
  if (!r.ok) {
    return { ok: false, speech: "I couldn't check which window is in front.", detail: r.reason };
  }
  if (!r.window) {
    return { ok: true, speech: "Nothing's in the foreground right now.", detail: "no window" };
  }
  const w = r.window;
  const speech = w.hasTitle ? `${w.process} — ${w.title}` : `${w.process}, with no window title.`;
  return {
    ok: true,
    // The detail goes to the audit log, so it carries the process and the kind
    // but never the title: the title is the part that can hold a document name
    // or a subject line, and a log is exactly where §53 says not to put it.
    speech: w.redacted ? `${speech} (I've left out something that looked like a secret.)` : speech,
    detail: `process=${w.process} kind=${w.kind} origin=${w.origin} redacted=${w.redacted}`,
    // The process name, never the title. A referent outlives the turn, and the
    // title is the part that carries the document name (§53).
    subject: { kind: "window", key: w.process.toLowerCase(), label: w.process },
  };
};

/**
 * "Look at my screen" — capture with consent, and hand the pixels to the agent.
 *
 * Written as a sequence of refusals on purpose. Each one is a different sentence
 * out loud, because every one of them is a different thing for the user to do
 * about it, and collapsing them into "I can't do that" would hide which:
 *
 *   no gate configured  → this build has no capture wired at all
 *   agent can't see     → the model does not take images; nothing was captured
 *   gate refused        → consent, rate limit or capture failure, already worded
 *
 * The order matters more than it looks. `acceptsImages` is checked *before* the
 * consent prompt, so the user is never asked to authorise photographing their
 * desktop for an agent that would have to throw the image away. Consent spent on
 * nothing is consent spent.
 */
const readScreen: Executor = async (_m, d) => {
  if (!d.captureScreen) {
    return {
      ok: false,
      speech: "I can't look at your screen in this build.",
      detail: "no screen capture configured",
    };
  }
  if (d.agentAcceptsImages?.() !== true) {
    // Unavailable, said plainly (§ no fake features). The alternative — capture
    // it and describe nothing — is the failure mode this project exists against.
    return {
      ok: false,
      speech: "I can't look at your screen — the agent I'm connected to can't see images.",
      detail: "agent did not advertise image support",
    };
  }

  const shot = await d.captureScreen({
    reason: "You asked me to look at your screen.",
    destination: "agent",
  });
  if (!shot.ok) {
    // The gate already phrased this for a person; repeating it here would let
    // two files disagree about what a denial sounds like.
    return { ok: false, speech: shot.speech, detail: `capture refused: ${shot.refusal}` };
  }

  // Deliberately not `subject`. A screenshot is not a nameable thing "it" can
  // refer to next turn, and inventing a referent for it would let "open it"
  // resolve to something that is not a place.
  return {
    ok: true,
    speech: "One moment — I'm looking.",
    // Size and format only. The bytes are the one payload that cannot be
    // redacted, and this line goes to disk (§53).
    detail: `captured ${shot.image.byteLength} bytes ${shot.format} for the agent`,
    handoff: { kind: "image", data: shot.image, mimeType: "image/png" },
  };
};

// --- memory ----------------------------------------------------------------

/**
 * Write something down.
 *
 * The text comes from the rule's `raw` hook, so it is what the user actually
 * said rather than the normalised form the matcher works on — see the note on
 * `Rule.raw`. The store screens it (§53: a credential-shaped memory is refused,
 * not stored redacted) and phrases both outcomes, so this executor's job is to
 * pass the sentence through rather than to invent a second wording.
 */
const rememberThat: Executor = async (m, d) => {
  const said = m.slots.text?.trim();
  if (!said) {
    return { ok: false, speech: "I didn't catch what to remember.", detail: "empty text slot" };
  }
  if (!d.memory) {
    return {
      ok: false,
      speech: "I can't save anything right now — my memory isn't set up.",
      detail: "no memory store configured",
    };
  }
  const result = d.memory.remember(said);
  return {
    ok: result.ok,
    speech: result.speech,
    // Length and id only. The memory's text is the user's private note and this
    // line goes to a durable audit log (§53).
    detail: result.ok
      ? `id=${result.entry?.id} chars=${result.entry?.text.length} evicted=${result.evicted?.length ?? 0}`
      : "refused by screening",
  };
};

/** At most three, because a spoken list stops being an answer after that. */
function speakEntries(found: readonly MemoryEntry[]): string {
  const head = found.slice(0, 3).map((e) => e.text);
  const rest = found.length - head.length;
  const list = head.join("; ");
  return rest > 0 ? `${list} — and ${rest} more.` : `${list}.`;
}

const recallAbout: Executor = async (m, d) => {
  const query = m.slots.text?.trim();
  if (!d.memory) {
    return {
      ok: false,
      speech: "I can't check — my memory isn't set up.",
      detail: "no memory store configured",
    };
  }
  if (!query) {
    return { ok: false, speech: "Remind you about what?", detail: "empty query slot" };
  }
  const found = d.memory.recall(query);
  if (found.length === 0) {
    // A miss is an answer, and it is deliberately not routed onward: the user
    // asked what *Jarvis* remembers, and "nothing about that" is true and fast.
    return {
      ok: true,
      speech: `I don't have anything saved about ${query}.`,
      detail: `query hits=0`,
    };
  }
  return { ok: true, speech: speakEntries(found), detail: `query hits=${found.length}` };
};

/**
 * Forget a memory by description.
 *
 * Deletes only on an unambiguous single hit. Several matches is a question, not
 * a judgement call — the same rule as bare "mute" and an ambiguous project, and
 * it matters more here because this is the one local intent that destroys
 * something. Being wrong is unrecoverable, and asking costs a sentence.
 */
const forgetAbout: Executor = async (m, d) => {
  const query = m.slots.text?.trim();
  if (!d.memory) {
    return {
      ok: false,
      speech: "I can't check — my memory isn't set up.",
      detail: "no memory store configured",
    };
  }
  if (!query) return { ok: false, speech: "Forget what?", detail: "empty query slot" };

  const found = d.memory.recall(query);
  if (found.length === 0) {
    return {
      ok: true,
      speech: `I don't have anything saved about ${query}.`,
      detail: "forget hits=0",
    };
  }
  if (found.length > 1) {
    return {
      ok: false,
      speech: `I have ${found.length} things about that. Which one — ${speakEntries(found)}`,
      detail: `forget ambiguous hits=${found.length}`,
    };
  }
  const target = found[0]!;
  const removed = d.memory.forget(target.id);
  if (!removed) {
    return { ok: false, speech: "I couldn't remove that one.", detail: `id=${target.id} not found` };
  }
  return { ok: true, speech: "Forgotten.", detail: `forgot id=${removed.id}` };
};

/**
 * What Jarvis has saved, and what Hermes has separately.
 *
 * Both are reported because they are genuinely two stores and the user is
 * entitled to know that. Hermes' entries are counted, never read aloud: they are
 * the agent's own notes, they can run to 2 KB, and the question asked here is
 * "what do you remember", not "recite everything".
 */
const listMemories: Executor = async (_m, d) => {
  if (!d.memory) {
    return {
      ok: false,
      speech: "I can't check — my memory isn't set up.",
      detail: "no memory store configured",
    };
  }
  const mine = d.memory.entriesList();
  const hermes = d.hermesMemory?.() ?? [];
  const hermesCount = hermes.reduce((sum, f) => sum + f.entries.length, 0);
  const aside =
    hermesCount > 0
      ? ` Hermes keeps ${hermesCount} note${hermesCount === 1 ? "" : "s"} of its own.`
      : "";

  if (mine.length === 0) {
    return {
      ok: true,
      speech: `You haven't asked me to remember anything yet.${aside}`,
      detail: `mine=0 hermes=${hermesCount}`,
    };
  }
  // Newest first: "what do you remember" is almost always about the recent past.
  const recent = mine.slice().reverse();
  return {
    ok: true,
    speech: `I have ${mine.length} thing${mine.length === 1 ? "" : "s"} saved: ${speakEntries(recent)}${aside}`,
    detail: `mine=${mine.length} hermes=${hermesCount}`,
  };
};

// --- skills ----------------------------------------------------------------

/**
 * "What can you do?"
 *
 * Answered from the skills on disk, so the list is the one Hermes would actually
 * load rather than a hand-maintained blurb that drifts. Categories, not names:
 * 102 skill names is not an answer.
 *
 * Nothing here reads a skill's *body*. The catalog took `name` and `description`
 * from frontmatter and sanitised both at the boundary (§52) — the rest of a
 * `SKILL.md` is instructions written for an agent, and putting that in front of
 * one via a "what can you do" answer is the injection path this avoids.
 */
const listSkills: Executor = async (_m, d) => {
  const all = d.skills?.() ?? [];
  if (all.length === 0) {
    return {
      ok: true,
      speech:
        "I can control your machine — volume, apps, screenshots, your projects — and I can " +
        "hand anything bigger to the agent. I don't see any skills installed.",
      detail: "skills=0",
    };
  }
  const top = summariseSkills(all).slice(0, 4);
  const list = top.map((c) => `${c.category.replace(/[-/]/g, " ")} (${c.count})`).join(", ");
  return {
    ok: true,
    speech: `I have ${all.length} skills installed. The biggest areas are ${list}. Ask me about any of them.`,
    detail: `skills=${all.length} categories=${summariseSkills(all).length}`,
  };
};

// --- scheduled tasks -------------------------------------------------------

/**
 * "What have I got scheduled?"
 *
 * The whole answer is `speakTasks`, in `tasks/speak-tasks.ts`, because the
 * hard part is not listing jobs — it is refusing to list them as if they were
 * going to run. On this machine right now they would not: Hermes' cron ticker
 * only exists inside its gateway, and the gateway is not running. A list without
 * that sentence is the §4 failure the project forbids, a feature that looks like
 * it works.
 */
const listTasks: Executor = async (_m, d) => {
  const snapshot = d.tasks?.();
  if (!snapshot) {
    return {
      ok: true,
      speech: "I can't see the scheduler from here, so I don't know what's set up.",
      detail: "tasks=unavailable",
    };
  }
  return {
    ok: true,
    speech: speakTasks(snapshot, d.now().getTime()),
    detail: `tasks=${snapshot.jobs.length} ticker=${snapshot.ticker.state} willFire=${snapshot.willFire}`,
  };
};

// --- MCP -------------------------------------------------------------------

/**
 * "What MCP servers do I have?"
 *
 * Answered from `config.yaml` rather than `hermes mcp list`, which costs 1.655 s
 * of Python startup here and prints a table. The answer itself is `speakMcp`,
 * which leads with a warning when an entry matches a shape Hermes refuses to
 * spawn — the same warning-before-inventory rule the scheduler answer follows,
 * and for a sharper reason: an MCP entry is a command Hermes will execute, and
 * the entry that matters most is the one that should not be there.
 */
const listMcp: Executor = async (_m, d) => {
  const snapshot = d.mcp?.();
  if (!snapshot) {
    return {
      ok: true,
      speech:
        "I can't see Hermes' configuration from here, so I don't know what MCP servers are set up.",
      detail: "mcp=unavailable",
    };
  }
  const flagged = snapshot.servers.filter((s) => s.suspicious.length > 0).length;
  return {
    ok: true,
    speech: speakMcp(snapshot),
    detail: `mcp=${snapshot.servers.length} enabled=${
      snapshot.servers.filter((s) => s.enabled).length
    } flagged=${flagged} unparsed=${snapshot.unparsed}`,
  };
};

// --- dispatch --------------------------------------------------------------

/**
 * Every intent the matcher can produce maps to exactly one executor.
 *
 * `Record<LocalIntentId, …>` rather than a lookup with a default: adding an
 * intent to the model without wiring it up here is then a compile error instead
 * of a runtime "I don't know how to do that".
 */
const EXECUTORS: Record<LocalIntentId, Executor> = {
  "time.now": clock,
  "date.today": today,
  "volume.set": volumeSet,
  "volume.up": volumeStep(1),
  "volume.down": volumeStep(-1),
  "volume.mute": volumeMute(true),
  "volume.unmute": volumeMute(false),
  "mic.mute": micMute(true),
  "mic.unmute": micMute(false),
  screenshot,
  lock,
  battery,
  resources,
  "app.launch": launch,
  "project.list": listProjects,
  "project.open": openProject,
  "window.active": activeWindow,
  "screen.read": readScreen,
  "memory.remember": rememberThat,
  "memory.recall": recallAbout,
  "memory.forget": forgetAbout,
  "memory.list": listMemories,
  "skills.list": listSkills,
  "tasks.list": listTasks,
  "mcp.list": listMcp,
};

/**
 * Run a matched intent.
 *
 * Errors become outcomes rather than exceptions: a failed local action should
 * make Jarvis say what went wrong, not tear down the turn. The message is
 * included because these are all local, non-sensitive failures — a missing
 * counter, an app that would not start.
 */
export async function execute(match: IntentMatch, deps: ExecutorDeps): Promise<ExecOutcome> {
  const executor = EXECUTORS[match.id];
  try {
    return await executor(match, deps);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, speech: `That didn't work: ${detail}`, detail };
  }
}
