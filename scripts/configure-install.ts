/**
 * Point an installed Jarvis at this checkout.
 *
 *   npm run install:config
 *
 * **Why this exists.** Four assets are found relative to the runtime's working
 * directory and nowhere else: `.venv/Scripts/python.exe` and `voice/daemon.py`
 * (resolved by `VoiceSidecar`), and `models/piper/…` and `.research/whisper`
 * (defaulted inside `voice/daemon.py`). Windows starts a Run-key entry in
 * `C:\Windows\system32`, where all four resolve to nothing — so an installed,
 * auto-started Jarvis would come up in the tray, answer typed input, and never
 * hear the word "Jarvis". Writing `workingDirectory` into the config file fixes
 * all four at once, because the daemon is spawned with that same directory as
 * its cwd.
 *
 * The 473 MB venv is not relocatable — `pyvenv.cfg` hardcodes an absolute
 * `home =` — so copying it into the installed app was never an option. The
 * installed build points back here instead, which is why this build is not
 * portable to another machine.
 *
 * **What it touches:** exactly one file, `%LOCALAPPDATA%\Jarvis\config.json`,
 * which belongs to Jarvis. No registry, no system change, no admin. Existing
 * keys are merged, not replaced: a user's `projectRoots`, `projectAliases` and
 * `notifyLevel` survive, and anything this build has never heard of survives too
 * — the raw object is edited, not a re-serialised `JarvisConfig`, so a key
 * written by a newer Jarvis is not quietly deleted by an older one.
 *
 *   npx tsx scripts/configure-install.ts [--dir <path>] [--print]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configFilePath, loadConfig } from "../src/context/config.js";
import { canonicalise } from "../src/system/path-safety.js";

const args = process.argv.slice(2);
const printOnly = args.includes("--print");
const dirArg = args.indexOf("--dir") >= 0 ? args[args.indexOf("--dir") + 1] : undefined;

/** The repo root: this file's directory, one level up. Not `process.cwd()` — the
 *  whole point of this script is that a working directory cannot be trusted. */
function repoRoot(): string {
  return resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
}

/** The four things that only work if the directory is right. Reported, not gated:
 *  a missing Whisper cache downloads on first use, a missing venv does not. */
function assets(root: string): { label: string; path: string; required: boolean }[] {
  return [
    { label: "Python venv", path: resolve(root, ".venv/Scripts/python.exe"), required: true },
    { label: "voice daemon", path: resolve(root, "voice/daemon.py"), required: true },
    {
      label: "Piper voice",
      path: resolve(root, "models/piper/en_GB-alan-medium.onnx"),
      required: false,
    },
    { label: "Whisper cache", path: resolve(root, ".research/whisper"), required: false },
  ];
}

function main(): void {
  const target = dirArg ? resolve(dirArg) : repoRoot();
  const verdict = canonicalise(target);
  if (!verdict.ok || !verdict.path) {
    console.error(`refusing ${target}: ${verdict.reason ?? "not a usable path"}`);
    process.exit(1);
  }
  const dir = verdict.path;

  console.log(`working directory : ${dir}`);
  let missing = 0;
  for (const a of assets(dir)) {
    const there = existsSync(a.path);
    if (!there && a.required) missing += 1;
    const mark = there ? "found" : a.required ? "MISSING" : "absent (will download on first use)";
    console.log(`  ${a.label.padEnd(14)} ${mark}`);
  }
  if (missing > 0) {
    // Written anyway. A venv that is not built yet is a `uv sync` away, and
    // refusing to write the config would leave the user fixing two things
    // instead of one — but saying nothing would let them believe voice works.
    console.log(
      `\n${missing} required asset(s) missing. The config is still written, but voice will\n` +
        "report unavailable until they exist. Build the venv, then re-run this.",
    );
  }

  const file = configFilePath();
  console.log(`\nconfig file       : ${file}`);

  // The raw object, not `loadConfig`'s parsed view: writing back a parsed view
  // would silently drop every key this build does not recognise.
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      } else {
        console.log("  (existing file is not an object — it will be replaced)");
      }
    } catch (err) {
      console.error(
        `\nrefusing to overwrite a config that could not be parsed: ${err}\n` +
          "Fix or delete the file by hand, then re-run. Merging into a file this\n" +
          "script cannot read would mean deleting settings it cannot see.",
      );
      process.exit(1);
    }
  }

  const before = raw.workingDirectory;
  console.log(`  before          : ${before === undefined ? "(unset)" : String(before)}`);
  console.log(`  after           : ${dir}`);
  const kept = Object.keys(raw).filter((k) => k !== "workingDirectory");
  console.log(`  keys preserved  : ${kept.length ? kept.join(", ") : "(none)"}`);

  if (printOnly) {
    console.log("\n--print: nothing written.");
    return;
  }
  if (before === dir) {
    console.log("\nAlready set to this directory. Nothing written.");
    return;
  }

  raw.workingDirectory = dir;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);

  // Read it back through the real loader, because "we wrote the file" is a claim
  // about this script and the question is what Jarvis will read at boot.
  const readBack = loadConfig(file);
  if (readBack.workingDirectory !== dir) {
    console.error(
      `\nwrote the file, but loadConfig read back ${String(readBack.workingDirectory)}.`,
    );
    process.exit(1);
  }
  console.log("\nWritten, and verified by reading it back through loadConfig.");
}

main();
