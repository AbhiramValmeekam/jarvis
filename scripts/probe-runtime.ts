/**
 * End-to-end runtime proof, against the real runtime process and real Hermes.
 *
 * Verifies the Phase 2 gate the way a user would experience it:
 *   - the runtime runs as its own process with no UI
 *   - a UI attaches, talks, and detaches — and the runtime carries on
 *   - a real agent turn works through IPC
 *   - only an explicit quit stops it
 *
 * Run: npx tsx scripts/probe-runtime.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { PipeClient } from "../src/ipc/pipe-client.js";
import { readToken } from "../src/ipc/token.js";
import type { RuntimeStatus } from "../src/ipc/contract.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
}

async function attach(name: string): Promise<PipeClient> {
  const c = new PipeClient({
    token: readToken() ?? undefined,
    clientName: name,
    autoReconnect: false,
    requestTimeoutMs: 120_000,
  });
  await c.connectAndAuthenticate();
  return c;
}

async function main(): Promise<void> {
  console.log("\n[1] starting the runtime as a separate process");
  const proc: ChildProcess = spawn(
    process.execPath,
    [
      new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname.replace(/^\//, ""),
      new URL("../src/runtime/main.ts", import.meta.url).pathname.replace(/^\//, ""),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (d: string) =>
    d.trimEnd().split("\n").forEach((l) => console.log(`    runtime| ${l}`)),
  );
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (d: string) =>
    d.trimEnd().split("\n").forEach((l) => console.log(`    runtime! ${l}`)),
  );

  let exited = false;
  proc.on("exit", () => (exited = true));

  // Give it a moment to bind the pipe and publish its token.
  await wait(3_000);
  check("runtime process is alive", !exited);

  // --- 2. a UI attaches ----------------------------------------------------
  console.log("\n[2] attaching a UI");
  const ui1 = await attach("probe-ui-1");
  check("UI authenticated", ui1.isConnected);

  const status = (await ui1.request({ type: "get_status" })) as RuntimeStatus;
  check("status returned", typeof status.state === "string");
  console.log(
    `    state=${status.state} hermes=${status.subsystems.hermes.state}` +
      ` wake=${status.subsystems.wakeWord.state}` +
      ` stt=${status.subsystems.stt.state} tts=${status.subsystems.tts.state}`,
  );
  // This used to assert all three were flatly `unavailable`, which was the
  // honest answer in Phase 2 when there was no voice stack to be available. It
  // is now a lie in the other direction: on this machine the daemon comes up
  // and the check failed on `starting`. What the probe actually wants to police
  // is the honesty rule itself — never claim a capability that does not work,
  // and never refuse one without saying why — so that is what it asks now.
  const voice = [
    ["wakeWord", status.subsystems.wakeWord],
    ["stt", status.subsystems.stt],
    ["tts", status.subsystems.tts],
  ] as const;
  const known = new Set(["available", "unavailable", "starting", "degraded"]);
  check(
    "voice subsystems report a real state",
    voice.every(([, s]) => known.has(s.state)),
  );
  const mute = voice.filter(([, s]) => s.state === "unavailable");
  check(
    mute.length === 0
      ? "no voice subsystem is unavailable"
      : `every unavailable voice subsystem explains itself (${mute
          .map(([n]) => n)
          .join(", ")})`,
    mute.every(([, s]) => (s.detail ?? "").trim().length > 0),
  );

  // --- 3. UI closes; runtime must not care --------------------------------
  console.log("\n[3] closing the UI");
  await ui1.close();
  await wait(1_000);
  check("runtime survived the UI closing", !exited);

  const ui2 = await attach("probe-ui-2");
  check("a new UI can attach to the same runtime", ui2.isConnected);

  // --- 4. a real agent turn through IPC ------------------------------------
  console.log("\n[4] waiting for Hermes, then prompting through IPC");
  let hermesReady = false;
  for (let i = 0; i < 60; i++) {
    const s = (await ui2.request({ type: "get_status" })) as RuntimeStatus;
    if (s.subsystems.hermes.state === "available") {
      hermesReady = true;
      break;
    }
    if (s.subsystems.hermes.state === "unavailable" && s.hermes.gaveUpReason) break;
    await wait(1_000);
  }
  check("Hermes became available", hermesReady);

  if (hermesReady) {
    let reply = "";
    let done = false;
    ui2.on("reply_chunk", (e: { text: string }) => (reply += e.text));
    ui2.on("reply_done", () => (done = true));

    // Two clocks, because the runtime answers a prompt when it *accepts* the
    // turn, not when the turn finishes — an agent can think, call tools, or sit
    // on a permission dialog for far longer than any IPC deadline should allow
    // (see `JarvisRuntime.acceptPrompt`). So the request resolving proves the
    // prompt was taken, and the reply itself arrives as events afterwards.
    const t0 = Date.now();
    await ui2.request({ type: "prompt", text: "Reply with exactly: RUNTIME_OK" });
    const accepted = Date.now() - t0;

    // Generous, and deliberately not a `requestTimeoutMs`: this is how long a
    // real turn is allowed to take, which is a different question from whether
    // the runtime is still answering.
    for (let i = 0; i < 120 && !done; i++) await wait(1_000);
    const elapsed = Date.now() - t0;

    console.log(
      `    accepted in ${accepted}ms; reply=${JSON.stringify(reply.trim())} in ${elapsed}ms`,
    );
    check("prompt was accepted promptly", accepted < 5_000);
    check("agent replied through IPC", reply.trim().length > 0);
    check("reply_done was broadcast", done);
  } else {
    check("prompt was accepted promptly", false);
    check("agent replied through IPC", false);
    check("reply_done was broadcast", false);
  }

  // --- 5. second instance must refuse -------------------------------------
  console.log("\n[5] second runtime instance must refuse to start");
  const second = spawn(
    process.execPath,
    [
      new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url).pathname.replace(/^\//, ""),
      new URL("../src/runtime/main.ts", import.meta.url).pathname.replace(/^\//, ""),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let secondOut = "";
  second.stdout?.setEncoding("utf8");
  second.stderr?.setEncoding("utf8");
  second.stdout?.on("data", (d: string) => (secondOut += d));
  second.stderr?.on("data", (d: string) => (secondOut += d));
  const secondCode = await new Promise<number | null>((r) =>
    second.on("exit", (c) => r(c)),
  );
  check("second instance exited non-zero", secondCode !== 0);
  check(
    "second instance explained why",
    /already running/i.test(secondOut),
  );

  // The original must be untouched by that.
  check("original runtime still alive", !exited);
  const stillOk = (await ui2.request({ type: "get_status" })) as RuntimeStatus;
  check("original runtime still serving", typeof stillOk.state === "string");

  // --- 6. explicit quit ----------------------------------------------------
  console.log("\n[6] explicit quit");
  await ui2.request({ type: "quit" });
  await ui2.close();

  const quitCleanly = await Promise.race([
    new Promise<boolean>((r) => proc.on("exit", () => r(true))),
    wait(10_000).then(() => false),
  ]);
  check("runtime exited on explicit quit", quitCleanly);
  if (!quitCleanly) proc.kill();

  check("token was revoked on shutdown", readToken() === null);

  console.log(`\n${failures === 0 ? "✓ PASS" : `✗ FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("✗ probe failed:", err);
  process.exit(1);
});
