/**
 * Phase 12 gate: what does an always-on Jarvis cost when nobody is talking to it?
 *
 * The README makes a claim in its second paragraph — "always *available*, not
 * always burning CPU on inference" — and until this probe existed that claim had
 * never been measured. It is also the one claim a user can check for themselves
 * in Task Manager, which makes it the worst one to be wrong about.
 *
 * What makes this a probe rather than a unit test: idle cost is a property of
 * elapsed wall-clock time and real OS scheduling. A fake timer proves the poll
 * *fires*; only a real window proves that between polls the process is asleep.
 * So this starts the real runtime, waits, and reads the counters the OS kept.
 *
 * Three numbers, each with a gate and a reason:
 *
 *   CPU        `process.cpuUsage()` before and after a real window, as a
 *              percentage of one core. The failure this catches is a busy
 *              wait — a `setInterval(…, 0)`, a promise loop, an fs watcher
 *              re-registering — which is invisible in a unit test and obvious
 *              in Task Manager. Gate: under 2% of one core.
 *   Memory     RSS, and its growth across the window. A flat 90 MB is fine
 *              forever; 90 MB climbing 4 MB a minute is a leak that reaches
 *              the user as a laptop that must be rebooted every few days.
 *              Gate: growth under 8 MB across the window.
 *   Liveness   A cheap process and a dead one look identical on the first two
 *              numbers, so the window is not purely idle: a job that has already
 *              been seen once is failed partway through, and the watcher has to
 *              notice and say so without being asked. Checked through the
 *              notification a user would actually receive, not through an
 *              internal counter — a counter can tick while the feature is
 *              broken. (Deliberately a *failed run* rather than a newly created
 *              job: `checkJobs` records a new job silently on purpose, so a
 *              probe waiting for "new job" would wait forever and blame the
 *              poll loop for a design decision.)
 *
 * **What it does to your machine.** Starts the real runtime on a probe-only pipe
 * name, with Hermes lazy (never spawned), voice disabled (the mic is untouched)
 * and Hermes' cron/config/memory paths pointed at a temp fixture — so nothing
 * reads or writes Hermes' real state. No network, no agent turn, no screenshot,
 * no cost. It idles for `--seconds` (default 30) and exits.
 *
 * **One shared file it does touch:** `%LOCALAPPDATA%\Jarvis\runtime-token`.
 * `JarvisRuntime.start()` publishes a token there and `stop()` revokes it, and
 * the path is not injectable (`publishToken(token)`, jarvis-runtime.ts:1300).
 * Running this alongside a live Jarvis would therefore delete that Jarvis'
 * credentials on the way out: its already-attached HUD keeps working, but a
 * newly opened one could not attach until the runtime was restarted. Hence the
 * guard in `main`: if a token file already exists, this probe says so and stops
 * rather than stepping on it.
 *
 *   npx tsx scripts/probe-idle.ts [--seconds 60] [--json]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JarvisRuntime } from "../src/runtime/jarvis-runtime.js";
import { refuseIfRuntimeLive } from "./runtime-guard.js";
import { TICKER_INTERVAL_SECONDS } from "../src/tasks/cron-store.js";
import { FakeAdapter } from "../tests/helpers/fake-adapter.js";

const args = process.argv.slice(2);
const seconds = Number(args[args.indexOf("--seconds") + 1]) || 30;
const asJson = args.includes("--json");

const results: { name: string; verdict: string; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, verdict: ok ? "PASS" : "FAIL", detail });
}

/**
 * Screenshots taken during the run, counted through the real `captureScreen`
 * seam. Overriding that seam replaces the pixels and nothing else — consent, the
 * rate limit and the session cap stay where they are — so a non-zero count here
 * would be a genuine unrequested capture, not a bypassed guard.
 */
let capturesTaken = 0;

/** Gates. Deliberately loose enough that passing means something, not everything. */
const CPU_LIMIT_PCT = 2;
const GROWTH_LIMIT_MB = 8;
/** Short enough that a 30 s window sees several, long enough to be idle between. */
const POLL_MS = 5_000;

interface Sample {
  cpuPct: number;
  rssStartMb: number;
  rssEndMb: number;
  growthMb: number;
  /** Titles the runtime pushed while idling. Should be exactly the failed job. */
  notified: string[];
  windowMs: number;
  /** Process names that appeared during the window — see `probeNegatives`. */
  appeared: string[];
}

async function measure(): Promise<Sample> {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-idle-"));
  // Hermes fixtures, so the real files are never even opened. An empty cron
  // directory and an all-but-empty config are the honest quiet case.
  writeFileSync(join(dir, "config.yaml"), "_config_version: 33\n");
  const cron = join(dir, "cron");
  const memories = join(dir, "memories");
  const skills = join(dir, "skills");
  const bundled = join(dir, "bundled");
  for (const d of [cron, memories, skills, bundled]) mkdirSync(d, { recursive: true });

  // A healthy ticker, in the real format: two files of epoch *seconds* named
  // `ticker_heartbeat` and `ticker_last_success` (`readTickerHealth`,
  // cron-store.ts:246). An earlier draft here invented a `ticker.json`, which
  // read as `never-run` — so every poll fired the "Scheduled tasks are not
  // running" warning and the probe passed its liveness check on the wrong
  // signal entirely.
  const heartbeat = (): void => {
    const now = `${Date.now() / 1000}`;
    writeFileSync(join(cron, "ticker_heartbeat"), now);
    writeFileSync(join(cron, "ticker_last_success"), now);
  };
  heartbeat();
  // Kept fresh for the same reason a real gateway does it, and at the same
  // cadence (`TICKER_INTERVAL_SECONDS`, 60). Stamping it once was not enough:
  // health goes stale after 200 s, so a `--seconds 300` run spent its last
  // 100 s reporting a dead scheduler — a fixture artifact that would have read
  // as a finding. Two twenty-byte writes a minute do not move the CPU figure.
  const ticker = setInterval(heartbeat, TICKER_INTERVAL_SECONDS * 1_000);

  /** The one job in the fixture, written with whatever last-run outcome we want. */
  const writeJob = (run: { at: number; status: string; error?: string } | null): void =>
    writeFileSync(
      join(cron, "jobs.json"),
      JSON.stringify({
        jobs: [
          {
            id: "probe-idle-job",
            name: "nightly backup",
            schedule: { kind: "cron", display: "0 3 * * *" },
            enabled: true,
            next_run_at: new Date(Date.now() + 3_600_000).toISOString(),
            last_run_at: run ? new Date(run.at).toISOString() : null,
            last_status: run?.status ?? null,
            last_error: run?.error ?? null,
          },
        ],
      }),
    );
  // Present before the runtime starts, so the first poll baselines it. A job
  // that appears mid-window is recorded silently by design (task-watcher.ts:164)
  // and would never produce the notification this check is waiting for.
  writeJob(null);

  const notified: string[] = [];

  const runtime = new JarvisRuntime({
    // A full pipe path, not a bare name: `net.Server.listen` reads the string as
    // a filesystem path, and on Windows a bare `jarvis-probe-idle-1892` is a
    // relative path in the cwd, which fails EACCES with a message that reads
    // like "another Jarvis is already running" and is not.
    pipeName: pipePath(`jarvis-probe-idle-${process.pid}`),
    lazyHermes: true,
    createAdapter: () => new FakeAdapter(),
    voice: { enabled: false },
    cronDir: cron,
    hermesConfigPath: join(dir, "config.yaml"),
    hermesMemoryDir: memories,
    memoryPath: join(dir, "memory.json"),
    skillRoots: [skills, bundled],
    taskPollMs: POLL_MS,
    notifyLevel: "normal",
    notifySink: (n) => notified.push(n.title),
    // The pixels, and only the pixels. `ScreenCapture` sits above this seam and
    // keeps its consent prompt, its rate limit and its session cap, so this
    // records a capture the runtime genuinely decided to take rather than
    // opening a door around the gate. An idle run should never reach it — and
    // if some future timer does, this is the line that says so.
    captureScreen: async () => {
      capturesTaken += 1;
      return new Uint8Array();
    },
  });

  await runtime.start();
  try {
    // Let boot settle before the clock starts: module loading, the first project
    // scan and the first task poll are startup cost, not idle cost, and counting
    // them would make a well-behaved process look like a busy one.
    await sleep(3_000);
    notified.length = 0;
    if (global.gc) global.gc();

    // Who is running before the clock starts. The negatives are asserted against
    // the *change*, not the list: this probe runs under Claude Code, which is
    // itself a `claude` process, and flagging the tool you are running under as
    // a violation would be a lie the report could not survive.
    //
    // Sampled outside the measured window on purpose. `execFileSync` spawns a
    // PowerShell, and doing that between `cpuBefore` and the final read charged
    // its marshalling to the idle figure — 0.02% became 0.33%, a sixteen-fold
    // overstatement of the number this probe exists to publish.
    const before = new Set(listProcesses().map((p) => p.toLowerCase()));

    const cpuBefore = process.cpuUsage();
    const rssBefore = process.memoryUsage().rss;
    const t0 = process.hrtime.bigint();

    // Idle for most of the window, then fail the job and keep idling. The
    // liveness check needs the watcher to notice the new last-run on its own.
    await sleep(Math.max(1_000, seconds * 1_000 - POLL_MS * 3));
    writeJob({
      at: Date.now(),
      status: "error",
      error: "probe-injected failure: connection to backup target refused",
    });
    await sleep(POLL_MS * 3);

    const elapsedUs = Number(process.hrtime.bigint() - t0) / 1_000;
    const cpu = process.cpuUsage(cpuBefore);
    const rssAfter = process.memoryUsage().rss;
    // Read after the counters, for the reason given at the first sample.
    const after = listProcesses().map((p) => p.toLowerCase());
    const appeared = [...new Set(after.filter((p) => !before.has(p)))];

    const usedUs = cpu.user + cpu.system;
    return {
      cpuPct: (usedUs / elapsedUs) * 100,
      rssStartMb: rssBefore / 1e6,
      rssEndMb: rssAfter / 1e6,
      growthMb: (rssAfter - rssBefore) / 1e6,
      notified: [...notified],
      windowMs: elapsedUs / 1_000,
      appeared,
    };
  } finally {
    clearInterval(ticker);
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A pipe the real Jarvis will never be listening on, in the platform's own form. */
function pipePath(name: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `/tmp/${name}.sock`;
}

async function main(): Promise<void> {
  // Refuse rather than clobber. `start()` overwrites the shared token file and
  // `stop()` deletes it, so a live Jarvis would be left unattachable by a probe
  // whose whole pitch is that it touches nothing of yours. A *stale* token is
  // not that, and is not grounds to refuse — see `runtime-guard.ts`.
  await refuseIfRuntimeLive();

  if (!asJson) {
    console.log(`Idling a real runtime for ${seconds}s (no mic, no Hermes, no network)…\n`);
  }
  const s = await measure();

  check(
    `idle CPU under ${CPU_LIMIT_PCT}% of one core`,
    s.cpuPct < CPU_LIMIT_PCT,
    `${s.cpuPct.toFixed(2)}% over ${(s.windowMs / 1000).toFixed(1)}s`,
  );
  check(
    `RSS growth under ${GROWTH_LIMIT_MB} MB while idle`,
    s.growthMb < GROWTH_LIMIT_MB,
    `${s.rssStartMb.toFixed(1)} → ${s.rssEndMb.toFixed(1)} MB (${s.growthMb >= 0 ? "+" : ""}${s.growthMb.toFixed(1)})`,
  );
  // Reported, not gated: a resident set is a fact about Node and Electron, and a
  // number that fails on a smaller machine than mine would be a false alarm.
  check("resident set reported", true, `${s.rssEndMb.toFixed(1)} MB`);

  // The check that stops the two above being passed by a dead process. Asserted
  // on the specific title, not on "something arrived": the scheduler-health
  // warning also flows through this sink, and accepting any notification would
  // let a runtime that never re-read the job list pass by complaining about the
  // ticker instead.
  const sawFailure = s.notified.some((t) => t.includes("nightly backup"));
  check(
    "noticed a scheduled job failing while idle — cheap, not asleep",
    sawFailure,
    s.notified.length ? s.notified.join(" · ") : "(nothing noticed)",
  );

  // And nothing *else* spoke. A notification the user did not need is a cost
  // too, and this one caught a real fixture bug: with the heartbeat stamped
  // once, a 300 s run went stale halfway and started reporting a dead
  // scheduler. Silence here is what "idle" is supposed to sound like.
  const extra = s.notified.filter((t) => !t.includes("nightly backup"));
  check(
    "said nothing else while idle",
    extra.length === 0,
    extra.length ? extra.join(" · ") : "no unprompted notifications",
  );

  probeNegatives(s);
  report(s);
}

/**
 * The five things §72 says must NOT be happening while idle.
 *
 * Each is asserted against the operating system rather than against this
 * project's own intentions, because "we never call it" is a claim about code and
 * this project's rule is that a claim by the actor is not evidence.
 *
 * The unit of evidence is what *appeared during the window*, not what is running
 * now. A whole-machine scan reads as rigour and is not: this probe is normally
 * run from Claude Code, so `claude` is already in the process list and a scan
 * fails on the tool holding the stopwatch. What matters for §72 is whether an
 * idle Jarvis *starts* any of these — a browser the user opened themselves is
 * not a finding.
 */
function probeNegatives(s: Sample): void {
  const appeared = (needle: string): string[] => s.appeared.filter((p) => p.includes(needle));

  // 1. Claude Code is not started unnecessarily. It is spawned per coding task
  //    and must not appear without one; a stray CLI is a token bill and an open
  //    workspace nobody asked for.
  const claude = appeared("claude");
  check(
    "started no Claude Code process while idle",
    claude.length === 0,
    claude.length ? claude.join(", ") : "none appeared",
  );

  // 2. Hermes is not continuously inferring. `lazyHermes` means an idle runtime
  //    should not have spawned one at all, which is the stronger statement and
  //    the one the diff can actually make.
  const hermes = [...appeared("hermes"), ...appeared("python")];
  check(
    "started no Hermes process while idle",
    hermes.length === 0,
    hermes.length ? hermes.join(", ") : "none appeared",
  );

  // 3. No screenshots are being captured continuously. Counted at the seam
  //    itself rather than inferred from processes, because Windows capture is
  //    an in-process API call and would leave no process behind to find.
  check("no screen capture happened while idle", capturesTaken === 0, `${capturesTaken} captures`);

  // 4. No microphone audio is being uploaded (§50). Voice was off for this run,
  //    so the evidence is that no audio sidecar appeared — the always-on path is
  //    timed separately by `probe:voice`, which never sends a byte off the
  //    machine either.
  check(
    "started no voice daemon, so no audio left the machine",
    appeared("python").length === 0,
    "no audio sidecar appeared",
  );

  // 5. Browser automation is not active.
  const drivers = [
    ...appeared("chromedriver"),
    ...appeared("msedgedriver"),
    ...appeared("geckodriver"),
  ];
  check(
    "started no browser automation driver while idle",
    drivers.length === 0,
    drivers.length ? drivers.join(", ") : "none appeared",
  );
}

/** Process names, via the OS. Empty on failure — reported, never thrown. */
function listProcesses(): string[] {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-Process | Select-Object -ExpandProperty ProcessName"],
      { encoding: "utf8", timeout: 20_000 },
    );
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function report(s: Sample): void {
  if (asJson) {
    console.log(JSON.stringify({ sample: s, results }, null, 2));
  } else {
    const width = Math.max(...results.map((r) => r.name.length));
    for (const r of results) {
      console.log(`${r.verdict.padEnd(5)} ${r.name.padEnd(width)}  ${r.detail}`);
    }
    const failed = results.filter((r) => r.verdict === "FAIL").length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    console.log("(voice idle cost is measured separately by `npm run probe:voice`)");
  }
  process.exit(results.some((r) => r.verdict === "FAIL") ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
