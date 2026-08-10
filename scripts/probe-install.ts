/**
 * §62 gate: does the *packaged* Jarvis work when Windows starts it?
 *
 * Every other probe in this repo runs the code from `E:\jarvis` with `E:\jarvis`
 * as the working directory, because that is where `npx tsx` is typed. A Run-key
 * launch does neither: it runs `%LOCALAPPDATA%\Programs\Jarvis\Jarvis.exe` with
 * the working directory set to `C:\Windows\system32`. That single difference is
 * the whole of what this probe exists to test, and it was not a hypothetical —
 * four assets resolve against the working directory and nowhere else:
 *
 *   .venv\Scripts\python.exe            VoiceSidecar.resolvePython
 *   voice\daemon.py                     VoiceSidecar.daemonScript
 *   models\piper\en_GB-alan-medium.onnx voice/daemon.py, `piper_voice` default
 *   .research\whisper                   voice/daemon.py, `stt_dir` default
 *
 * so before `workingDirectory` existed, an auto-started Jarvis came up in the
 * tray, answered typed input, and could not hear the word "Jarvis" — with the
 * last two silently re-downloading 680 MB of models on first use rather than
 * failing. Unit tests cannot see any of this: they inject `spawnProcess`.
 *
 * Scenario 1 launches the packaged binary from `system32` with `JARVIS_CWD`
 * forced back to `system32`, so the config fix is bypassed and the old defect is
 * reproduced. It exists so that scenario 2 means something: a check that cannot
 * fail is not evidence. Scenario 2 is the real one — same binary, same working
 * directory, config consulted.
 *
 * **What it does to your machine.**
 *   - Starts the real packaged shell and the real packaged runtime, twice.
 *   - Scenario 2 starts the voice daemon, which **opens the microphone locally**,
 *     because that is what an always-on Jarvis does at logon and disabling it
 *     would mean not testing the thing that was broken. Nothing is recorded and
 *     nothing leaves the machine (§50) — the daemon has no network path. This is
 *     the one place this probe differs from its plan, which said the mic would
 *     stay shut; asserting "the daemon would have resolved" instead of "the wake
 *     word is live" would have been the weaker claim, and this project's rule is
 *     that a claim by the actor is not evidence.
 *   - Reads Hermes' real install path (existence only) and the real HKCU Run key
 *     (read-only). Writes nothing to the registry.
 *   - Both runtimes are quit through IPC and both shells killed on the way out.
 *
 * Requires `npm run package` first, and no Jarvis running.
 *
 *   npm run probe:install [-- --json]
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PipeClient } from "../src/ipc/pipe-client.js";
import { readToken, tokenFilePath } from "../src/ipc/token.js";
import { AutostartManager } from "../src/system/autostart.js";
import { resolveHermesExecutable } from "../src/hermes/resolve-hermes.js";
import { configFilePath, loadConfig } from "../src/context/config.js";
import type { RuntimeStatus } from "../src/ipc/contract.js";

const execFileAsync = promisify(execFile);
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const asJson = process.argv.includes("--json");

/** The working directory Windows hands a Run-key entry. The defect, as a value. */
const RUN_KEY_CWD = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

/** Whisper on CPU is not fast. Generous, because a false failure here is worse. */
const VOICE_TIMEOUT_MS = 120_000;

const results: { name: string; verdict: "PASS" | "FAIL" | "INFO"; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, verdict: ok ? "PASS" : "FAIL", detail });
  if (!asJson) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
/** Reported, not gated. Some facts are context for a human, not a verdict. */
function note(name: string, detail: string): void {
  results.push({ name, verdict: "INFO", detail });
  if (!asJson) console.log(`  ·   ${name}${detail ? `  — ${detail}` : ""}`);
}

async function attach(name: string, timeoutMs = 60_000): Promise<PipeClient | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = readToken();
    if (token) {
      const c = new PipeClient({
        token,
        clientName: name,
        autoReconnect: false,
        requestTimeoutMs: 30_000,
      });
      try {
        await c.connectAndAuthenticate();
        return c;
      } catch {
        await c.close().catch(() => {});
      }
    }
    await wait(500);
  }
  return null;
}

/** Leave no runtime behind from an earlier run, ours or the user's. */
async function clearExistingRuntime(label: string): Promise<void> {
  const token = readToken();
  if (!token) return;
  if (!asJson) console.log(`    (stopping a runtime found before ${label})`);
  const c = new PipeClient({ token, clientName: "probe-install-cleanup", autoReconnect: false });
  try {
    await c.connectAndAuthenticate();
    await c.request({ type: "quit" }).catch(() => {});
  } catch {
    /* nothing listening; a stale token file is handled by the caller */
  }
  await c.close().catch(() => {});
  await wait(2_000);
}

interface Launch {
  shell: ChildProcess;
  exited: () => boolean;
}

/** Start the packaged shell exactly as a Run-key entry would. */
function launch(exe: string, env: NodeJS.ProcessEnv = {}): Launch {
  let exited = false;
  const shell = spawn(exe, ["--minimized"], {
    // The point of the whole probe. Not `E:\jarvis`.
    cwd: RUN_KEY_CWD,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  shell.on("exit", () => (exited = true));
  return { shell, exited: () => exited };
}

async function shutdown(client: PipeClient | null, l: Launch): Promise<void> {
  if (client) {
    await client.request({ type: "quit" }).catch(() => {});
    await client.close().catch(() => {});
  }
  await wait(1_500);
  if (l.shell.pid && !l.exited()) {
    await execFileAsync("taskkill", ["/pid", String(l.shell.pid), "/t", "/f"]).catch(() => {});
  }
  await wait(1_500);
}

/** Does this pid own a top-level window? §62: "no unnecessary main window". */
async function hasVisibleWindow(pid: number): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      // MainWindowHandle is 0 for a process with no top-level window. Asked of
      // every Jarvis process, not just the shell's own pid: Electron's window
      // could belong to a child, and a probe that looked only at the parent
      // would report "no window" while one was on screen.
      "Get-Process -Name Jarvis -ErrorAction SilentlyContinue | " +
        "ForEach-Object { $_.MainWindowHandle.ToInt64() }",
    ]);
    void pid;
    const handles = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (handles.length === 0) return null;
    return handles.some((h) => h !== "0");
  } catch {
    return null;
  }
}

/** RSS, parent and command line per Jarvis process, via the OS. */
async function jarvisProcesses(): Promise<
  { pid: number; ppid: number; rssMb: number; cmd: string }[]
> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        // The command line is the only way to tell the shell from the runtime
        // from Electron's helpers: they are all the same executable, which is
        // the design (one binary, two modes) and makes the process list
        // uninterpretable without it. The parent is what says *whose* helper a
        // helper is — the question that matters for a runtime that should be
        // headless.
        "Get-CimInstance Win32_Process -Filter \"Name='Jarvis.exe'\" | " +
          "ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.WorkingSetSize)`t$($_.CommandLine)\" }",
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [pid, ppid, ws, ...rest] = l.split("\t");
        return {
          pid: Number(pid),
          ppid: Number(ppid),
          rssMb: Number(ws) / 1e6,
          cmd: rest.join("\t"),
        };
      })
      .filter((p) => Number.isFinite(p.pid) && Number.isFinite(p.rssMb));
  } catch {
    return [];
  }
}

/** Poll status until `done`, or give up. */
async function pollStatus(
  client: PipeClient,
  done: (s: RuntimeStatus) => boolean,
  timeoutMs: number,
): Promise<RuntimeStatus | null> {
  const deadline = Date.now() + timeoutMs;
  let last: RuntimeStatus | null = null;
  while (Date.now() < deadline) {
    last = (await client.request({ type: "get_status" }).catch(() => null)) as RuntimeStatus | null;
    if (last && done(last)) return last;
    await wait(1_000);
  }
  return last;
}

/** A voice reason that means "the working directory was wrong", not "it broke". */
function isResolutionFailure(detail: string): boolean {
  return /daemon not found|no python environment|no usable python/i.test(detail);
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const exe = join(root, "dist", "win-unpacked", "Jarvis.exe");
  const installer = join(root, "dist", "Jarvis Setup 0.1.0.exe");

  if (!existsSync(exe)) {
    console.error(`${exe} does not exist.\nRun \`npm run package\` first.`);
    process.exit(1);
  }
  // The same refusal `probe:idle` and `probe:resilience` make, for the same
  // reason: `stop()` revokes the shared token file, so finishing would leave a
  // Jarvis the user was running unattachable to any newly opened HUD.
  if (existsSync(tokenFilePath())) {
    console.error(
      `A Jarvis runtime token already exists at ${tokenFilePath()}.\n` +
        "Quit the running Jarvis first (tray → Quit): this probe stops and starts\n" +
        "runtimes and would revoke that token on the way out.",
    );
    process.exit(1);
  }

  if (!asJson) {
    console.log("\nPackaged Jarvis, launched the way a Run key launches it.");
    console.log(`  binary : ${exe}`);
    console.log(`  cwd    : ${RUN_KEY_CWD}   ← the whole point`);
    console.log("  (scenario 2 opens the microphone locally — see the header)\n");
  }

  note("installer produced", existsSync(installer) ? `${installer}` : "not built (win-unpacked only)");

  const config = loadConfig();
  check(
    "config records a workingDirectory for the installed app",
    typeof config.workingDirectory === "string" && existsSync(config.workingDirectory),
    `${config.workingDirectory ?? "(unset)"} — ${configFilePath()}`,
  );

  // ---------------------------------------------------------------------
  // 1. The defect, reproduced. Without this, scenario 2 proves nothing.
  // ---------------------------------------------------------------------
  if (!asJson) console.log("\n[1] the old behaviour: working directory forced to system32\n");

  const broken = launch(exe, { JARVIS_CWD: RUN_KEY_CWD });
  let brokenClient: PipeClient | null = null;
  try {
    brokenClient = await attach("probe-install-broken");
    check("the packaged app starts a runtime at all", brokenClient !== null);
    if (brokenClient) {
      // Immediate, not awaited: a daemon that cannot be found fails at resolve
      // time rather than after loading models.
      const s = await pollStatus(
        brokenClient,
        (st) => st.subsystems.wakeWord.state !== "starting",
        30_000,
      );
      const detail = s?.subsystems.wakeWord.detail ?? "";
      check(
        "…and from the wrong directory, voice reports it cannot find its assets",
        s?.subsystems.wakeWord.state === "unavailable" && isResolutionFailure(detail),
        detail || "(no detail)",
      );
    }
  } finally {
    await shutdown(brokenClient, broken);
  }
  check("the broken run left no token behind", readToken() === null);
  await clearExistingRuntime("scenario 2");

  // ---------------------------------------------------------------------
  // 2. The real thing: same binary, same cwd, config consulted.
  // ---------------------------------------------------------------------
  if (!asJson) console.log("\n[2] the shipped behaviour: workingDirectory read from config\n");

  const live = launch(exe);
  let client: PipeClient | null = null;
  try {
    client = await attach("probe-install");
    check("shell is still running", !live.exited());
    // This is also the first time the packaged `--runtime` re-launch has ever
    // executed: in dev the runtime is spawned as `electron … tsx src/runtime/
    // main.ts`, and the packaged branch — one exe, two modes — had no coverage.
    check("a runtime came up and accepts an authenticated client", client !== null);
    if (!client) {
      report();
      return;
    }

    const boot = (await client.request({ type: "get_status" })) as RuntimeStatus;
    check("runtime answers status through IPC", typeof boot.state === "string", `state=${boot.state}`);

    // §62: "no unnecessary main window". `--minimized` must mean tray only.
    const window = await hasVisibleWindow(live.shell.pid ?? 0);
    check(
      "no main window was created (tray only)",
      window === false,
      window === null ? "could not enumerate windows" : window ? "a window is on screen" : "no top-level window",
    );

    // The §62-critical one. Wait for voice to finish loading, then require that
    // it is genuinely working — not merely that it failed for a different reason.
    if (!asJson) console.log("\n    waiting for the voice daemon to load models…");
    const voice = await pollStatus(
      client,
      (st) => st.subsystems.wakeWord.state !== "starting",
      VOICE_TIMEOUT_MS,
    );
    const wake = voice?.subsystems.wakeWord ?? { state: "unavailable", detail: "no status" };
    check(
      "voice resolved its assets from the configured directory",
      !isResolutionFailure(wake.detail ?? ""),
      wake.detail ?? "(no detail)",
    );
    check(
      "the wake word is live — Jarvis can hear its own name",
      wake.state === "available",
      `${wake.state}: ${wake.detail ?? ""}`,
    );
    for (const which of ["stt", "tts"] as const) {
      const sub = voice?.subsystems[which];
      check(
        `${which} is available`,
        sub?.state === "available",
        `${sub?.state ?? "?"}: ${sub?.detail ?? ""}`,
      );
    }
    note(
      "voice daemon pid",
      voice?.voice.pid ? `${voice.voice.pid} (device: ${voice.voice.device ?? "default"})` : "none",
    );

    // A local answer through the real IPC path, from a process Windows started
    // in system32. §63's "What's my RAM usage?" without a model behind it.
    const answer = await answerFor(client, "what's my battery");
    check(
      "answers a local question from the packaged binary",
      /\d/.test(answer),
      answer.slice(0, 80) || "(no answer)",
    );

    // Things Hermes and Claude Code need, checked from *this* environment rather
    // than from a dev shell — a user-PATH-only tool works when you type it and
    // is not necessarily there at logon.
    try {
      const hermes = resolveHermesExecutable();
      check(
        "Hermes resolves to an absolute path, so it is cwd-independent",
        existsSync(hermes.path) && /^[a-zA-Z]:\\/.test(hermes.path),
        hermes.path,
      );
    } catch (err) {
      check("Hermes resolves", false, err instanceof Error ? err.message : String(err));
    }
    note("Hermes subsystem", `${boot.subsystems.hermes.state}: ${boot.subsystems.hermes.detail ?? ""}`);

    // ffmpeg must be on the *machine* PATH: the daemon shells out to it for
    // dshow capture, and a user-PATH entry is not guaranteed at logon.
    const machinePath = await machineEnvPath();
    const ffmpegMachine = machinePath.some((d) => existsSync(join(d, "ffmpeg.exe")));
    check(
      "ffmpeg is on the machine PATH, not just the user's",
      ffmpegMachine,
      ffmpegMachine ? "inherited at logon" : "only on the user PATH — capture may fail at startup",
    );

    const claude = await which("claude");
    note("claude CLI", claude ?? "not on PATH (§67 delegation would be unavailable)");

    // Decision 2: the installer writes no Run key, and neither does launching.
    const enabled = await new AutostartManager().isEnabled();
    check(
      "no Run-key entry exists — start-with-Windows is still the user's choice",
      enabled === false,
      "HKCU\\…\\Run has no Jarvis value",
    );

    // §72's figure was measured on a Node runtime. This is the Electron one the
    // user will actually run, which is a different number and belongs in the doc.
    // The count is not "two": one binary in two modes, plus Electron's own
    // helpers, and a probe that asserted two would have been wrong in a way that
    // reads as a leak the first time someone opens Task Manager. Attribute each
    // helper to its parent — the shell runs a window so it may legitimately have
    // GPU helpers; the runtime is supposed to be headless, so a GPU helper under
    // *it* would be the thing worth failing on.
    const procs = await jarvisProcesses();
    const roleOf = (p: { pid: number; cmd: string }): string => {
      const t = /--type=([a-zA-Z-]+)/.exec(p.cmd);
      if (t) return `helper:${t[1]}`;
      // The packaged runtime is `Jarvis.exe out\main\runtime.js` under
      // ELECTRON_RUN_AS_NODE — it carries no `--runtime` flag, because the flag
      // form costs a GPU process. `--runtime` is still matched: it remains a
      // working diagnostic entry point.
      return /runtime\.js|--runtime\b/.test(p.cmd) ? "runtime" : "shell";
    };
    const parentOf = (pid: number) => procs.filter((p) => p.ppid === pid);
    const byRole = new Map<string, { pid: number; ppid: number; rssMb: number }[]>();
    for (const p of procs) {
      const key = roleOf(p);
      byRole.set(key, [...(byRole.get(key) ?? []), p]);
    }
    check(
      "exactly one shell process and one runtime process",
      byRole.get("shell")?.length === 1 && byRole.get("runtime")?.length === 1,
      [...byRole]
        .map(([r, ps]) => `${r}×${ps.length}`)
        .sort()
        .join(" "),
    );
    const helpersOf = (pid: number) => parentOf(pid).filter((p) => /^helper:/.test(roleOf(p)));
    const shellPid = byRole.get("shell")?.[0]?.pid ?? -1;
    const runtimePid = byRole.get("runtime")?.[0]?.pid ?? -1;
    const runtimeHelpers = helpersOf(runtimePid);
    const gpuHelpers = procs.filter((p) => /^helper:gpu/.test(roleOf(p)));
    check(
      "the runtime is headless: no GPU helper under the runtime",
      runtimeHelpers.filter((h) => /^helper:gpu/.test(roleOf(h))).length === 0,
      runtimeHelpers.length ? runtimeHelpers.map((h) => `${roleOf(h)}/${h.pid}`).join(" ") : "none",
    );
    const shellGpu = gpuHelpers.filter((h) => h.ppid === shellPid);
    check(
      "the shell's GPU helpers are the shell's",
      gpuHelpers.every((h) => h.ppid === shellPid),
      gpuHelpers.length
        ? gpuHelpers
            .map((h) => `pid ${h.pid} under ${h.ppid === shellPid ? "shell" : "runtime"}`)
            .join(", ")
        : "none",
    );
    for (const [r, ps] of [...byRole].sort()) {
      note(
        `  ${r}`,
        ps.map((p) => `pid ${p.pid} ${p.rssMb.toFixed(0)} MB${p.ppid === shellPid ? " (under shell)" : ""}${p.ppid === runtimePid ? " (under runtime)" : ""}`).join(", "),
      );
    }
    note(
      "packaged RSS total",
      `${procs.reduce((a, p) => a + p.rssMb, 0).toFixed(0)} MB across ${procs.length} process(es)`,
    );
  } finally {
    await shutdown(client, live);
  }

  check("token was revoked on shutdown", readToken() === null);
  const left = await jarvisProcesses();
  check(
    "no Jarvis process was left behind",
    left.length === 0,
    left.length ? left.map((p) => p.pid).join(", ") : "clean",
  );

  report();
}

/** Ask through IPC and collect what a user would hear. */
async function answerFor(ui: PipeClient, text: string): Promise<string> {
  const chunks: string[] = [];
  let done = false;
  const onChunk = (e: { text: string }): void => void chunks.push(e.text);
  const onDone = (): void => void (done = true);
  ui.on("reply_chunk", onChunk);
  ui.on("reply_done", onDone);
  try {
    await ui.request({ type: "prompt", text });
    const deadline = Date.now() + 20_000;
    while (!done && Date.now() < deadline) await wait(100);
  } catch {
    /* a throw is an answer too — the caller's check judges the empty string */
  } finally {
    ui.off("reply_chunk", onChunk);
    ui.off("reply_done", onDone);
  }
  return chunks.join("").trim();
}

/** The Machine PATH, read from the registry rather than from this process. */
async function machineEnvPath(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "[Environment]::GetEnvironmentVariable('Path','Machine')",
    ]);
    return stdout.split(delimiter).map((d) => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
  } catch {
    return [];
  }
}

async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("where", [cmd]);
    return stdout.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

function report(): void {
  const failed = results.filter((r) => r.verdict === "FAIL").length;
  const gated = results.filter((r) => r.verdict !== "INFO").length;
  if (asJson) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    console.log(`\n${gated - failed}/${gated} passed`);
    if (failed === 0) {
      console.log("The packaged app works from the directory Windows gives it.");
      console.log("Still manual (§62): install, tick Start with Windows, reboot, say \"Jarvis\".");
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
