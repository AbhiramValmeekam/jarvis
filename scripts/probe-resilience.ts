/**
 * Phase 12 gate: does Jarvis survive the three things that actually happen?
 *
 * A laptop sleeps. A process dies. The internet goes away on a train. §62 and
 * §71 name all three, and each one has the same failure mode if it is handled
 * badly — the user says "Jarvis" and nothing happens, which is the only bug this
 * project cannot recover from, because they stop saying it.
 *
 * The unit suites already cover the *logic* of all three
 * (`SURVIVES a sleep/resume cycle with the UI still attached`,
 * `SURVIVES Hermes being killed and reports the recovery to the UI`,
 * `refuses to prompt when Hermes is unavailable instead of hanging`). What they
 * cannot cover is the property that only exists in a real process: that the pipe
 * server, the local intent engine and the task watcher are still *there*
 * afterwards, in one process, that a UI attached before the event is still
 * attached after it, and that none of it needed a human to intervene. That is
 * what this probe adds, and it is the difference between "the state machine
 * transitions correctly" and "your assistant still works after lunch".
 *
 * Four scenarios, each ending in the same question — can you still get an answer?
 *
 *   1. OFFLINE (§71)   Hermes is stopped, which is what losing model access
 *                      looks like from inside this process. "What's my battery?"
 *                      must still be answered — from the OS, not from a cache —
 *                      and a request that genuinely needs the model must say so
 *                      plainly rather than hanging or inventing a reply.
 *   2. RECOVERY (§71)  Hermes comes back with nobody touching anything.
 *   3. CRASH (§62)     Hermes is killed mid-life. The runtime must not go down
 *                      with it, the attached UI must stay attached, and the
 *                      error must be reported as non-fatal.
 *   4. SLEEP (§62)     Suspend and resume. Hermes is honestly reported as gone
 *                      while suspended rather than as working, an in-flight turn
 *                      does not survive the machine sleeping, and the local layer
 *                      answers throughout.
 *
 * **How "offline" is simulated, and why it is not a lie.** By stopping Hermes,
 * not by touching the network. §61 forbids disabling the firewall or bypassing
 * Windows security, and pulling the adapter would be neither honest nor
 * reversible if this probe crashed halfway. From this process's point of view the
 * two are the same event — the agent cannot be reached — and that is precisely
 * the condition §71 asks about. What it does NOT prove is Hermes' own behaviour
 * with a dead socket; that belongs to Hermes.
 *
 * **What it does to your machine.** One runtime on a probe-only pipe, voice off
 * (the microphone is never opened), Hermes faked so no model is called and
 * nothing is spent, and every Hermes path pointed at a temp fixture so the real
 * config, memories and cron state are neither read nor written. The battery
 * question is answered by real PowerShell against the real battery.
 *
 * **One shared file it does touch:** `%LOCALAPPDATA%\Jarvis\runtime-token`.
 * `JarvisRuntime.start()` publishes a token there and `stop()` revokes it, and
 * the path is not injectable. So running this while a real Jarvis is up would
 * leave that Jarvis serving a pipe whose token file has been deleted — its
 * already-attached HUD keeps working, a newly opened one could not attach until
 * the runtime is restarted. Hence the guard below: if the token file exists on
 * entry, this probe says so and stops rather than stepping on it.
 *
 *   npx tsx scripts/probe-resilience.ts [--json]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JarvisRuntime } from "../src/runtime/jarvis-runtime.js";
import { PipeClient } from "../src/ipc/pipe-client.js";
import { readToken } from "../src/ipc/token.js";
import { refuseIfRuntimeLive } from "./runtime-guard.js";
import { FakeAdapter } from "../tests/helpers/fake-adapter.js";
import type { RuntimeStatus } from "../src/ipc/contract.js";

const asJson = process.argv.includes("--json");

const results: { name: string; verdict: string; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, verdict: ok ? "PASS" : "FAIL", detail });
  if (!asJson) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until true or the deadline passes. Returns whether it happened. */
async function until(fn: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await wait(50);
  }
  return false;
}

function pipePath(name: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `/tmp/${name}.sock`;
}

interface Fixture {
  dir: string;
  cron: string;
  memories: string;
  skills: string;
  bundled: string;
}

/** A Hermes fixture, so the real `%LOCALAPPDATA%\hermes` is never touched. */
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-resilience-"));
  writeFileSync(join(dir, "config.yaml"), "_config_version: 33\n");
  const f: Fixture = {
    dir,
    cron: join(dir, "cron"),
    memories: join(dir, "memories"),
    skills: join(dir, "skills"),
    bundled: join(dir, "bundled"),
  };
  for (const d of [f.cron, f.memories, f.skills, f.bundled]) {
    mkdirSync(d, { recursive: true });
  }
  return f;
}

async function main(): Promise<void> {
  if (!asJson) {
    console.log("\nResilience: offline, recovery, crash, sleep/resume.");
    console.log("(no mic, no model call, no network change — see the header)\n");
  }

  // Refuse rather than clobber. `start()` overwrites the shared token file and
  // `stop()` deletes it, so a live Jarvis would be left unattachable by a probe
  // that claims to touch nothing. A stale token left by an earlier run is not
  // that, and refusing on it would be a false alarm — see `runtime-guard.ts`.
  await refuseIfRuntimeLive();

  const fx = fixture();
  const pipeName = pipePath(`jarvis-probe-resilience-${process.pid}`);
  const errors: Array<{ message: string; fatal: boolean }> = [];

  const runtime = new JarvisRuntime({
    pipeName,
    lazyHermes: true,
    createAdapter: () => new FakeAdapter(),
    voice: { enabled: false },
    cronDir: fx.cron,
    hermesConfigPath: join(fx.dir, "config.yaml"),
    hermesMemoryDir: fx.memories,
    memoryPath: join(fx.dir, "memory.json"),
    skillRoots: [fx.skills, fx.bundled],
  });

  await runtime.start();

  /**
   * A UI attached once, at the start. Every scenario asks whether it survived.
   *
   * The token comes from the shared file, as a real HUD's does. That is only
   * safe because of the guard above: the sole token on disk right now is the one
   * this probe's own `start()` just published, so `readToken()` cannot pick up —
   * or be confused by — credentials belonging to a Jarvis the user was running.
   */
  const ui = new PipeClient({
    pipeName,
    token: readToken() ?? undefined,
    clientName: "probe-resilience",
    autoReconnect: false,
    requestTimeoutMs: 30_000,
  });
  await ui.connectAndAuthenticate();
  ui.on("error", (e: { message: string; fatal: boolean }) => errors.push(e));

  const status = async (): Promise<RuntimeStatus> =>
    (await ui.request({ type: "get_status" })) as RuntimeStatus;

  try {
    // --- 1. OFFLINE (§71) -------------------------------------------------
    if (!asJson) console.log("\n[1] offline — model access is gone\n");

    check(
      "Hermes reports unavailable, not working",
      (await status()).subsystems.hermes.state === "unavailable",
      (await status()).subsystems.hermes.detail ?? "",
    );

    // The §71 question, asked through the real IPC path against the real
    // battery. Not `engine.handle(...)` directly: the point is that the whole
    // chain — pipe, runtime, intent engine, PowerShell — works with no agent
    // behind it, and a direct call would prove only the last link.
    const battery = await answerFor(ui, "what's my battery");
    check(
      "answers a local question with no agent behind it",
      /\d/.test(battery) && battery.length > 0,
      battery.slice(0, 80) || "(no answer)",
    );

    // And a request that genuinely needs the model is refused in words, rather
    // than hanging until the user gives up — the failure §71 actually warns
    // about is a Jarvis that looks like it is thinking.
    const t0 = Date.now();
    let refusal = "";
    try {
      await ui.request({ type: "prompt", text: "write me a haiku about tuesday" });
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
    }
    const elapsed = Date.now() - t0;
    check(
      "says the model is unavailable instead of hanging",
      /not available|unavailable/i.test(refusal) && elapsed < 5_000,
      `${refusal.slice(0, 60)} (${elapsed} ms)`,
    );

    // --- 2. RECOVERY (§71) ------------------------------------------------
    if (!asJson) console.log("\n[2] model access returns\n");

    await runtime.supervisor.start();
    const back = await until(() => runtime.supervisor.isReady());
    check("Hermes returns without the user doing anything", back);
    check(
      "and the reconnection is visible to an attached UI",
      (await status()).subsystems.hermes.state === "available",
    );

    // --- 3. CRASH (§62) ---------------------------------------------------
    if (!asJson) console.log("\n[3] Hermes is killed\n");

    errors.length = 0;
    FakeAdapter.latest.crash();

    const told = await until(() => errors.length > 0);
    check("the UI is told about the crash", told, errors[0]?.message ?? "(nothing)");
    check(
      "and told it is not fatal — the assistant is still here",
      errors[0]?.fatal === false,
    );
    // The load-bearing one. A runtime that dies with Hermes is a Jarvis that
    // needs relaunching by hand, which is the whole promise gone.
    check("the runtime process is still serving IPC", ui.isConnected);

    const recovered = await until(() => runtime.supervisor.isReady(), 20_000);
    check("Hermes is restarted unattended", recovered);
    check(
      "the restart is counted rather than hidden",
      runtime.supervisor.getStatus().restartCount >= 1,
      `restartCount=${runtime.supervisor.getStatus().restartCount}`,
    );

    // --- 4. SLEEP / RESUME (§62) ------------------------------------------
    if (!asJson) console.log("\n[4] the laptop sleeps and wakes\n");

    await runtime.onSystemSuspend();
    const suspended = await status();
    check(
      "Hermes is honestly reported as gone while suspended",
      suspended.subsystems.hermes.state === "unavailable" &&
        /sleep/i.test(suspended.subsystems.hermes.detail ?? ""),
      suspended.subsystems.hermes.detail ?? "",
    );
    check("the UI survived the machine sleeping", ui.isConnected);

    // §71's local guarantee has to hold here too. A user who opens the lid and
    // asks a question should not have to wait for an agent to boot first.
    const asleepAnswer = await answerFor(ui, "what's my battery");
    check(
      "local questions are still answered while suspended",
      /\d/.test(asleepAnswer),
      asleepAnswer.slice(0, 80) || "(no answer)",
    );

    await runtime.onSystemResume();
    const woke = await until(() => runtime.supervisor.isReady(), 20_000);
    check("Hermes comes back on resume with no user action", woke);

    // The close §71 actually asks for — "reconnect restores Hermes
    // automatically" — proven by the *same sentence* that was refused in
    // scenario 1 now returning an answer. An earlier draft asserted
    // `state === "idle"` here instead and failed: the local answer given during
    // suspend had opened the 30 s follow-up window, so the machine was sitting
    // in `conversation`, which is correct behaviour and a wrong assertion. A
    // completed turn is the property worth checking; the enum was never it.
    const afterAll = await answerFor(ui, "write me a haiku about tuesday");
    check(
      "a request that needed the model is answered again after all of it",
      afterAll.length > 0,
      afterAll.slice(0, 60) || "(no answer)",
    );
    check(
      "and the runtime is in a serving state, not an error state",
      (await status()).state !== "error",
      runtime.machine.state,
    );
    check("the same UI client is still attached", ui.isConnected);
  } finally {
    await ui.close();
    await runtime.stop();
    rmSync(fx.dir, { recursive: true, force: true });
  }

  report();
}

/**
 * Ask through IPC and collect what a user would hear.
 *
 * Reads `reply_chunk` up to `reply_done` rather than the request's return value:
 * a local answer is streamed to every attached UI exactly as an agent reply is,
 * and reading it the way the HUD does is what makes this evidence about the
 * user's experience rather than about a function's return.
 */
async function answerFor(ui: PipeClient, text: string): Promise<string> {
  const chunks: string[] = [];
  let done = false;
  const onChunk = (e: { text: string }): void => {
    chunks.push(e.text);
  };
  const onDone = (): void => {
    done = true;
  };
  ui.on("reply_chunk", onChunk);
  ui.on("reply_done", onDone);
  try {
    await ui.request({ type: "prompt", text });
    await until(() => done, 20_000);
  } catch {
    // A throw is itself an answer for the caller to judge — an offline refusal
    // arrives this way — so it is not swallowed silently, it is returned empty
    // and the check that wanted text fails.
  } finally {
    ui.off("reply_chunk", onChunk);
    ui.off("reply_done", onDone);
  }
  return chunks.join("").trim();
}

function report(): void {
  const failed = results.filter((r) => r.verdict === "FAIL").length;
  if (asJson) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    console.log(`\n${results.length - failed}/${results.length} passed`);
    if (failed === 0) {
      console.log("Offline, crash and sleep all end with a working assistant.");
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
