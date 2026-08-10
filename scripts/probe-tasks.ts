/**
 * Phase 9 gate: what does Jarvis know about Hermes' scheduled jobs, and can it
 * know it without touching a byte Hermes owns?
 *
 * The unit suites prove the logic of `readTasks`, `TaskWatcher` and the
 * notification policy against fixture directories and a fake clock. Three
 * things they cannot prove are exactly what this phase is for.
 *
 * First, the real `%LOCALAPPDATA%\hermes\cron` — the machine's actual job list
 * and its actual ticker heartbeats, which on this machine are days stale
 * because the ticker only exists inside the gateway and the gateway is not
 * running (`hermes_cli/cron.py:66`: "there is no standalone cron daemon…
 * the most common cron support report"). The cross-check against `hermes cron
 * status` — the machine's own binary, with its own gateway probe and its own
 * copy of the heartbeats — is what makes the shared verdict evidence rather
 * than a shared bug.
 *
 * Second, that the answer says the hard sentence first. This machine has no
 * jobs, so that half runs against a fixture directory through the same
 * `cronDir` seam the runtime already exposes: a real record, read by the real
 * parser, spoken by the real executor. When the spoken line leads with the
 * warning rather than the list, the reason for the whole design — never list
 * jobs as though they were going to fire — is what a person actually hears.
 *
 * Third, the read-only boundary. "We never call a write" is a claim about
 * code, and this project's rule is that a claim by the actor is not evidence,
 * so this fingerprints the real cron directory before and after a full Jarvis
 * run and compares — sizes, mtimes, lock files and all.
 *
 * **What it does to your machine.** Reads `%LOCALAPPDATA%\hermes\cron` and
 * runs `hermes cron status` (a read-only status command, no gateway is started).
 * It creates a temporary cron fixture under the system temp directory and
 * deletes it again; nothing is written to, created in, or removed from Hermes'
 * own directory. `runtime.start()` is deliberately not called, so the IPC pipe
 * is never bound and the runtime token is never published — a Jarvis running on
 * this machine right now keeps its credentials. No network, no microphone, no
 * agent turn, and nothing here fires a scheduled job.
 *
 *   npx tsx scripts/probe-tasks.ts
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cronDir, readTasks } from "../src/tasks/cron-store.js";
import { JarvisRuntime } from "../src/runtime/jarvis-runtime.js";
import { FakeAdapter } from "../tests/helpers/fake-adapter.js";

const results: { name: string; verdict: string; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, verdict: ok ? "PASS" : "FAIL", detail });
}

/**
 * Size and mtime of every entry under a directory.
 *
 * Directories are listed by name only: `output/` holds job transcripts Hermes
 * writes, and its mtime is not ours to account for.
 */
function fingerprint(dir: string): string {
  if (!existsSync(dir)) return "absent";
  return readdirSync(dir)
    .sort()
    .map((f) => {
      const s = statSync(join(dir, f));
      return s.isDirectory() ? `${f}/` : `${f}:${s.size}:${s.mtimeMs}`;
    })
    .join("|");
}

/** `hermes cron status` — the machine's own word about its own gateway. */
function hermesSaysNotRunning(): boolean | null {
  try {
    const out = execFileSync("hermes", ["cron", "status"], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return /gateway is not running/i.test(out);
  } catch {
    return null; // Hermes not on PATH: report as undetermined, not as agreement.
  }
}

/** A runtime with Hermes stubbed, pointed at whichever cron directory we say. */
function makeRuntime(dir?: string): JarvisRuntime {
  FakeAdapter.reset();
  return new JarvisRuntime({
    lazyHermes: true,
    voice: { enabled: false },
    createAdapter: () => new FakeAdapter(),
    ...(dir === undefined ? {} : { cronDir: dir }),
  });
}

/** Drive one utterance and collect what Jarvis said out loud. */
async function say(runtime: JarvisRuntime, utterance: string): Promise<string> {
  const spoken: string[] = [];
  const listener = (e: { type: string; text?: string }): void => {
    if (e.type === "reply_chunk" && e.text) spoken.push(e.text);
  };
  runtime.on("broadcast", listener);
  try {
    await runtime.prompt(utterance);
  } finally {
    runtime.off("broadcast", listener);
  }
  return spoken.join("");
}

// --- the real install -------------------------------------------------------

function probeRealFiles(): void {
  const dir = cronDir();
  const present = existsSync(join(dir, "jobs.json"));
  check(
    "Hermes' cron directory is readable at the path Jarvis derives",
    present,
    present ? dir : `${join(dir, "jobs.json")} does not exist`,
  );
  if (!present) return;

  const raw = readFileSync(join(dir, "jobs.json"), "utf8");
  let jobs: unknown = undefined;
  try {
    jobs = (JSON.parse(raw) as { jobs?: unknown }).jobs;
  } catch {
    jobs = undefined;
  }
  check(
    "jobs.json parses as the job list Hermes writes",
    Array.isArray(jobs),
    Array.isArray(jobs) ? `${jobs.length} job(s), ${raw.length} bytes` : raw.slice(0, 80),
  );

  const snapshot = readTasks();
  check(
    "the real record count round-trips through the parser",
    Array.isArray(jobs) && snapshot.jobs.length <= jobs.length,
    `file=${Array.isArray(jobs) ? jobs.length : "?"} enabled=${snapshot.jobs.length}`,
  );
}

function probeRealTicker(): void {
  const snapshot = readTasks();
  const hb = join(cronDir(), "ticker_heartbeat");

  check(
    "the ticker heartbeat file exists and parses as a raw epoch float",
    existsSync(hb) && snapshot.ticker.state !== "never-run",
    existsSync(hb) ? `${readFileSync(hb, "utf8").trim()} -> ${snapshot.ticker.state}` : "absent",
  );

  if (snapshot.ticker.state === "stalled") {
    const hours = Math.round(snapshot.ticker.heartbeatAgeMs / 3_600_000);
    check(
      "a days-stale heartbeat is reported as stalled, not as healthy",
      true,
      `last check-in ${hours} h ago`,
    );
  } else {
    check(
      `the ticker state is read as ${snapshot.ticker.state}`,
      snapshot.ticker.state === "running",
      "expected running or stalled",
    );
  }

  const theirs = hermesSaysNotRunning();
  const ourNotRunning = snapshot.ticker.state !== "running";
  check(
    "Jarvis' verdict matches `hermes cron status`, from Hermes' own binary",
    theirs !== null && theirs === ourNotRunning,
    theirs === null
      ? "hermes not on PATH — undetermined, so not counted as agreement"
      : `jarvis=${ourNotRunning ? "not running" : "running"}, hermes=${theirs ? "not running" : "running"}`,
  );
}

/**
 * A whole turn against the real directory, watched on both sides.
 *
 * Deliberately without `runtime.start()`: that publishes the IPC token, and
 * this probe has no business revoking the credentials of a Jarvis that may be
 * running right now. `prompt` needs only the state machine, the local engine
 * and the supervisor.
 */
async function probeReadOnly(): Promise<void> {
  const dir = cronDir();
  const before = fingerprint(dir);

  const runtime = makeRuntime();
  try {
    await runtime.supervisor.start();
    const answer = await say(runtime, "what tasks do I have");

    check(
      "asking what is scheduled costs no agent turn",
      FakeAdapter.latest.lastPrompt === null,
      FakeAdapter.latest.lastPrompt ?? "(the agent was never consulted)",
    );
    check(
      "Jarvis answers about the real machine rather than failing",
      answer.trim().length > 0,
      `"${answer.slice(0, 100)}"`,
    );

    // Stepping the watcher by hand rather than waiting out its 60 s interval.
    // It is the component that reads on a timer, so it is the one most likely
    // to touch something it should not.
    runtime.tasks.poll();
    runtime.tasks.poll();

    const after = fingerprint(dir);
    check(
      "a full Jarvis run left Hermes' cron directory byte-for-byte alone",
      after === before,
      after === before ? "sizes, mtimes and lock files unchanged" : `${before} -> ${after}`,
    );
  } finally {
    await runtime.stop();
  }
}

// --- the sentence a person hears --------------------------------------------

/**
 * The load-bearing check, run against a fixture because this machine has no
 * jobs — and creating one in Hermes' own directory to make the point would
 * break the very boundary the probe above just proved.
 *
 * The record is the shape `create_job` writes; the heartbeats are raw epoch
 * floats, as `_atomic_write_epoch` writes them. Everything from there on is the
 * real parser, the real intent match and the real executor.
 */
async function probeWarningLeads(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-probe-cron-"));
  try {
    writeFileSync(
      join(dir, "jobs.json"),
      JSON.stringify({
        jobs: [
          {
            id: "probe-job",
            name: "Morning digest",
            prompt: "summarise my inbox and send it to me",
            model: "tencent/hy3:free",
            base_url: "https://example.invalid/v1",
            schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
            enabled: true,
            next_run_at: null,
            last_run_at: null,
            last_status: null,
          },
        ],
      }),
      "utf8",
    );
    const stale = String(Date.now() / 1000 - 4 * 24 * 3_600);
    writeFileSync(join(dir, "ticker_heartbeat"), stale, "utf8");
    writeFileSync(join(dir, "ticker_last_success"), stale, "utf8");

    const runtime = makeRuntime(dir);
    try {
      await runtime.supervisor.start();
      const answer = await say(runtime, "what tasks do I have");

      const warnAt = answer.indexOf("hermes gateway");
      const listAt = answer.indexOf("Morning digest");
      check(
        "a job that will not fire is never announced as though it would",
        warnAt !== -1 && listAt !== -1 && warnAt < listAt,
        `"${answer.slice(0, 140)}"`,
      );
      check(
        "the fix is named as a command the user can run (§61)",
        /hermes gateway (install|start)/.test(answer),
        answer.match(/hermes gateway \w+/)?.[0] ?? "(no command named)",
      );

      const wire = JSON.stringify(runtime.tasksView());
      check(
        "the job's prompt, model and base url stay off the wire (§52)",
        !/summarise my inbox|hy3:free|example\.invalid/.test(wire),
        wire.slice(0, 120),
      );

      // The proactive half: nobody asked, and the condition still surfaces.
      const shown: { title: string; body: string }[] = [];
      const notified = new JarvisRuntime({
        lazyHermes: true,
        voice: { enabled: false },
        createAdapter: () => new FakeAdapter(),
        cronDir: dir,
        notifyLevel: "minimal",
        notifySink: (n) => shown.push({ title: n.title, body: n.body }),
      });
      try {
        notified.tasks.poll();
        check(
          "a dead scheduler is reported without being asked",
          shown.length === 1 && /hermes gateway/.test(shown[0]?.body ?? ""),
          shown[0] ? `${shown[0].title} — ${shown[0].body.slice(0, 70)}` : "(nothing shown)",
        );
        notified.tasks.poll();
        notified.tasks.poll();
        check(
          "and not once per poll thereafter",
          shown.length === 1,
          `${shown.length} notification(s) across 3 polls`,
        );
      } finally {
        await notified.stop();
      }
    } finally {
      await runtime.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  probeRealFiles();
  probeRealTicker();
  await probeReadOnly();
  await probeWarningLeads();
  report();
}

function report(): void {
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`${r.verdict.padEnd(5)} ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = results.filter((r) => r.verdict === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  console.log(`(cron ${cronDir()})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
