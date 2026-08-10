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

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

async function main(): Promise<void> {
  const config = loadConfig(undefined, (msg) => console.log(`[${timestamp()}] ${msg}`));
  // Order matters, and it is the least surprising one: an explicit env var beats
  // a file, and a file beats wherever Windows happened to start the process.
  // That last fallback is the one that bites — a Run-key launch gets
  // `C:\Windows\system32`, where the venv, the voice daemon, the Piper voice and
  // the Whisper cache all resolve to nothing. `workingDirectory` is how an
  // installed build says where its assets actually live; see `JarvisConfig`.
  const cwd = process.env.JARVIS_CWD ?? config.workingDirectory ?? process.cwd();
  const runtime = new JarvisRuntime({
    cwd,
    onLog: (line) => console.log(`[${timestamp()}] ${line}`),
  });

  if (config.workingDirectory && !process.env.JARVIS_CWD) {
    console.log(`[${timestamp()}] working directory from config: ${cwd}`);
  }

  runtime.on("state", (s: string) => console.log(`[${timestamp()}] state: ${s}`));

  let shuttingDown = false;
  const shutdown = async (reason: string, code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${timestamp()}] shutting down (${reason})`);
    await runtime.stop();
    process.exit(code);
  };

  runtime.on("quit-requested", () => void shutdown("quit requested via IPC"));

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Windows sends this when the console window closes.
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  process.on("uncaughtException", (err) => {
    // An always-on process must not die silently on an unhandled error.
    console.error(`[${timestamp()}] uncaught exception:`, err);
  });
  process.on("unhandledRejection", (err) => {
    console.error(`[${timestamp()}] unhandled rejection:`, err);
  });

  try {
    await runtime.start();
  } catch (err) {
    console.error(
      `[${timestamp()}] runtime failed to start: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
  }

  console.log(`[${timestamp()}] Jarvis runtime is up. Ctrl+C to stop.`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
