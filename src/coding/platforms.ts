/**
 * Which coding platforms are on this machine, and how a task can reach each one.
 *
 * `src/coding/claude-code-manager.ts` already delegates work to one agent. This
 * file answers the question that came before it and was never written down: what
 * *else* is installed, and for each of those, is there a way to hand over a task
 * or only a way to open a window.
 *
 * The distinction is the whole point of the module, because it is the thing that
 * was previously guessed. Asked to "open Antigravity and tell it to make a small
 * HTML page", Jarvis could open Antigravity and then had to admit it could not
 * say anything to it. That admission was correct, and it was correct for a
 * reason nobody had established — so the reason is established here, per
 * platform, and it is what the tool layer reports.
 *
 * ## The two channels, and why there is no third
 *
 * `headless` — the platform has a command line that takes a task and does the
 * work with no window and no keyboard. `claude -p` is this. A delegation over
 * this channel produces a result Jarvis can check afterwards, which is why
 * `work-check.ts` exists.
 *
 * `handoff` — the platform has a command line that opens a project and nothing
 * more. The task is prepared (a file, and the clipboard) and the last step is a
 * human paste. Jarvis says so rather than claiming a delivery it did not make.
 *
 * A third channel — synthesising keystrokes into whichever window happens to be
 * in front — is deliberately absent. Not because it cannot be done, but because
 * it cannot be *verified*: nothing outside the editor can tell whether the
 * caret is in an agent panel or in a source file, and a prompt typed into the
 * latter is an edit nobody asked for. §43's rule against a capability that
 * looks like the tool it is named after applies here more than anywhere.
 *
 * ## Verified, and the rest
 *
 * Every contract below carries the date it was checked on a real installation,
 * or `null` when it was not. Two of them were checked on 2026-08-23 and one of
 * those checks changed the answer:
 *
 *   - **Antigravity IDE 1.107.0** advertises a `chat` subcommand in `--help`,
 *     inherited from the VS Code base. It does not work. Running
 *     `antigravity-ide chat -m agent "<prompt>"` opens a window and the
 *     renderer log says `command 'workbench.action.chat.newChat' not found` —
 *     the fork replaced VS Code's chat stack with its own Cascade panel and the
 *     CLI route into it was not carried over. Exit code is 0 either way, which
 *     is exactly the shape of a channel that would have been trusted on the
 *     strength of `--help`. So Antigravity is `handoff`.
 *   - **VS Code 1.134.0** has the same subcommand and it is wired: `code chat`
 *     opens a chat session on the prompt. It still needs a chat provider signed
 *     in, which is a fact about the installation rather than the contract, so
 *     the channel is `headless` and the result reports what the window did.
 *
 * The entries nobody could check are here anyway, because an uninstalled
 * platform is never discovered and therefore never claimed. What their presence
 * buys is that the day one of them appears on PATH, the failure is a wrong flag
 * and not a platform Jarvis cannot see.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** How a task reaches a platform. See the header on why there are only two. */
export type PlatformChannel = "headless" | "handoff";

/** One platform Jarvis knows the shape of, installed or not. */
export interface PlatformSpec {
  /** Stable id, and what a caller names. Lower case, hyphenated. */
  readonly id: string;
  /** What a person calls it. Used in spoken replies. */
  readonly label: string;
  readonly channel: PlatformChannel;
  /**
   * Bare executable names to look for on `PATH`, most specific first.
   *
   * Extensionless on purpose: the lookup expands them over `PATHEXT` and returns
   * the file it actually found, so `needsShell` is decided from that file's
   * extension rather than from an assumption about it. That is the rule
   * `resolveNpm` records — the thing that runs has to be the thing the shell
   * flag was chosen for — kept by resolving first and deciding second.
   */
  readonly onPath: readonly string[];
  /**
   * Absolute candidates, as `[envVarName, ...pathParts]`.
   *
   * A GUI editor is usually not on `PATH` — its installer adds a `bin` shim and
   * often only for the user who ran it — so the install location is checked too.
   */
  readonly installed: readonly (readonly string[])[];
  /** Arguments that open a project directory, before the directory itself. */
  readonly openArgs: readonly string[];
  /**
   * Arguments that carry a task, with the task appended last.
   *
   * Only meaningful for a `headless` platform, and absent for every `handoff`
   * one — which is what makes "can this be told anything" a property of the
   * table rather than of a code path.
   */
  readonly promptArgs?: readonly string[];
  /**
   * The editor family this platform is a fork of.
   *
   * `"vscode"` means its command line is the one `resources/app/out/cli.js`
   * implements, which `platform-invoke.ts` reaches through the app binary rather
   * than through the `bin` shim — the `resolveNpm` manoeuvre, for the same reason:
   * the shim is a batch file, and a batch file cannot be spawned without handing
   * a command line to `cmd.exe`, which is where a prompt would stop being one
   * argument.
   */
  readonly family?: "vscode";
  /** The app binary inside the install root. Needed only for a `family`. */
  readonly exeName?: string;
  /** When this contract was last checked against a real install. */
  readonly checkedOn: string | null;
  /** One line a person reads when they ask why a platform behaves as it does. */
  readonly note: string;
}

/**
 * Everything Jarvis knows how to talk to, in the order it prefers them.
 *
 * Order is capability, not taste: a `headless` platform can finish the work, so
 * it comes before one that can only be opened. `delegate_coding_task` picks the
 * first installed entry when the caller names no platform, which makes "write me
 * a small HTML page" land somewhere it can actually be written.
 */
export const PLATFORMS: readonly PlatformSpec[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    channel: "headless",
    onPath: ["claude"],
    installed: [["USERPROFILE", ".local", "bin", "claude.exe"], ["HOME", ".local", "bin", "claude"]],
    openArgs: [],
    // The real invocation is built by `claude-cli.ts#buildArgs`, which knows about
    // `--tools`, the permission mode and the budget. These are here so the table
    // is uniform; the manager is what actually runs.
    promptArgs: ["-p", "--output-format", "json", "--"],
    checkedOn: "2026-08-23",
    note: "runs the task headless and reports a result Jarvis can check afterwards",
  },
  {
    id: "vscode",
    label: "Visual Studio Code",
    channel: "headless",
    onPath: ["code"],
    installed: [
      ["LOCALAPPDATA", "Programs", "Microsoft VS Code", "Code.exe"],
      ["ProgramFiles", "Microsoft VS Code", "Code.exe"],
    ],
    family: "vscode",
    exeName: "Code.exe",
    openArgs: ["--reuse-window"],
    // `chat` is a subcommand, not a flag, which is why `--help`'s flag list looks
    // like there is no way in. `-m agent` asks for the mode that edits files;
    // `--` ends the options so a prompt beginning with a dash is still a prompt.
    promptArgs: ["chat", "-m", "agent", "--reuse-window", "--"],
    checkedOn: "2026-08-23",
    note: "`code chat` opens a chat session on the prompt; needs a signed-in chat provider",
  },
  {
    id: "antigravity",
    label: "Antigravity IDE",
    channel: "handoff",
    onPath: ["antigravity-ide"],
    installed: [["LOCALAPPDATA", "Programs", "Antigravity IDE", "Antigravity IDE.exe"]],
    family: "vscode",
    exeName: "Antigravity IDE.exe",
    openArgs: ["--reuse-window"],
    checkedOn: "2026-08-23",
    note: "its `chat` subcommand is inherited from VS Code and dead in the fork (`workbench.action.chat.newChat` not found), so the task is staged and pasted by hand",
  },
  {
    id: "cursor",
    label: "Cursor",
    channel: "handoff",
    onPath: ["cursor"],
    installed: [["LOCALAPPDATA", "Programs", "cursor", "Cursor.exe"]],
    openArgs: ["--reuse-window"],
    checkedOn: null,
    note: "absent here, so its agent CLI was never checked; treated as open-only until it is",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    channel: "handoff",
    onPath: ["windsurf"],
    installed: [["LOCALAPPDATA", "Programs", "Windsurf", "Windsurf.exe"]],
    openArgs: ["--reuse-window"],
    checkedOn: null,
    note: "absent here; treated as open-only until a prompt channel is established",
  },
  {
    id: "trae",
    label: "Trae",
    channel: "handoff",
    onPath: ["trae"],
    installed: [["LOCALAPPDATA", "Programs", "Trae", "Trae.exe"]],
    openArgs: ["--reuse-window"],
    checkedOn: "2026-08-23",
    // Installed here, and found by install path rather than `PATH`. Whether it has
    // an agent CLI was not established, so it claims the channel it can prove.
    note: "opens a project; no prompt-carrying command line was established for it",
  },
];

/** A platform that is really on this machine, with the file that will be run. */
export interface InstalledPlatform {
  readonly spec: PlatformSpec;
  /** Absolute path, or the resolved `PATH` entry. Never a bare name. */
  readonly command: string;
  /** True when `command` is a `.cmd`/`.bat` shim Node will not spawn directly. */
  readonly needsShell: boolean;
  /** Where it was found, for a person reading the probe output. */
  readonly foundVia: "path" | "install";
}

export interface DiscoverDeps {
  readonly platform?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected by tests, so discovery is decidable without installing anything. */
  readonly exists?: (path: string) => boolean;
}

/** Batch shims cannot be spawned without a shell. See `resolve-npm.ts`. */
function isShim(path: string): boolean {
  return /\.(?:cmd|bat)$/i.test(path);
}

/**
 * Find a bare name on `PATH`, returning the file rather than the name.
 *
 * Deliberately not `where`/`which`: this runs on the request path in front of a
 * user, and spawning a process per candidate to find out that six of seven
 * editors are absent is a second of latency for an answer the filesystem already
 * has. It also keeps discovery injectable, which is what lets the tests decide
 * what is installed.
 */
function onPath(name: string, deps: Required<Pick<DiscoverDeps, "exists">> & DiscoverDeps): string | null {
  const env = deps.env ?? process.env;
  const dirs = (env.PATH ?? env.Path ?? "").split(deps.platform === "win32" ? ";" : ":");
  const exts =
    deps.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")
      : [""];
  for (const dir of dirs) {
    if (dir.trim() === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      if (deps.exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Expand `["LOCALAPPDATA", "Programs", …]` against the environment. */
function installPath(
  parts: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const [variable, ...rest] = parts;
  const base = variable === undefined ? undefined : env[variable];
  return base === undefined || base === "" ? null : join(base, ...rest);
}

/**
 * Which of the known platforms are actually here.
 *
 * Pure apart from the injected `exists`, and cheap enough to call per request:
 * no process is spawned and nothing is cached, so an editor installed after boot
 * is found by the next question rather than the next restart — the same reason
 * `ProjectDeps.projects` is a function.
 */
export function discoverPlatforms(deps: DiscoverDeps = {}): readonly InstalledPlatform[] {
  const exists = deps.exists ?? existsSync;
  const env = deps.env ?? process.env;
  const resolved: InstalledPlatform[] = [];
  for (const spec of PLATFORMS) {
    let found: { command: string; foundVia: "path" | "install" } | null = null;
    for (const name of spec.onPath) {
      const hit = onPath(name, { ...deps, exists });
      if (hit) {
        found = { command: hit, foundVia: "path" };
        break;
      }
    }
    if (!found) {
      for (const parts of spec.installed) {
        const candidate = installPath(parts, env);
        if (candidate !== null && exists(candidate)) {
          found = { command: candidate, foundVia: "install" };
          break;
        }
      }
    }
    if (found) {
      resolved.push({ spec, command: found.command, needsShell: isShim(found.command), foundVia: found.foundVia });
    }
  }
  return resolved;
}

/** The one a caller named, or `null` — never a near miss guessed at. */
export function findPlatform(
  id: string,
  installed: readonly InstalledPlatform[],
): InstalledPlatform | null {
  const wanted = id.trim().toLowerCase();
  return (
    installed.find((p) => p.spec.id === wanted) ??
    installed.find((p) => p.spec.label.toLowerCase() === wanted) ??
    // A spoken name arrives as a word, not an id: "antigravity" for
    // `antigravity`, "vs code" for `vscode`. Compared with punctuation removed,
    // and only as a last resort, so an exact id always wins.
    installed.find((p) => p.spec.label.toLowerCase().replace(/[^a-z0-9]/g, "") === wanted.replace(/[^a-z0-9]/g, "")) ??
    null
  );
}
