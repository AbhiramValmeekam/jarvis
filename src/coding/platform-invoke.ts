/**
 * Turning "open this project" and "tell it to do this" into an argv.
 *
 * One file between the catalogue and anything that spawns, because the awkward
 * part is the same awkward part `resolve-npm.ts` documents and it is worth
 * solving once. Every editor in the VS Code family ships its command line twice:
 * as `bin\code.cmd`, a batch shim, and as `resources\app\out\cli.js`, an
 * ordinary JavaScript file the app binary will run when `ELECTRON_RUN_AS_NODE`
 * is set. Only the second one can be spawned.
 *
 * That is not a portability nicety. Since the fix for CVE-2024-27980 Node
 * refuses to spawn a `.cmd` at all without `shell: true`, and `shell: true` on
 * Windows concatenates the argv into a command line for `cmd.exe` (DEP0190).
 * A prompt is the one argument here that came from a person talking, so a route
 * through `cmd.exe` would be a route where `&`, `|` and `>` inside a sentence
 * stop being punctuation. There is no version of that which is acceptable, so
 * the shim is never run: it is only ever read for where it points.
 *
 * `openInvocation` and `promptInvocation` are separate because they can fail
 * differently. Opening a project needs the app binary and nothing else. Carrying
 * a prompt needs the CLI entry point *and* a platform whose channel says a
 * prompt will be received — and `promptInvocation` returns `null` rather than a
 * best effort when either is missing, which is what makes the tool layer able to
 * say "opened it, and here is why I could not also tell it anything".
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { InstalledPlatform } from "./platforms.js";

/** A spawnable call: an argv array, and nothing that a shell will re-read. */
export interface Invocation {
  readonly file: string;
  readonly args: readonly string[];
  /** Extra environment, empty unless the CLI entry point is being run. */
  readonly env: Readonly<Record<string, string>>;
  /** Always false. Present so a caller cannot forget to think about it. */
  readonly needsShell: false;
}

export interface InvokeDeps {
  readonly exists?: (path: string) => boolean;
  readonly readdir?: (path: string) => readonly string[];
}

/**
 * The install root, from whichever file discovery happened to find.
 *
 * Two shapes: `<root>\bin\code.cmd` when it came off `PATH`, and
 * `<root>\Code.exe` when it came from the install table. Deciding by the parent
 * directory's name rather than by the file's extension, because a fork is free
 * to ship a `.exe` shim in `bin` and one day one will.
 */
function installRoot(command: string): string {
  const parent = dirname(command);
  return basename(parent).toLowerCase() === "bin" ? dirname(parent) : parent;
}

/**
 * Where the CLI entry point lives under an install root.
 *
 * Checked in two places because the two installers differ and neither is
 * guessable: Antigravity keeps `resources` directly under the root, while VS
 * Code's updater keeps a per-commit directory in between (`110a328ea5\resources\
 * …` on this machine, and a different name after the next update). So one fixed
 * candidate, then one shallow scan — never a recursive walk, which on an
 * install root is a lot of disk for a file whose two possible homes are known.
 */
function cliEntry(root: string, deps: InvokeDeps): string | null {
  const exists = deps.exists ?? existsSync;
  const direct = join(root, "resources", "app", "out", "cli.js");
  if (exists(direct)) return direct;
  const readdir = deps.readdir ?? ((p: string) => safeReaddir(p));
  for (const child of readdir(root)) {
    const nested = join(root, child, "resources", "app", "out", "cli.js");
    if (exists(nested)) return nested;
  }
  return null;
}

/** A missing or unreadable directory is "no entry point", not an exception. */
function safeReaddir(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** The app binary, which is what opens a window. */
function appBinary(p: InstalledPlatform, deps: InvokeDeps): string | null {
  const exists = deps.exists ?? existsSync;
  if (p.spec.exeName === undefined) return p.needsShell ? null : p.command;
  const candidate = join(installRoot(p.command), p.spec.exeName);
  if (exists(candidate)) return candidate;
  // The catalogue named a binary that is not there — a rename between versions.
  // Falling back to whatever discovery found is right only when that file can be
  // spawned; a shim cannot, and pretending otherwise is the DEP0190 trap.
  return p.needsShell ? null : p.command;
}

/**
 * Open a project directory in a platform.
 *
 * `null` when the only file discovery found is a batch shim and no app binary
 * could be located beside it — a state worth reporting rather than working
 * around, since working around it means `cmd.exe`.
 */
export function openInvocation(
  p: InstalledPlatform,
  dir: string,
  extraFiles: readonly string[] = [],
  deps: InvokeDeps = {},
): Invocation | null {
  const file = appBinary(p, deps);
  if (file === null) return null;
  return {
    file,
    args: [...p.spec.openArgs, dir, ...extraFiles],
    env: {},
    needsShell: false,
  };
}

/** Why a prompt could not be delivered, in words a person can act on. */
export type PromptRefusal =
  | "channel"
  | "no-contract"
  | "no-cli";

/**
 * Carry a prompt into a platform, or say which of three things was missing.
 *
 * `channel`     the platform is `handoff`: there is no command line that
 *               receives a task, so the answer is a staged handoff and not a
 *               worse version of this.
 * `no-contract` the catalogue has no `promptArgs` for it. Distinct from
 *               `channel` on purpose — this is a gap in this repository, and the
 *               fix is a line in the table.
 * `no-cli`      the entry point was not found under the install root, so the
 *               contract is right and this installation is shaped unexpectedly.
 *
 * The prompt is the last element of the argv and never interpolated into
 * anything. Every `promptArgs` in the catalogue ends with `--`, so a task that
 * begins with a dash is a task rather than an option — the one detail that would
 * otherwise turn "-p should be a flag, surely" into a parse error in front of a
 * user.
 */
export function promptInvocation(
  p: InstalledPlatform,
  prompt: string,
  deps: InvokeDeps = {},
): Invocation | { readonly refused: PromptRefusal } {
  if (p.spec.channel !== "headless") return { refused: "channel" };
  const contract = p.spec.promptArgs;
  if (contract === undefined) return { refused: "no-contract" };
  if (p.spec.family !== "vscode") {
    // A plain command-line agent: run the file discovery found, whatever it is,
    // provided it is not a shim. `claude.exe` is this case.
    const file = appBinary(p, deps);
    if (file === null) return { refused: "no-cli" };
    return { file, args: [...contract, prompt], env: {}, needsShell: false };
  }
  const root = installRoot(p.command);
  const cli = cliEntry(root, deps);
  const exe = appBinary(p, deps);
  if (cli === null || exe === null) return { refused: "no-cli" };
  return {
    file: exe,
    args: [cli, ...contract, prompt],
    // What the batch shim sets, and the reason the shim exists at all: it flips
    // the Electron binary into being a Node interpreter for the file named next.
    env: { ELECTRON_RUN_AS_NODE: "1", VSCODE_DEV: "" },
    needsShell: false,
  };
}
