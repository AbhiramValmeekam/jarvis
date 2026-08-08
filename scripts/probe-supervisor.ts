/**
 * Crash-recovery proof: kill the real Hermes process and verify the supervisor
 * brings it back, unattended, and that the assistant is usable afterwards.
 *
 * This is a REAL integration test. It spawns real Hermes and really kills it.
 * Run: npx tsx scripts/probe-supervisor.ts
 */
import { spawn } from "node:child_process";
import { HermesSupervisor } from "../src/system/hermes-supervisor.js";

function killPid(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
  } else {
    process.kill(pid, "SIGKILL");
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForReady(sup: HermesSupervisor, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sup.isReady()) return true;
    if (sup.getStatus().gaveUpReason) return false;
    await wait(200);
  }
  return false;
}

/** Resolve once the supervisor observes the process death. */
function waitForCrash(sup: HermesSupervisor, timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    sup.once("crash", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function main(): Promise<void> {
  let failures = 0;
  const check = (label: string, ok: boolean) => {
    console.log(`${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failures++;
  };

  const sup = new HermesSupervisor({
    cwd: process.cwd(),
    restart: { baseDelayMs: 500, maxRestarts: 3, windowMs: 60_000 },
  });

  sup.on("state", (s: string) => console.log(`  [state] ${s}`));
  sup.on("crash", (e: string) => console.log(`  [crash] ${e}`));
  sup.on("restarting", (i: { attempt: number; delayMs: number }) =>
    console.log(`  [restart] attempt ${i.attempt} in ${i.delayMs}ms`),
  );
  sup.on("gave-up", (r: string) => console.log(`  [gave-up] ${r}`));

  // --- 1. cold start -------------------------------------------------------
  console.log("\n[1] cold start");
  await sup.start();
  check("supervisor reaches ready", sup.isReady());
  const firstPid = sup.getStatus().hermes?.pid ?? null;
  const firstSession = sup.getStatus().sessionId;
  check("has a hermes pid", firstPid !== null);
  check("has a session id", firstSession !== null);
  console.log(`    pid=${firstPid} session=${firstSession}`);

  // --- 2. kill it and expect unattended recovery ---------------------------
  console.log("\n[2] killing Hermes to force recovery");
  // taskkill is asynchronous, so wait for the supervisor to actually observe
  // the death before asserting anything about recovery.
  const crashSeen = waitForCrash(sup);
  if (firstPid) killPid(firstPid);
  check("supervisor detected the kill", await crashSeen);

  const recovered = await waitForReady(sup);
  check("supervisor recovered automatically", recovered);

  const secondPid = sup.getStatus().hermes?.pid ?? null;
  const secondSession = sup.getStatus().sessionId;
  check("respawned with a different pid", secondPid !== null && secondPid !== firstPid);
  check("established a fresh session", secondSession !== null);
  check("restart was counted", sup.getStatus().restartCount >= 1);
  console.log(`    pid=${secondPid} session=${secondSession}`);

  // --- 3. still actually usable -------------------------------------------
  console.log("\n[3] prompting after recovery");
  if (recovered) {
    let text = "";
    try {
      const stop = await sup.streamMessage(
        "Reply with exactly: RECOVERED_OK",
        (e) => {
          if (e.kind === "text") text += e.text;
        },
      );
      console.log(`    stopReason=${stop} reply=${JSON.stringify(text.trim())}`);
    } catch (err) {
      console.log(`    prompt failed: ${err instanceof Error ? err.message : err}`);
    }
    check("agent responds after restart", text.trim().length > 0);
  } else {
    check("agent responds after restart", false);
  }

  // --- 4. suspend / resume (sleep simulation) ------------------------------
  console.log("\n[4] suspend / resume");
  await sup.suspend();
  check("suspend stops Hermes", sup.getStatus().state === "suspended");
  check("no hermes process while suspended", sup.getStatus().hermes === null);

  await sup.resume();
  const resumed = await waitForReady(sup);
  check("resume restores Hermes with no user action", resumed);
  console.log(`    pid=${sup.getStatus().hermes?.pid ?? null}`);

  // --- 5. intentional stop must NOT restart --------------------------------
  console.log("\n[5] intentional stop");
  await sup.stop();
  check("stop leaves state=stopped", sup.getStatus().state === "stopped");
  await wait(2500); // longer than any backoff
  check("no phantom restart after stop", sup.getStatus().state === "stopped");

  console.log(`\n${failures === 0 ? "✓ PASS" : `✗ FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("✗ probe failed:", err);
  process.exit(1);
});
