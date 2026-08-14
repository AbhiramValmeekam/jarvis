/**
 * Headless runtime entrypoint.
 *
 *   npx tsx src/runtime/main.ts
 *
 * Runs with no window and no Electron. The UI is a separate, optional process
 * that attaches over the named pipe — which is exactly why closing the UI
 * cannot take Jarvis down.
 */
import { JarvisRuntime } from "./jarvis-runtime.js";
import { loadConfig } from "../context/config.js";
import { openLogFile } from "../system/log-file.js";

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

/**
 * Everything the console gets, the file gets.
 *
 * In a dev run this is redundant with the terminal. In the installed build it
 * is the only copy: `Jarvis.exe --runtime` is spawned detached with no console,
 * so every `console.log` below writes into a handle nobody holds. A user
 * reporting a failure on an installed machine has a red banner that vanishes
 * and nothing else — which is precisely how the "internal error" report
 * started. See `log-file.ts`.
 */
const logFile = openLogFile("runtime");

function say(line: string): void {
  console.log(`[${timestamp()}] ${line}`);
  logFile.write(line);
}

async function main(): Promise<void> {
  const config = loadConfig(undefined, say);
  // Order matters, and it is the least surprising one: an explicit env var beats
  // a file, and a file beats wherever Windows happened to start the process.
  // That last fallback is the one that bites — a Run-key launch gets
  // `C:\Windows\system32`, where the venv, the voice daemon, the Piper voice and
  // the Whisper cache all resolve to nothing. `workingDirectory` is how an
  // installed build says where its assets actually live; see `JarvisConfig`.
  const cwd = process.env.JARVIS_CWD ?? config.workingDirectory ?? process.cwd();
  // `microphone` is passed even when absent, in which case the daemon keeps its
  // old behaviour of taking whatever dshow enumerates first. That default is why
  // the key exists — see `JarvisConfig.microphone`.
  const runtime = new JarvisRuntime({ cwd, onLog: say, voice: { device: config.microphone } });

  say(`logging to ${logFile.path}`);
  if (config.workingDirectory && !process.env.JARVIS_CWD) {
    say(`working directory from config: ${cwd}`);
  }
  say(
    config.microphone
      ? `microphone from config: ${config.microphone}`
      : "no microphone pinned in config — using the first input Windows enumerates",
  );

  runtime.on("state", (s: string) => say(`state: ${s}`));

  let shuttingDown = false;
  const shutdown = async (reason: string, code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    say(`shutting down (${reason})`);
    await runtime.stop();
    process.exit(code);
  };

  runtime.on("quit-requested", () => void shutdown("quit requested via IPC"));

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Windows sends this when the console window closes.
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  const detail = (err: unknown): string =>
    err instanceof Error ? (err.stack ?? err.message) : String(err);

  process.on("uncaughtException", (err) => {
    // An always-on process must not die silently on an unhandled error — and
    // "silently" is literal in the packaged build, where the only reader of
    // stderr is nobody.
    console.error(`[${timestamp()}] uncaught exception:`, err);
    logFile.write(`uncaught exception: ${detail(err)}`);
  });
  process.on("unhandledRejection", (err) => {
    console.error(`[${timestamp()}] unhandled rejection:`, err);
    logFile.write(`unhandled rejection: ${detail(err)}`);
  });

  try {
    await runtime.start();
  } catch (err) {
    // The most important line in the file: an installed Jarvis that fails to
    // start shows the user nothing at all, so this is the only evidence.
    const message = `runtime failed to start: ${detail(err)}`;
    console.error(`[${timestamp()}] ${message}`);
    logFile.write(message);
    process.exit(1);
  }

  say("Jarvis runtime is up. Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("fatal:", err);
  openLogFile("runtime").write(
    `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
