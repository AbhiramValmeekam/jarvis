/**
 * Reading `.env` without a dependency, and the two rules that makes necessary.
 *
 * The master prompt asks for `.env` plus a committed `.env.example`; the plan says
 * no new runtime dependencies, and this repository's only two are React and React
 * DOM. So the parser is here, hand-rolled in the style `context/config.ts` already
 * uses for the same reason: a file a person edits by hand, read once at boot, where
 * a line that makes no sense is skipped rather than made into an error.
 *
 * Two rules that are not about parsing:
 *
 *  - **The real environment wins.** A `.env` file never overwrites a variable the
 *    process was started with. Someone who exported `ANTHROPIC_API_KEY` in the shell
 *    they launched from has said something more deliberate than a file left in a
 *    checkout, and a file silently shadowing it is how the wrong key gets used for a
 *    week.
 *  - **Values never reach a log line.** Nothing in this file prints a value, and
 *    `describeSecret` exists so that "is a key configured" can be answered on the
 *    wire and in the runtime log without answering "which key".
 *
 * The file is read from the runtime's working directory — the same directory
 * `config.ts`'s `workingDirectory` note is about — so a packaged Jarvis started from
 * `C:\Windows\system32` finds no `.env` and comes up with no model rather than with
 * someone else's.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The file, as read. Values are secrets as far as everything else is concerned. */
export type EnvMap = Readonly<Record<string, string>>;

/** Where `loadEnv` looks, relative to a working directory. */
export const ENV_FILE = ".env";

/**
 * Parse `.env` text.
 *
 * Deliberately a small subset: `KEY=value`, one per line, `#` comments, optional
 * `export` prefix, optional single or double quotes around the value. No variable
 * interpolation and no multi-line values — both are features whose failure mode is
 * a key that is subtly not the key on the line, which is the worst kind of bug to
 * have in the one file nobody can print to check.
 */
export function parseEnv(text: string): EnvMap {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;

    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = body.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      // Unquoted values end at a comment, which is how `KEY=abc # note` is meant
      // to read. Inside quotes a `#` is part of the value and is left alone.
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (value !== "") out[key] = value;
  }
  return out;
}

/**
 * The environment a provider is configured from: the process's, plus `.env` for
 * anything the process did not already define.
 *
 * `onNote` gets one line saying whether a file was found and how many keys it
 * contributed. Not which keys — a name like `ACME_STAGING_KEY` is itself
 * information about the user, and the count is enough to tell "my file is being
 * read" from "my file is being ignored", which is the only question this answers.
 */
export function loadEnv(
  workingDirectory: string,
  onNote?: (line: string) => void,
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
): EnvMap {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === "string" && value !== "") out[key] = value;
  }

  const file = join(workingDirectory, ENV_FILE);
  if (!existsSync(file)) {
    onNote?.(`no ${ENV_FILE} in ${workingDirectory}; using the process environment only`);
    return out;
  }

  let parsed: EnvMap = {};
  try {
    parsed = parseEnv(readFileSync(file, "utf8"));
  } catch (err) {
    // Same posture as a malformed config: say so and come up without it, rather
    // than refusing to start because of a file that is not required at all.
    onNote?.(`could not read ${file}: ${err instanceof Error ? err.message : "unknown error"}`);
    return out;
  }

  let added = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (out[key] !== undefined) continue;
    out[key] = value;
    added++;
  }
  onNote?.(`read ${file}: ${added} of ${Object.keys(parsed).length} setting(s) applied`);
  return out;
}

/**
 * Whether a secret is configured, in words that are safe to show anywhere.
 *
 * The length is included because it separates the two failure modes a user
 * actually hits — nothing set, and something set that is a truncated paste — and it
 * reveals nothing usable about the value itself.
 */
export function describeSecret(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "not set";
  return `set (${value.trim().length} characters)`;
}
