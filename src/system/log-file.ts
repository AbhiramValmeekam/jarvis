/**
 * A log file, because a packaged app has no console.
 *
 * `JarvisRuntime.log()` fans a line out to three places: an `onLog` callback,
 * an event, and the IPC broadcast. In a dev run the callback is
 * `console.log` and the terminal keeps everything. In the installed build
 * there is no terminal — `Jarvis.exe --runtime` is spawned detached with no
 * console attached — so every one of those three destinations is a listener
 * that may not exist. The line is formatted and dropped.
 *
 * That is the artefact that would have explained the *"internal error"* report
 * without any guesswork: `agent-failure.ts` now writes a banner naming the
 * code and the provider's own detail, and on an installed machine that banner
 * exists for as long as the user leaves it on screen and then is gone forever.
 *
 * Three properties, in the order they constrain the code:
 *
 * 1. **It cannot throw.** This is wired into an always-on process's logging
 *    path, which means it runs on the error path, during shutdown, and inside
 *    `uncaughtException`. A disk that is full, a file an antivirus scanner has
 *    locked, a profile directory that is read-only: every one of those must
 *    degrade to silence. A logger that takes the runtime down with it is
 *    strictly worse than no logger at all.
 * 2. **It cannot grow without bound.** An always-on process logs for weeks.
 *    Rotation is by size with one previous generation kept, so the disk cost
 *    is bounded at `2 × MAX_BYTES` and stays a number that can be written
 *    down (§72) rather than a leak nobody notices until the volume fills.
 * 3. **It redacts (§53).** "Never print them in logs" is verbatim from the
 *    requirements, and a file is the one destination a user will paste into a
 *    bug report. Upstream errors echo credentials back — `invalid api key
 *    sk-…` — so the same `redactSecrets` the banner and the window titles use
 *    runs here too, rather than trusting every present and future caller to
 *    have cleaned its line first.
 *
 * Writes are synchronous and the descriptor is not held open between them.
 * Both are deliberate: the reason to want this file at all is to explain a
 * process that died, and a buffered writer loses precisely the last few lines
 * — the ones describing the crash. Log volume is a handful of lines per turn,
 * so a syscall each is not a cost worth optimising against losing the ending.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { configFilePath } from "../context/config.js";
import { redactSecrets } from "../context/window-facts.js";

/** Rotate past this. Two generations, so 4 MB total per stream. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Truncate a single line here. A stack trace is welcome; a megabyte is not. */
const MAX_LINE = 4000;

/**
 * Where logs live: `logs/` beside the config file.
 *
 * Derived from `configFilePath()` rather than recomputing `%LOCALAPPDATA%`, so
 * "beside the config" stays true by construction — including under the test
 * helper that redirects the whole directory into a temp dir.
 */
export function logFilePath(name: string): string {
  return join(dirname(configFilePath()), "logs", `${name}.log`);
}

export interface LogFile {
  /** Append one line. Never throws. */
  write(line: string): void;
  /** Where it is going, for a startup line and for the tray to reveal. */
  readonly path: string;
}

/** A sink that discards. Returned when the directory cannot be created. */
function noop(path: string): LogFile {
  return { write: () => {}, path };
}

/**
 * `YYYY-MM-DD HH:MM:SS.mmm`, in **local** time.
 *
 * Not `toISOString()`, which is UTC. Hermes' own stdout lines are timestamped
 * locally and they land in this same file, so a UTC prefix put two clocks 5½
 * hours apart on adjacent lines of the first log this ever produced. The reader
 * of this file is a person comparing it against when they said something.
 */
function stamp(at: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ` +
    `${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}.${p(at.getMilliseconds(), 3)}`
  );
}

/**
 * Open a rolling log.
 *
 * `name` separates streams by process: the shell and the runtime are two
 * processes with two independent lifetimes, and pointing both at one file
 * would interleave their lines and race on rotation.
 */
export function openLogFile(name: string, now: () => Date = () => new Date()): LogFile {
  const path = logFilePath(name);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // No directory, no log. The caller keeps running.
    return noop(path);
  }

  const rotate = (): void => {
    try {
      if (statSync(path).size < MAX_BYTES) return;
    } catch {
      // Not there yet, which is the normal first-write case.
      return;
    }
    const previous = `${path}.1`;
    try {
      // `renameSync` will not overwrite on Windows, so the old generation goes
      // first. Losing the second-oldest lines is the intended trade.
      rmSync(previous, { force: true });
      renameSync(path, previous);
    } catch {
      // Locked by a reader, most likely. Better to let the live file exceed
      // its cap than to lose the stream entirely.
    }
  };

  return {
    path,
    write(line: string): void {
      try {
        const { text } = redactSecrets(line.replace(/[\r\n]+/g, " "));
        const bounded = text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text;
        rotate();
        appendFileSync(path, `${stamp(now())} ${bounded}\n`, "utf8");
      } catch {
        // Swallowed on purpose: see rule 1 above.
      }
    },
  };
}
