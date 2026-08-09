/**
 * Phase 6 gate: does the foreground-window read actually work on this machine?
 *
 * The unit tests drive `ActiveWindow` through a fake `run`, which proves the
 * parsing, the caching and the failure vocabulary — and says nothing about
 * whether the PowerShell is right. That gap has produced a real defect in every
 * phase that had one: the Phase 4 probe found two, and writing this script found
 * two more before it existed as a file (a console codepage that replaced the
 * first character of a real title with `?`, and PowerShell's progress stream
 * arriving on stderr as CLIXML).
 *
 * **What it does to your machine.** Nothing. It reads the title of whatever
 * window is focused, twice, and prints what it found. No files, no settings, no
 * network. It deliberately does not print raw titles — see below.
 *
 *   npx tsx scripts/probe-context.ts
 */
import { ActiveWindow, CACHE_MS } from "../src/context/active-window.js";
import { redactSecrets, describeWindow } from "../src/context/window-facts.js";
import { LocalIntentEngine } from "../src/local-intents/engine.js";
import type { LocalDecision } from "../src/local-intents/engine.js";

const results: { name: string; verdict: string; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, verdict: ok ? "PASS" : "FAIL", detail });
}

async function main(): Promise<void> {
  const win = new ActiveWindow();

  // --- the read itself, which is the part that cannot be faked --------------

  const t0 = Date.now();
  const first = await win.read();
  const elapsed = Date.now() - t0;

  check("reads the foreground window", first.ok, first.ok ? "" : first.reason);
  if (!first.ok) return report();

  if (!first.window) {
    // Legitimate — run from a locked session or with nothing focused. Reported
    // rather than failed, because the probe cannot tell the difference between
    // "no window" and "the machine is idle", and guessing would be the same
    // false-negative the whole project is written against.
    check("a window is focused", false, "nothing focused; run this with a window in front");
    return report();
  }

  const w = first.window;
  check("names the owning process", w.process.length > 0, w.process);
  check("reads a pid", w.pid > 0, String(w.pid));
  check("classifies the app", true, `${w.kind} (title origin: ${w.origin})`);

  // The title is the whole point, so it has to be checked — but printing it
  // would defeat the file it is testing. Length and shape only.
  check(
    "reads a title",
    w.hasTitle,
    w.hasTitle ? `${w.title.length} chars` : "window has no title (can be normal)",
  );

  // Non-ASCII survival is the specific defect found by hand: the console codepage
  // silently replaced a real title's first character with `?`. Only meaningful if
  // this window's title happens to contain non-ASCII, so it is reported either way.
  const nonAscii = [...w.title].filter((c) => c.codePointAt(0)! > 0x7f).length;
  check(
    "non-ASCII in the title is not mangled",
    !w.title.includes("?") || nonAscii > 0,
    nonAscii > 0 ? `${nonAscii} non-ASCII chars survived` : "title is pure ASCII; nothing to prove",
  );

  check("no control characters reach the caller", !/[\x00-\x1f\x7f]/.test(w.title));

  // --- CLIXML on stderr: the other hand-found defect ------------------------

  check(
    "the read is not polluted by PowerShell's progress stream",
    !w.title.includes("CLIXML") && !w.process.includes("CLIXML"),
  );

  // --- redaction, against this machine's real title -------------------------

  check(
    "an ordinary real title is not over-redacted",
    !w.redacted,
    w.redacted ? "something in this title looked secret-shaped" : "left intact",
  );

  const planted = `${w.title} ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345`;
  const { text, redacted } = redactSecrets(planted);
  check(
    "a planted credential in a real title is removed",
    redacted && !text.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"),
  );

  // --- caching: asking is not watching -------------------------------------

  const t1 = Date.now();
  await win.read();
  const cachedMs = Date.now() - t1;
  check(
    "a second question in the same breath does not spawn PowerShell again",
    cachedMs < elapsed / 2,
    `${elapsed} ms cold, ${cachedMs} ms cached`,
  );

  win.invalidate();
  const again = await win.read();
  check("reads again after focus is known to have moved", again.ok);

  check("one line a person can read", true, describeWindow(w));

  // --- the seam: does asking out loud actually reach this reader? -----------
  //
  // The engine tests drive the intent through a fake `readActiveWindow`, and
  // everything above drives the reader with no intent in front of it. Neither
  // one covers the join, and the join is where this project's defects have
  // lived: a dispatch table entry, an optional dep the runtime forgets to pass.
  // So this runs the real sentence through a real engine over the real window.
  await probeIntent(win, w.process, w.title);

  report();
}

/** "What am I looking at", end to end, with nothing faked but the catalog. */
async function probeIntent(
  win: ActiveWindow,
  expectProcess: string,
  title: string,
): Promise<void> {
  const audit: LocalDecision[] = [];
  const engine = new LocalIntentEngine(
    {
      // This intent must not touch the machine any other way. A stub that
      // throws turns "it quietly shelled out" into a visible failure.
      run: async () => {
        throw new Error("the window intent must not run a program");
      },
      launch: async () => {
        throw new Error("the window intent must not launch anything");
      },
      screenshotRoots: [],
      now: () => new Date(),
      setMicMuted: () => false,
      isMicMuted: () => false,
      readActiveWindow: () => win.read(),
    },
    { entries: [], onAudit: (d) => audit.push(d) },
  );

  const d = await engine.handle("what am i looking at");

  check("the spoken question routes locally", d.route === "local", `route=${d.route}`);
  check("it resolves to the window intent", d.intent === "window.active", d.intent ?? "(none)");
  check("the reply succeeded", d.outcome?.ok === true, d.outcome?.detail ?? "");
  check(
    "the reply names the window this machine actually has in front",
    (d.outcome?.speech ?? "").toLowerCase().includes(expectProcess.toLowerCase()),
    `expected to hear "${expectProcess}"`,
  );

  // §53 at the end of the real path, not just in a unit test: the audit line is
  // the one artefact of this that persists, and the title is the part of it that
  // can hold a document name or a subject line. Checked against this machine's
  // actual title rather than a fixture, using the longest word in it so a title
  // that happens to share a short word with the process name cannot pass by luck.
  const detail = d.outcome?.detail ?? "";
  const longest = [...title.split(/\s+/)].sort((a, b) => b.length - a.length)[0] ?? "";
  check(
    "the audit line carries the process but not the title",
    detail.includes(`process=${expectProcess}`) && (longest.length < 5 || !detail.includes(longest)),
    longest.length < 5 ? `${detail} (title too short to test against)` : detail,
  );
  check("every decision was audited", audit.length === 1, `${audit.length} entry`);
}

function report(): void {
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`${r.verdict.padEnd(5)} ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = results.filter((r) => r.verdict === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  console.log(`(cache TTL ${CACHE_MS} ms)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
