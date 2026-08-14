/**
 * The turn deadline, against real Hermes: silence is cancelled, work is not.
 *
 * The unit tests prove the clock with an injected `now`. What they cannot prove
 * is the thing that actually failed: that a real ACP turn, running a real tool
 * through a real agent process, is bounded — and that bounding it does not kill
 * the healthy slow turn sitting right next to it.
 *
 * The defect this exists for was measured, not imagined. A typed turn asking
 * Hermes to read two files was accepted in 5 ms, emitted one `tool_call`, then
 * produced **nothing for 423 s** — no reply, no error, no `reply_done` — while a
 * `bash.exe --noprofile --norc -c "exit 0"` child sat at 0 s of CPU for 25
 * minutes. The wedge is inside Hermes' `LocalEnvironment.init_session`
 * (`tools/environments/local.py:1104`); Jarvis' own failing was that nothing
 * beneath `streamMessage` had a deadline at all.
 *
 * Three turns, in one runtime, in this order for a reason:
 *
 *   1. a real turn that is silent for ten-odd seconds — must NOT be cancelled,
 *      because a deadline that kills real work is worse than no deadline;
 *   2. a turn whose agent process is **suspended mid-turn** — must be cancelled,
 *      reported on screen, and left recoverable;
 *   3. a plain question afterwards — must be answered, which is the part a
 *      latent bug used to break: `AssistantState.error` has only `recover` and
 *      `cancel` as exits and nothing in this runtime ever sent `recover`, so a
 *      failed turn parked the machine in ERROR until the user pressed Cancel.
 *
 * **Why suspension.** The original wedge was reached through a tool call, and
 * reproducing it that way needs the model to cooperate — which on this machine it
 * currently cannot: the configured `tencent/hy3:free` answers every turn with
 * "API call failed after 3 retries: Provider returned an empty stream", so no
 * tool ever runs. `NtSuspendProcess` on the real Hermes pid produces the exact
 * observable this fix is about, and produces it deterministically: a process that
 * is alive, holds its session open, burns no CPU, and emits nothing. That is
 * what the 25-minute `bash.exe` orphan looked like from Jarvis' side. Everything
 * below the suspension is production code — real spawn, real ACP over stdio, real
 * `session/cancel` on the wire — and resuming it afterwards proves the other half
 * of the promise: the abandoned turn's late reply stays off the screen.
 *
 * The one thing deliberately unlike production: `turnStallMs` is lowered to 45 s
 * from `DEFAULT_TURN_STALL_MS` (660 s — Hermes' own `FOREGROUND_MAX_TIMEOUT` of
 * 600 s plus a minute of slack). Probing the real number would mean wedging an
 * agent for eleven minutes; the code path is identical either way, and the
 * gap measurements printed below are the evidence for the number itself.
 *
 * No microphone opens: voice is off, and the turns are typed through IPC exactly
 * as the HUD sends them.
 *
 *   npx tsx scripts/probe-stall.ts
 */
import { JarvisRuntime } from "../src/runtime/jarvis-runtime.js";
import { PipeClient } from "../src/ipc/pipe-client.js";
import { readToken } from "../src/ipc/token.js";
import type { RuntimeStatus, ServerEvent } from "../src/ipc/contract.js";
import { refuseIfRuntimeLive } from "./runtime-guard.js";
import { DEFAULT_TURN_STALL_MS } from "../src/runtime/turn-watchdog.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Silence allowed here. Production allows 660 s; see the header. */
const STALL_MS = 45_000;
/** When silence becomes worth a log line. */
const NOTICE_MS = 8_000;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** True but worth saying: a condition the probe did not create and cannot fix. */
function note(name: string, detail: string): void {
  console.log(`NOTE  ${name}${detail ? `  — ${detail}` : ""}`);
}

/**
 * Freeze or thaw a process tree, threads and all.
 *
 * `NtSuspendProcess` is how you produce "alive but emitting nothing" on Windows
 * without killing anything — the observable the whole fix is about. Undone by
 * `resume` in a `finally`, and the process is stopped by `runtime.stop()`
 * regardless, so nothing is left frozen on the machine.
 *
 * The tree, not the pid, and that is not a detail: `hermes.exe acp` is a launcher
 * that spawns `python.exe … hermes.exe acp` and hands it the inherited stdio, so
 * the child is what actually writes the ACP stream. Suspending the launcher alone
 * changes nothing observable — measured, by a first version of this probe that
 * did exactly that and watched the turn finish anyway.
 */
async function freeze(pid: number, action: "Suspend" | "Resume"): Promise<string> {
  const script =
    `Add-Type -Namespace Nt -Name P -MemberDefinition '` +
    `[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(System.IntPtr h);` +
    `[DllImport("ntdll.dll")] public static extern int NtResumeProcess(System.IntPtr h);' ; ` +
    // Descendants first, then the launcher: the child is the one writing.
    `$all = Get-CimInstance Win32_Process; ` +
    `function Kids($p) { $all | Where-Object { $_.ParentProcessId -eq $p } | ` +
    `ForEach-Object { Kids $_.ProcessId; $_.ProcessId } } ; ` +
    `$targets = @(Kids ${pid}) + ${pid} | Where-Object { $_ -ne $PID } ; ` +
    `foreach ($t in $targets) { try { ` +
    `$proc = [System.Diagnostics.Process]::GetProcessById($t); ` +
    `$rc = [Nt.P]::Nt${action}Process($proc.Handle); ` +
    `"$($proc.ProcessName)($t)=$rc" } catch { "$t=skipped" } }`;
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script], {
    windowsHide: true,
  });
  return stdout.trim().split(/\r?\n/).join(" ");
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, timeoutMs: number): Promise<boolean> {
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

/** One turn's observed events, with the gap between them — the whole point. */
interface Turn {
  label: string;
  events: Array<{ at: number; gap: number; type: string; text: string }>;
  errors: string[];
  logs: string[];
  done: boolean;
  startedMs: number;
  settledMs: number;
}

async function main(): Promise<void> {
  console.log("\nThe turn deadline, against real Hermes.");
  console.log(
    `(silence budget lowered to ${STALL_MS / 1000}s for this run; ` +
      `production is ${DEFAULT_TURN_STALL_MS / 1000}s)\n`,
  );

  await refuseIfRuntimeLive();

  const pipeName = pipePath(`jarvis-stall-${process.pid}`);
  const runtime = new JarvisRuntime({
    pipeName,
    cwd: process.cwd(),
    turnStallMs: STALL_MS,
    turnNoticeMs: NOTICE_MS,
    // The mic stays shut: this is about the agent, and the live instance may own
    // the device anyway.
    voice: { enabled: false },
  });

  await runtime.start();

  const ui = new PipeClient({
    pipeName,
    token: readToken() ?? undefined,
    clientName: "probe-stall",
    autoReconnect: false,
    // Accepting a prompt is milliseconds; the turn itself is not awaited here.
    requestTimeoutMs: 30_000,
  });
  await ui.connectAndAuthenticate();

  // Somebody has to say yes. A terminal command asks, and an unanswered question
  // *holds the watchdog clock on purpose* (`isPaused`) — so with nobody clicking,
  // this probe would measure a paused clock and prove nothing.
  const asked: string[] = [];
  ui.on("event", (ev: ServerEvent) => {
    if (ev.type !== "permission_request") return;
    asked.push(ev.title);
    void ui.request({
      type: "permission_response",
      requestId: ev.requestId,
      decision: "allow_once",
    });
  });

  const ready = await until(() => runtime.supervisor.isReady(), 90_000);
  check("real Hermes came up", ready, `state=${runtime.supervisor.getStatus().state}`);
  if (!ready) {
    await runtime.stop();
    process.exit(1);
  }

  /** Send a prompt, then watch the turn until it settles or the wait runs out. */
  async function turn(
    label: string,
    text: string,
    waitMs: number,
    onAccepted?: () => Promise<void>,
  ): Promise<Turn> {
    const t: Turn = {
      label,
      events: [],
      errors: [],
      logs: [],
      done: false,
      startedMs: 0,
      settledMs: 0,
    };
    let last = 0;
    const onEvent = (ev: ServerEvent): void => {
      const at = performance.now() - t.startedMs;
      if (ev.type === "log") {
        t.logs.push(ev.line);
        return;
      }
      // `level` is the mic meter and floods everything; voice is off, but be
      // explicit rather than lucky.
      if (ev.type === "level" || ev.type === "state" || ev.type === "status") return;
      const body =
        ev.type === "error"
          ? ev.message
          : ev.type === "reply_chunk"
            ? ev.text
            : ev.type === "tool_call"
              ? `${ev.title} [${ev.status}]`
              : ev.type === "thought"
                ? ev.text
                : "";
      t.events.push({ at, gap: at - last, type: ev.type, text: body.slice(0, 90) });
      last = at;
      if (ev.type === "error") t.errors.push(ev.message);
      if (ev.type === "error" || ev.type === "reply_done") {
        t.done = true;
        t.settledMs = at;
      }
    };

    console.log(`\n[${label}]\n  > ${text}`);
    ui.on("event", onEvent);
    t.startedMs = performance.now();
    try {
      await ui.request({ type: "prompt", text });
      // The turn is accepted, not finished — which is exactly the window a
      // suspension has to land in.
      if (onAccepted) await onAccepted();
    } catch (err) {
      // A fast refusal (agent unreachable, empty prompt) is itself an answer;
      // the checks below judge it.
      t.errors.push(err instanceof Error ? err.message : String(err));
      t.done = true;
    }
    await until(() => t.done, waitMs);
    ui.off("event", onEvent);

    for (const e of t.events) {
      console.log(
        `    ${(e.at / 1000).toFixed(1)}s  +${(e.gap / 1000).toFixed(1)}s  ` +
          `${e.type}${e.text ? `  ${e.text}` : ""}`,
      );
    }
    for (const l of t.logs.filter((l) => /still waiting|stalled/.test(l))) {
      console.log(`    [log] ${l}`);
    }
    return t;
  }

  try {
    // --- 1. slow but real work: must survive --------------------------------
    // A real turn against a real agent, silent while the model is called. This
    // is the turn a duration-based deadline kills and a silence-based one does
    // not.
    const slow = await turn(
      "1/3 a real turn, silent while the model is called",
      "Run this in the terminal, exactly, and then tell me its output: " +
        "sleep 20 && echo SLEEP_20_OK",
      150_000,
    );
    const slowText = slow.events
      .filter((e) => e.type === "reply_chunk")
      .map((e) => e.text)
      .join("");
    check(
      "a legitimately silent turn was NOT cancelled",
      slow.errors.length === 0,
      slow.errors[0] ?? `settled in ${(slow.settledMs / 1000).toFixed(1)}s`,
    );
    check("the turn actually finished", slow.done && slow.errors.length === 0);
    check(
      "the silence was noticed out loud in the log, without a banner",
      slow.logs.some((l) => /still waiting/.test(l)),
      slow.logs.find((l) => /still waiting/.test(l)) ?? "no notice line",
    );
    const biggestGap = Math.max(0, ...slow.events.map((e) => e.gap));
    console.log(
      `    longest silence inside a healthy turn: ${(biggestGap / 1000).toFixed(1)}s` +
        `  (budget ${STALL_MS / 1000}s, production ${DEFAULT_TURN_STALL_MS / 1000}s)`,
    );
    if (slowText) console.log(`    reply: ${slowText.slice(0, 160)}`);
    // Honesty about what this run did and did not exercise. A provider that
    // answers every turn with a failure string still proves the turn machinery,
    // and proves nothing about tool use — so say so rather than let a PASS imply
    // more than it earned.
    if (/API call failed|empty stream/i.test(slowText)) {
      note(
        "the configured model is failing, so no tool ran in this turn",
        "the reply is the provider's error text; the deadline is what is under test here",
      );
    }

    // --- 2. an agent that stops emitting: must be cancelled -----------------
    const pid = runtime.supervisor.getStatus().hermes?.pid ?? null;
    check("the real Hermes pid is known, so it can be frozen", pid !== null, `pid=${pid}`);
    let frozen = false;
    const wedged = await turn(
      "2/3 the agent process is suspended mid-turn",
      "Reply with exactly: NEVER_ARRIVES",
      STALL_MS + 60_000,
      async () => {
        if (pid === null) return;
        const rc = await freeze(pid, "Suspend");
        frozen = true;
        console.log(`    (suspended ${rc} — alive, holding the session, emitting nothing)`);
      },
    );
    try {
      check(
        "the turn was given up on instead of waited on forever",
        wedged.errors.length > 0,
        `settled in ${(wedged.settledMs / 1000).toFixed(1)}s`,
      );
      check(
        "the banner says what happened, not 'internal error'",
        wedged.errors.some(
          (m) => /stopped responding/i.test(m) && /cancelled the turn/i.test(m),
        ),
        wedged.errors[0]?.slice(0, 140) ?? "no error event",
      );
      check(
        "it says what the user can do about it",
        wedged.errors.some((m) => /ask again/i.test(m)),
      );
      check(
        "it tripped on the silence budget, not on some other timeout",
        wedged.settledMs >= STALL_MS && wedged.settledMs < STALL_MS + 20_000,
        `${(wedged.settledMs / 1000).toFixed(1)}s vs budget ${STALL_MS / 1000}s`,
      );
      check(
        "the log recorded the cancellation",
        wedged.logs.some((l) => /stalled/.test(l)),
        wedged.logs.find((l) => /stalled/.test(l)) ?? "no stall line",
      );
      const afterStall = (await ui.request({ type: "get_status" })) as RuntimeStatus;
      check(
        "the assistant is usable again, not parked in ERROR",
        afterStall.state !== "error",
        `state=${afterStall.state}`,
      );
    } finally {
      if (pid !== null && frozen) {
        const rc = await freeze(pid, "Resume");
        console.log(`    (resumed ${rc})`);
      }
    }

    // Nothing from the abandoned turn may land on screen afterwards: reply text
    // under a banner saying nothing came back is worse than either alone. The
    // agent has just been thawed with a whole turn's work still queued in it, so
    // this is a real late reply being suppressed, not a hypothetical one.
    const late: string[] = [];
    const catcher = (ev: ServerEvent): void => {
      if (ev.type === "reply_chunk" || ev.type === "reply_done") late.push(ev.type);
    };
    ui.on("event", catcher);
    await wait(20_000);
    ui.off("event", catcher);
    check("the abandoned turn stayed off the screen", late.length === 0, late.join(","));
    check(
      "Hermes survived the cancel",
      runtime.supervisor.isReady(),
      `state=${runtime.supervisor.getStatus().state}`,
    );

    // --- 3. and it still works ----------------------------------------------
    const after = await turn(
      "3/3 a plain question after the stall",
      "Reply with exactly: STALL_RECOVERY_OK",
      120_000,
    );
    const answer = after.events
      .filter((e) => e.type === "reply_chunk")
      .map((e) => e.text)
      .join("");
    check(
      "the next turn was answered",
      after.errors.length === 0 && answer.length > 0,
      after.errors[0] ?? answer.slice(0, 80),
    );

    console.log(
      `\npermission questions asked: ${asked.length}${asked.length ? ` (${asked.join(", ")})` : ""}`,
    );
    if (asked.length === 0) {
      note(
        "no permission question arose, so the paused clock is not exercised here",
        "tests/turn-watchdog.test.ts and tests/jarvis-runtime.test.ts cover isPaused",
      );
    }
  } finally {
    await runtime.stop();
    await ui.close();
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
