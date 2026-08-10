/**
 * Desktop shell proof, against the real Electron app and the real runtime.
 *
 * The claim under test is the one the whole architecture exists for: the shell
 * is disposable, the assistant is not. So this probe does the rudest possible
 * thing — kills the shell outright, the way a crash would — and then checks
 * that Jarvis is still listening and still answers.
 *
 * Run: npm run build && npx tsx scripts/probe-shell.ts
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { PipeClient } from "../src/ipc/pipe-client.js";
import { readToken } from "../src/ipc/token.js";
import { AutostartManager } from "../src/system/autostart.js";
import type { RuntimeStatus } from "../src/ipc/contract.js";

const execFileAsync = promisify(execFile);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
}

async function attach(name: string): Promise<PipeClient | null> {
  const token = readToken();
  if (!token) return null;
  const c = new PipeClient({
    token,
    clientName: name,
    autoReconnect: false,
    requestTimeoutMs: 20_000,
  });
  try {
    await c.connectAndAuthenticate();
    return c;
  } catch {
    return null;
  }
}

/** Leave no runtime behind from an earlier run. */
async function clearExistingRuntime(): Promise<void> {
  const c = await attach("probe-shell-cleanup");
  if (!c) return;
  console.log("    (stopping a runtime left over from an earlier run)");
  await c.request({ type: "quit" }).catch(() => {});
  await c.close();
  await wait(1_500);
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("tasklist", ["/fi", `PID eq ${pid}`, "/nh"]);
    return stdout.includes(String(pid));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const electron = "node_modules/electron/dist/electron.exe";
  const entry = "out/main/main.js";
  if (!existsSync(electron)) throw new Error(`${electron} missing — run npm install`);
  if (!existsSync(entry)) throw new Error(`${entry} missing — run npm run build`);

  await clearExistingRuntime();

  // --- 1. start the shell --------------------------------------------------
  console.log("\n[1] starting the desktop shell (tray only)");
  const shell: ChildProcess = spawn(electron, [entry, "--minimized"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let shellOut = "";
  let shellExited = false;
  shell.stdout?.setEncoding("utf8");
  shell.stderr?.setEncoding("utf8");
  const capture = (d: string) => {
    shellOut += d;
    d.trimEnd()
      .split("\n")
      .forEach((l) => l.trim() && console.log(`    shell| ${l}`));
  };
  shell.stdout?.on("data", capture);
  shell.stderr?.on("data", capture);
  shell.on("exit", () => (shellExited = true));

  // --- 2. it must bring up a runtime ---------------------------------------
  console.log("\n[2] the shell should start a runtime and attach to it");
  let client: PipeClient | null = null;
  for (let i = 0; i < 40; i++) {
    await wait(500);
    client = await attach("probe-shell");
    if (client) break;
  }
  check("shell is still running", !shellExited);
  check("a runtime came up and accepts authenticated clients", client !== null);
  if (!client) {
    console.log(`\n--- shell output ---\n${shellOut}`);
    shell.kill();
    process.exit(1);
  }

  // The loop above waits until *this probe* can attach, which is a different
  // event from the shell attaching: the runtime starts listening, we win the
  // next 500 ms tick, and the shell's own attach and log write have not landed
  // yet. Asserting at that instant fails about one run in ten — observed, with
  // the line then appearing under [3]. Wait for the property instead.
  for (let i = 0; i < 20 && !/attached to/.test(shellOut); i++) await wait(250);
  check("shell reported attaching to the runtime", /attached to/.test(shellOut));

  const status = (await client.request({ type: "get_status" })) as RuntimeStatus;
  console.log(`    state=${status.state} hermes=${status.subsystems.hermes.state}`);
  check("runtime answers status through IPC", typeof status.state === "string");

  // --- 3. autostart must not be silently switched on ------------------------
  console.log("\n[3] autostart must not have been enabled behind the user's back");
  const enabled = await new AutostartManager().isEnabled();
  check("no Run-key entry was created by merely launching the app", enabled === false);

  // --- 4. kill the shell; Jarvis must survive ------------------------------
  console.log("\n[4] killing the shell — Jarvis must keep running");
  // Only the shell's own pid, with no /t. That is what a crash looks like:
  // one process dies. (`taskkill /t` walks the process tree and would take the
  // runtime with it — that is an explicit "end everything" action, not a
  // crash, and is documented as such.)
  await execFileAsync("taskkill", ["/pid", String(shell.pid), "/f"]).catch(() => {});
  await new Promise<void>((r) => {
    if (shellExited) return r();
    shell.on("exit", () => r());
    setTimeout(r, 5_000);
  });
  await wait(1_500);
  check("shell is gone", shellExited);

  const afterKill = (await client
    .request({ type: "get_status" })
    .catch(() => null)) as RuntimeStatus | null;
  check("runtime survived the shell being killed", afterKill !== null);
  check("runtime is still serving its state", typeof afterKill?.state === "string");

  const hermesPid = afterKill?.hermes.pid ?? null;
  if (hermesPid) {
    check("Hermes is still alive too", await isProcessAlive(hermesPid));
  }

  // --- 5. a fresh shell reattaches to the SAME runtime ---------------------
  console.log("\n[5] restarting the shell — it must reattach, not start a second runtime");
  const shell2 = spawn(electron, [entry, "--minimized"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let shell2Out = "";
  shell2.stdout?.setEncoding("utf8");
  shell2.stderr?.setEncoding("utf8");
  shell2.stdout?.on("data", (d: string) => (shell2Out += d));
  shell2.stderr?.on("data", (d: string) => (shell2Out += d));

  await wait(6_000);
  check(
    "second shell attached to the existing runtime",
    /attached to the running runtime/.test(shell2Out),
  );
  check("it did not start another runtime", !/starting one/.test(shell2Out));

  const sameRuntime = (await client
    .request({ type: "get_status" })
    .catch(() => null)) as RuntimeStatus | null;
  check(
    "the original runtime is the one still serving",
    sameRuntime?.startedAt === status.startedAt,
  );

  // --- 6. clean up ---------------------------------------------------------
  console.log("\n[6] shutting everything down");
  await client.request({ type: "quit" }).catch(() => {});
  await client.close();
  await wait(1_500);
  check("token was revoked on shutdown", readToken() === null);
  await execFileAsync("taskkill", ["/pid", String(shell2.pid), "/t", "/f"]).catch(() => {});
  await wait(1_500);

  console.log(`\n${failures === 0 ? "✓ PASS" : `✗ FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("✗ probe failed:", err);
  process.exit(1);
});
