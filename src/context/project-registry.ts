/**
 * The projects "my jarvis project" is allowed to mean.
 *
 * Same boundary as the app catalog, for the same reason: a spoken name resolves
 * to a *key* in a list Jarvis already discovered, and never to a path assembled
 * from what someone said near a microphone. "Open my invoices project" for a
 * project that is not here reaches the agent, which has to ask.
 *
 * **Discovery does not go looking.** The user names the roots; this scans them
 * one level down by default, two at most. An assistant that crawls every drive
 * hunting for source control is doing something nobody asked for, and it is also
 * how a scan ends up reading a `.env`. Nothing here opens a file — a project is
 * recognised by the *presence* of a marker directory or file, by name only, and
 * the contents of those markers are never read.
 *
 * What a project is, concretely: a directory containing something from
 * `MARKERS`. That is deliberately a low bar — being wrong here costs a name in a
 * list, and the alternative (parsing manifests to confirm) means reading files
 * from disk to decide what to trust, which §52 says is backwards.
 *
 * Paths in this file are text until `checkPath` says otherwise. Resolution
 * happens in the caller, against the roots the user configured, so a marker
 * directory named `..` cannot walk anywhere.
 */
import { win32 as path } from "node:path";
import { sanitiseForDisplay } from "../permissions/risk-model.js";

/** How the project was recognised, which is also roughly what it is. */
export type ProjectKind = "git" | "node" | "python" | "rust" | "go" | "dotnet";

export interface ProjectEntry {
  /** Canonical key: the lowercased directory name, what the matcher resolves to. */
  key: string;
  /** Directory name as it is on disk, spoken back in "Opening ___." */
  name: string;
  /** Absolute path. Verified by the caller against the configured roots. */
  dir: string;
  kind: ProjectKind;
  /** Everything a person might say for this project, lowercased. */
  aliases: readonly string[];
  /** Which configured root it was found under, for the UI and for diagnostics. */
  root: string;
}

/** Directory entry, injected so this module does no I/O of its own. */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
}
export type ReadDirEntries = (dir: string) => readonly DirEntry[];

export interface RegistryOptions {
  /** Roots the user nominated. No default: not scanning is the safe failure. */
  roots?: readonly string[];
  readDir?: ReadDirEntries;
  /** How far below a root to look. 1 = the root's immediate children. */
  depth?: number;
  /** Cap on discovered projects, so a pathological tree cannot exhaust memory. */
  limit?: number;
  /**
   * Extra spoken names, from the user's config: alias → project key.
   *
   * `aliasesForProject` generates what can be derived from a directory name, and
   * that is all it can ever do. It cannot know that "the work one" means
   * `acme-internal-portal`, because nothing in the name says so. This is where
   * the user says it.
   *
   * Merged into the same alias list rather than consulted separately, so a
   * user alias that collides with a generated one still produces `ambiguous`
   * and Jarvis asks. An alias naming a project that was not discovered is
   * dropped — it would otherwise be a name that matches nothing and reports
   * a local failure instead of reaching the agent.
   */
  aliases?: Readonly<Record<string, string>>;
}

/**
 * Markers, most specific first.
 *
 * Order decides `kind` when a directory has several — and most real projects
 * do. A Node repo under git is more usefully "node" than "git", so version
 * control comes last despite being the strongest signal that this is a project
 * at all.
 *
 * `.NET` is matched by extension rather than filename, because a solution is
 * `Whatever.sln` and there is no fixed name to look for. It is the only entry
 * that needs a predicate, so the predicate is the general form and the
 * filename cases are expressed through it.
 */
const MARKERS: readonly { kind: ProjectKind; has: (names: ReadonlySet<string>) => boolean }[] = [
  { kind: "node", has: (n) => n.has("package.json") },
  { kind: "python", has: (n) => n.has("pyproject.toml") || n.has("requirements.txt") },
  { kind: "rust", has: (n) => n.has("cargo.toml") },
  { kind: "go", has: (n) => n.has("go.mod") },
  { kind: "dotnet", has: (n) => [...n].some((f) => f.endsWith(".sln") || f.endsWith(".csproj")) },
  { kind: "git", has: (n) => n.has(".git") },
];

/**
 * Directories that are never a project, however many markers they contain.
 *
 * `node_modules` is the one that matters: every dependency in it has a
 * `package.json`, so without this a single Node repo contributes hundreds of
 * "projects" and the real one is lost among them.
 */
const SKIP = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "out",
  "build",
  "target",
  "vendor",
  ".next",
  ".cache",
  "site-packages",
]);

/**
 * Aliases for a project directory.
 *
 * Conservative, like the app catalog's: the name, a separator-flattened form,
 * and the significant words. No fuzzy distance — "open my invoice project"
 * resolving to `invoices-archive-2019` would be worse than not resolving, since
 * the fallback is an agent that can ask which one.
 */
export function aliasesForProject(name: string): readonly string[] {
  const base = name.toLowerCase().trim();
  const out = new Set<string>();
  if (base) out.add(base);

  // `my-jarvis-app` → `my jarvis app`, because that is how it is said out loud.
  const spaced = base.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
  if (spaced) out.add(spaced);

  // The leading word, because project names are overwhelmingly
  // `<identity>-<qualifier>`: jarvis-runtime, invoices-2026, client-portal. The
  // first token is the part that identifies the thing and the part people
  // actually say. Only the first — adding "runtime" and "portal" too would make
  // half the registry ambiguous on words that name a role rather than a project.
  //
  // Collisions are safe by construction: two projects sharing a leading word
  // both match, `findProject` returns `ambiguous`, and Jarvis asks. That is why
  // this can afford to be generous where fuzzy matching could not.
  const words = spaced.split(" ").filter(Boolean);
  const lead = words.find((w) => !GENERIC.has(w) && w.length > 2);
  if (lead) out.add(lead);

  return [...out].filter(Boolean);
}

/**
 * Words that carry no identity in a project name.
 *
 * Deliberately short. An earlier version also filtered `client`, `api`,
 * `server` and `web` — and then `client-portal` had no lead word at all, so
 * "open client" found nothing. Those words *are* identities in the names people
 * actually use. Since a collision now resolves by asking rather than by
 * guessing, the cost of being generous is a question and the cost of being
 * strict is a project you cannot open by name. Only determiners and pure
 * scaffolding are listed.
 */
const GENERIC = new Set([
  "my", "the", "a", "an", "app", "application", "project", "repo", "repository",
  "src", "code", "test", "tests", "demo", "new", "old", "temp", "tmp",
  "v1", "v2", "main", "master", "dev", "prod",
]);

/**
 * Build the registry from the roots the user nominated.
 *
 * A root that does not exist is skipped, not an error: a config listing
 * `D:\work` on a machine with no D: drive is a stale line in a settings file,
 * and refusing to build a registry over it would take the working roots down
 * with it.
 */
export function buildRegistry(options: RegistryOptions = {}): readonly ProjectEntry[] {
  const { roots = [], readDir, depth = 1, limit = 200, aliases } = options;
  if (!readDir || roots.length === 0) return [];

  const entries: ProjectEntry[] = [];
  const taken = new Set<string>();
  const bounded = Math.max(1, Math.min(depth, 2));

  for (const root of roots) {
    scan(root, root, bounded, readDir, entries, taken, limit);
    if (entries.length >= limit) break;
  }
  return aliases ? withUserAliases(entries, aliases) : entries;
}

/**
 * Fold the user's own names into the discovered projects.
 *
 * An alias pointing at a key that was not discovered is dropped rather than
 * creating a phantom entry: the project may simply not be on this machine, and
 * "open the work one" should reach an agent that can look for it rather than
 * resolving to a directory that is not there.
 */
function withUserAliases(
  entries: readonly ProjectEntry[],
  aliases: Readonly<Record<string, string>>,
): readonly ProjectEntry[] {
  const extra = new Map<string, string[]>();
  for (const [spoken, key] of Object.entries(aliases)) {
    const alias = spoken.toLowerCase().trim();
    const target = key.toLowerCase().trim();
    if (!alias || !target) continue;
    const list = extra.get(target) ?? [];
    list.push(alias);
    extra.set(target, list);
  }
  if (extra.size === 0) return entries;

  return entries.map((e) => {
    const added = extra.get(e.key);
    if (!added) return e;
    return { ...e, aliases: [...new Set([...e.aliases, ...added])] };
  });
}

function scan(
  dir: string,
  root: string,
  depth: number,
  readDir: ReadDirEntries,
  out: ProjectEntry[],
  taken: Set<string>,
  limit: number,
): void {
  if (depth < 0 || out.length >= limit) return;

  let names: readonly DirEntry[];
  try {
    names = readDir(dir);
  } catch {
    // Unreadable or absent. Normal for a stale configured root, and for a
    // directory the user's account cannot open.
    return;
  }

  const present = new Set(names.map((e) => e.name.toLowerCase()));
  const kind = kindOf(present);

  // A project is a leaf. Descending into one would find its subpackages and
  // offer `src` as a project the user could open, which is noise rather than
  // help — and it is the second half of the `node_modules` problem.
  //
  // This applies to a root too. Nominating `E:\jarvis` — a repo — is a
  // reasonable thing for someone with one project to do, and the earlier
  // version of this skipped the root itself and then found nothing under it,
  // which is the worst shape of failure: a configured root and an empty list.
  if (kind) {
    add(out, taken, dir, root, kind, limit);
    return;
  }

  for (const entry of names) {
    if (out.length >= limit) return;
    if (!entry.isDirectory) continue;
    const lower = entry.name.toLowerCase();
    if (SKIP.has(lower) || lower.startsWith(".")) continue;
    scan(path.join(dir, entry.name), root, depth - 1, readDir, out, taken, limit);
  }
}

/** First marker present wins, so `MARKERS` order is the `kind` precedence. */
function kindOf(present: ReadonlySet<string>): ProjectKind | null {
  for (const m of MARKERS) {
    if (m.has(present)) return m.kind;
  }
  return null;
}

function add(
  out: ProjectEntry[],
  taken: Set<string>,
  dir: string,
  root: string,
  kind: ProjectKind,
  limit: number,
): void {
  if (out.length >= limit) return;

  // A directory name comes from disk, so it is untrusted text (§52) that will
  // be spoken and rendered. Sanitised at the boundary rather than at each use.
  const name = sanitiseForDisplay(path.basename(dir), 60);
  if (!name) return;

  const key = name.toLowerCase();
  // First wins, and roots are scanned in the order the user listed them — so a
  // duplicate name resolves to the root they put first, which is the only
  // ordering a person could predict.
  if (taken.has(key)) return;
  taken.add(key);

  out.push({ key, name, dir, kind, aliases: aliasesForProject(name), root });
}

/**
 * Resolve a spoken name to exactly one project.
 *
 * Three outcomes, not two. `ambiguous` exists because two projects called
 * `client` under different roots is a normal thing to have, and picking one
 * silently would open the wrong directory — the same reasoning as bare "mute"
 * in the intent model: asking is cheap, being wrong is not.
 */
export type ProjectLookup =
  | { kind: "one"; project: ProjectEntry }
  | { kind: "ambiguous"; candidates: readonly ProjectEntry[] }
  | { kind: "none" };

export function findProject(
  spoken: string,
  entries: readonly ProjectEntry[],
): ProjectLookup {
  const want = spoken.toLowerCase().replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
  if (!want) return { kind: "none" };

  const hits = entries.filter(
    (e) => e.key === want || e.aliases.includes(want),
  );
  if (hits.length === 1 && hits[0]) return { kind: "one", project: hits[0] };
  if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
  return { kind: "none" };
}

/** One line about a project, for a spoken reply. Carries no path (§53). */
export function describeProject(p: ProjectEntry): string {
  return `${p.name} (${p.kind})`;
}

/**
 * The alias map the matcher wants.
 *
 * Derived from the same list the executor resolves against, for the reason the
 * app catalog gives: a matcher that recognises a name the executor cannot find
 * produces "I don't know that one" *after* appearing to understand, which is
 * the most confusing failure available.
 */
export function projectAliases(
  entries: readonly ProjectEntry[],
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const e of entries) map.set(e.key, e.aliases);
  return map;
}
