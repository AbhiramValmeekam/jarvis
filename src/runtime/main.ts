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

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

async function main(): Promise<void> {
  const runtime = new JarvisRuntime({
    cwd: process.env.JARVIS_CWD ?? process.cwd(),
    onLog: (line) => console.log(`[${timestamp()}] ${line}`),
  });

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
