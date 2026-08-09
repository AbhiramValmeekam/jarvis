/**
 * The list of applications "open X" is allowed to mean.
 *
 * This is the boundary that keeps a spoken app name from ever becoming an
 * executable path. The matcher resolves an utterance to a *key* in this catalog
 * and nothing else; the executor then runs the launch spec stored against that
 * key. A name Jarvis has not already discovered on this machine cannot be
 * launched locally at all — it goes to the agent, which has to ask permission
 * like anything else.
 *
 * Discovery reads Start Menu shortcuts, because that is the list Windows itself
 * considers "the installed applications" and it needs no registry spelunking and
 * no elevation. Two Start Menu roots are read: the per-user one and the shared
 * one, which is where most installers actually put things.
 *
 * **Shortcut targets are deliberately not resolved.** Reading a `.lnk`'s target
 * means parsing the shell link format or asking the shell to do it, and the
 * result would be an executable path derived from a file on disk — exactly the
 * kind of value §52 says to distrust. Handing the `.lnk` itself to the shell is
 * both simpler and safer: Windows resolves it the same way a double-click would,
 * arguments and working directory included, and Jarvis never has to be right
 * about what the target was. Website shortcuts (`.url`) are skipped entirely;
 * see `SHORTCUT`.
 */
import { win32 as path } from "node:path";

/** How a catalog entry gets started. Mirrors `AppEntry` in the executors. */
export type LaunchSpec =
  | { kind: "exec"; file: string; args?: readonly string[] }
  | { kind: "uri"; uri: string };

export interface CatalogEntry {
  /** Canonical key: lowercase, the form the matcher resolves to. */
  key: string;
  /** Display name, spoken back in "Opening ___." */
  name: string;
  launch: LaunchSpec;
  /** Everything a person might reasonably say for this app, lowercased. */
  aliases: readonly string[];
  /** Where it came from, for the catalog view and for debugging. */
  source: "builtin" | "start-menu";
}

/** Directory listing, injected so this module does no I/O of its own. */
export type ReadDir = (dir: string) => readonly string[];

export interface CatalogOptions {
  /** Start Menu roots to scan. Missing directories are skipped, not an error. */
  startMenuRoots?: readonly string[];
  readDir?: ReadDir;
  /** Cap on discovered entries, so a pathological machine cannot exhaust memory. */
  limit?: number;
}

/**
 * Apps that ship with Windows, addressed the way Windows wants them addressed.
 *
 * `ms-settings:` and friends are protocol URIs rather than executables because
 * the modern Settings app has no launchable .exe a caller should be poking at.
 * These are listed explicitly instead of discovered: they are stable, and their
 * spoken names ("settings", "calculator") are the ones people actually use.
 */
const BUILTINS: readonly CatalogEntry[] = [
  {
    key: "notepad",
    name: "Notepad",
    launch: { kind: "exec", file: "notepad.exe" },
    aliases: ["notepad", "note pad", "text editor"],
    source: "builtin",
  },
  {
    key: "calculator",
    name: "Calculator",
    launch: { kind: "uri", uri: "calculator:" },
    aliases: ["calculator", "calc"],
    source: "builtin",
  },
  {
    key: "file explorer",
    name: "File Explorer",
    launch: { kind: "exec", file: "explorer.exe" },
    aliases: ["file explorer", "explorer", "files", "my computer", "this pc"],
    source: "builtin",
  },
  {
    key: "settings",
    name: "Settings",
    launch: { kind: "uri", uri: "ms-settings:" },
    aliases: ["settings", "windows settings", "system settings"],
    source: "builtin",
  },
  {
    key: "task manager",
    name: "Task Manager",
    launch: { kind: "exec", file: "taskmgr.exe" },
    aliases: ["task manager", "taskmgr"],
    source: "builtin",
  },
  {
    key: "terminal",
    name: "Windows Terminal",
    launch: { kind: "exec", file: "wt.exe" },
    aliases: ["terminal", "windows terminal", "console"],
    source: "builtin",
  },
  {
    key: "snipping tool",
    name: "Snipping Tool",
    launch: { kind: "uri", uri: "ms-screenclip:" },
    aliases: ["snipping tool", "snip", "screen clip"],
    source: "builtin",
  },
];

/**
 * Shortcuts that are not applications a person would ask for by name.
 *
 * Uninstallers and help files sit in the Start Menu beside real apps, and
 * "open uninstall" resolving to a live uninstaller is a genuinely bad outcome
 * for a voice command — so they are dropped at discovery rather than filtered
 * at match time.
 */
const EXCLUDED = /\b(uninstall|readme|help|documentation|release notes|licence|license|website|manual|repair|modify)\b/i;

/** Suffixes an installer adds that nobody says out loud. */
const NOISE_SUFFIX =
  /\s*(?:\(x64\)|\(x86\)|\(64-bit\)|\(32-bit\)|\(user\)|\(current user\)|\d+\.\d+(?:\.\d+)*)\s*$/gi;

/**
 * Aliases for a discovered shortcut.
 *
 * Conservative on purpose: the stem, a version-stripped form, and an
 * acronym only when the name is genuinely multi-word. No fuzzy distance —
 * "open steam" resolving to "Settings" because they share letters would be
 * worse than not resolving at all, since the fallback is an agent that can
 * ask.
 */
export function aliasesFor(displayName: string): readonly string[] {
  const base = displayName.toLowerCase().trim();
  const out = new Set<string>();
  if (base) out.add(base);

  const stripped = base.replace(NOISE_SUFFIX, "").trim();
  if (stripped) out.add(stripped);

  // "Visual Studio Code" → "vsc" is a real thing people say; a two-word name's
  // initials ("File Explorer" → "fe") is not, so require three words.
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length >= 3) {
    out.add(words.map((w) => w[0] ?? "").join(""));
  }
  return [...out].filter(Boolean);
}

/**
 * `.lnk` only.
 *
 * The Start Menu also holds `.url` files, but those are websites — "Steam
 * Support Center", "Visit our forum". Launching one is opening a browser at a
 * remote address, which is a different action from starting an application and
 * should not hide behind "open X". They are skipped rather than filtered by
 * name, since the file extension is the reliable signal and the name is not.
 */
const SHORTCUT = /\.lnk$/i;

/**
 * Build the catalog: built-ins first, then whatever the Start Menu adds.
 *
 * Built-ins win on collision. A shortcut named "Settings" pointing somewhere
 * unexpected should not be able to take over the word "settings" — the ordering
 * is the whole defence there, so it is not an accident of iteration.
 */
export function buildCatalog(options: CatalogOptions = {}): readonly CatalogEntry[] {
  const { startMenuRoots = defaultStartMenuRoots(), readDir, limit = 400 } = options;
  const entries: CatalogEntry[] = [...BUILTINS];
  const taken = new Set(entries.map((e) => e.key));

  if (!readDir) return entries;

  for (const root of startMenuRoots) {
    for (const file of walk(root, readDir)) {
      if (entries.length >= limit) return entries;
      if (!SHORTCUT.test(file)) continue;

      const name = path.basename(file).replace(SHORTCUT, "").trim();
      if (!name || EXCLUDED.test(name)) continue;

      const key = name.toLowerCase();
      if (taken.has(key)) continue;
      taken.add(key);

      entries.push({
        key,
        name,
        // The shortcut itself, handed to the shell. Not its target: see the
        // header — resolving a .lnk means trusting a parsed path from disk.
        launch: { kind: "exec", file: "explorer.exe", args: [file] },
        aliases: aliasesFor(name),
        source: "start-menu",
      });
    }
  }
  return entries;
}

/**
 * Recursive listing, bounded in depth.
 *
 * Start Menu folders are two or three levels deep in practice. The bound is
 * there so a junction loop cannot turn discovery into an infinite walk — this
 * runs at startup, and hanging there would mean Jarvis never comes up.
 */
function walk(dir: string, readDir: ReadDir, depth = 0): readonly string[] {
  if (depth > 4) return [];
  let names: readonly string[];
  try {
    names = readDir(dir);
  } catch {
    // A Start Menu root that does not exist is the normal case on a fresh
    // profile, not a failure worth reporting.
    return [];
  }

  const out: string[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    if (SHORTCUT.test(name)) out.push(full);
    else if (!name.includes(".")) out.push(...walk(full, readDir, depth + 1));
  }
  return out;
}

/** The two roots Windows keeps Start Menu shortcuts in. */
export function defaultStartMenuRoots(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const roots: string[] = [];
  const appData = env["APPDATA"];
  const programData = env["ProgramData"];
  const tail = "Microsoft\\Windows\\Start Menu\\Programs";
  if (appData) roots.push(path.join(appData, tail));
  if (programData) roots.push(path.join(programData, tail));
  return roots;
}

/**
 * The two shapes the rest of the system wants: an alias map for the matcher and
 * a launch map for the executors.
 *
 * They are derived from one list so the two can never disagree about which keys
 * exist — a matcher that resolves a key the executor does not have would
 * produce "I don't know how to open that" after appearing to understand.
 */
export function catalogMaps(entries: readonly CatalogEntry[]): {
  aliases: ReadonlyMap<string, readonly string[]>;
  apps: ReadonlyMap<string, { name: string; launch: LaunchSpec }>;
} {
  const aliases = new Map<string, readonly string[]>();
  const apps = new Map<string, { name: string; launch: LaunchSpec }>();
  for (const e of entries) {
    aliases.set(e.key, e.aliases);
    apps.set(e.key, { name: e.name, launch: e.launch });
  }
  return { aliases, apps };
}
