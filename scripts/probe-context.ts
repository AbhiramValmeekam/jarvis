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
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ActiveWindow, CACHE_MS } from "../src/context/active-window.js";
import { redactSecrets, describeWindow } from "../src/context/window-facts.js";
import { buildRegistry, describeProject, type DirEntry } from "../src/context/project-registry.js";
import { LocalIntentEngine } from "../src/local-intents/engine.js";
import type { LocalDecision } from "../src/local-intents/engine.js";

/** Same reader the runtime uses: one syscall per directory, not per entry. */
const readDirEntries = (dir: string): readonly DirEntry[] =>
  readdirSync(dir, { withFileTypes: true }).map((d) => ({
    name: d.name,
    isDirectory: d.isDirectory(),
  }));

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

  // The registry has the same gap as the window reader, for the same reason: 28
  // unit tests drive `buildRegistry` through a fake `readDir`, which proves the
  // walk and the alias rules and says nothing about whether a real Windows
  // directory tree produces the projects a person would name out loud.
  await probeProjects();

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

/**
 * The project registry against this machine's actual disk.
 *
 * Scans the folder this repository lives in, which is guaranteed to contain at
 * least one real project — this one. Read-only: `readdirSync` and nothing else.
 * The launch dep throws, so a probe that accidentally opens Explorer fails
 * loudly instead of leaving windows on the user's desktop.
 */
async function probeProjects(): Promise<void> {
  const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

  const t0 = Date.now();
  const found = buildRegistry({ roots: [root], readDir: readDirEntries });
  const scanMs = Date.now() - t0;

  check("scans a real directory tree", found.length > 0, `${found.length} project(s) in ${scanMs} ms`);
  if (found.length === 0) return;

  // Jarvis itself must be in there. If the walk cannot find the repository it is
  // running out of, nothing else it found is trustworthy either.
  const self = found.find((p) => p.key === "jarvis");
  check("finds this repository", self !== undefined, self ? describeProject(self) : "no `jarvis` entry");

  check(
    "every directory it reports actually exists",
    found.every((p) => existsSync(p.dir)),
    found.filter((p) => !existsSync(p.dir)).map((p) => p.dir)[0] ?? "all present",
  );

  check(
    "classifies by what is inside, not by the name",
    found.every((p) => p.kind !== undefined),
    [...new Set(found.map((p) => p.kind))].join(", "),
  );

  // Aliases are the part a person actually uses. A registry full of projects
  // that can only be opened by typing their exact folder name is not useful out
  // loud, which is the only way this gets used.
  const named = found.filter((p) => p.aliases.length > 0);
  check("projects have spoken aliases", named.length === found.length, `${named.length}/${found.length}`);

  // The end-to-end join, same reasoning as the window intent above: this is the
  // real sentence, through a real engine, over a registry built from real disk.
  const launched: string[] = [];
  const engine = new LocalIntentEngine(
    {
      run: async () => {
        throw new Error("the project intents must not run a program");
      },
      // Recorded rather than performed. Opening Explorer windows on someone's
      // desktop is not something a diagnostic should do.
      launch: async (_file, args) => {
        launched.push(args.join(" "));
      },
      screenshotRoots: [],
      now: () => new Date(),
      setMicMuted: () => false,
      isMicMuted: () => false,
      projects: () => found,
      projectRoots: () => [root],
    },
    { entries: [] },
  );

  const list = await engine.handle("what projects do i have");
  check("listing them routes locally", list.route === "local", `route=${list.route}`);
  check(
    "the list names a project that is really there",
    (list.outcome?.speech ?? "").toLowerCase().includes(found[0]?.key ?? "\u0000"),
    list.outcome?.speech ?? "",
  );

  const open = await engine.handle("open my jarvis project");
  if (open.route === "ask") {
    // Legitimate on a machine with several jarvis-ish folders, and worth seeing:
    // it means the collision path is live on real data rather than only in a
    // fixture. Answering it is the rest of the proof.
    check("a colliding name is asked about, not guessed", true, open.question ?? "");
    const answer = await engine.handle(self?.key ?? "jarvis");
    check("the answer opens the one that was named", answer.route === "local", `route=${answer.route}`);
  } else {
    check("opening by name routes locally", open.route === "local", `route=${open.route}`);
  }

  // The security property this whole design exists for: the path handed to the
  // shell came out of the scan, not out of the sentence.
  check(
    "the path opened came from the registry, not the utterance",
    launched.length === 1 && found.some((p) => launched[0] === p.dir),
    launched[0] ?? "(nothing launched)",
  );

  // Said aloud near a microphone, these are just words. Neither may become a path.
  const before = launched.length;
  await engine.handle("open my ..\\..\\Windows\\System32 project");
  await engine.handle("open my C:\\Windows project");
  check("a traversal-shaped name opens nothing", launched.length === before);

  // --- the pronoun, over the same real registry -----------------------------
  //
  // Referents are recorded from executor outcomes, which means the fixtures can
  // only prove the wiring if the executor really ran. Here it did: whatever was
  // opened above is now the subject.
  const again = await engine.handle("open it again");
  check(
    "\"open it\" reopens what was just opened",
    again.route === "local" && launched.length === before + 1 && launched[before] === launched[0],
    `route=${again.route}`,
  );

  const destructive = await engine.handle("delete it");
  check(
    "a destructive pronoun is never resolved locally",
    destructive.route === "agent" && launched.length === before + 1,
    `route=${destructive.route}`,
  );
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
