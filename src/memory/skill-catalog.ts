/**
 * What Jarvis can actually do, read from the skills on disk.
 *
 * Hermes skills are plain files: `SKILL.md` with YAML frontmatter, under
 * `%LOCALAPPDATA%\hermes\skills` (user) and `<install>/skills` (bundled). 102 of
 * them on this machine. Reading them directly is deliberate, and beats both
 * alternatives:
 *
 * - **Not `hermes serve` + `GET /api/skills`.** That route exists and returns
 *   good data, but standing up the server to list some files means running a
 *   process whose route surface also includes `/api/files/read`,
 *   `/api/fs/write-text` and `/api/credentials/pool`. It is token-gated, so this
 *   is not an open door — it is simply a great deal of machinery, and a great
 *   deal of blast radius, to answer a question the filesystem answers for free.
 * - **Not `hermes skills list`.** Measured at ~3.07 s per invocation (process
 *   startup dominates), and it prints a Rich table that truncates names to
 *   `songwriting-and-ai-mu…`. Unusable as a data source.
 *
 * So: no Hermes process is needed to answer "what can you do?", which also means
 * the answer survives Hermes being down — the same offline property Phase 4
 * established for the rest of the local layer.
 */
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { sanitiseForDisplay } from "../permissions/risk-model.js";

export interface Skill {
  /** From frontmatter when present, else the directory name. */
  name: string;
  /** One line, sanitised. Empty when the skill declares none. */
  description: string;
  /** The directory under the skills root, or "" for a top-level skill. */
  category: string;
  /** Which root it came from. A user skill shadows a bundled one of the same name. */
  source: "user" | "bundled";
}

/** `%LOCALAPPDATA%\hermes\skills` — the user's own, including hub installs. */
export function userSkillsDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(base, "hermes", "skills");
}

/** The skills shipped inside the Hermes install. */
export function bundledSkillsDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(base, "hermes", "hermes-agent", "skills");
}

/**
 * Directories that never contain a live skill.
 *
 * Mirrors Hermes' own `EXCLUDED_SKILL_DIRS` (`agent/skill_utils.py:27`) rather
 * than inventing a second list, so Jarvis' idea of "installed" matches the
 * agent's. Drifting from it would mean Jarvis advertising a capability Hermes
 * will not load.
 */
const EXCLUDED = new Set([
  ".git", ".github", ".hub", ".archive", ".venv", "venv", "node_modules",
  "site-packages", "__pycache__", ".tox", ".nox", ".pytest_cache",
  ".mypy_cache", ".ruff_cache",
]);

/**
 * Support directories *inside* a skill.
 *
 * From `SKILL_SUPPORT_DIRS` (`agent/skill_utils.py:50`). A preserved package at
 * `some-skill/references/old-package/SKILL.md` is documentation, not a second
 * installed skill, and listing it would inflate the count with things that
 * cannot run. Only pruned when the parent is itself a skill root — Hermes makes
 * the same distinction, so a legitimate category named `scripts` still works.
 */
const SUPPORT_DIRS = new Set(["references", "templates", "assets", "scripts"]);

/** How deep to walk. Measured layout here is 1–3 levels; 4 leaves headroom. */
const MAX_DEPTH = 4;

/**
 * Find every skill under a root.
 *
 * Recursive with pruning rather than a fixed `category/name` glob, because the
 * real layout is not uniform: `computer-use` sits at the top level, most skills
 * sit at `category/name`, and six live at `mlops/evaluation/name`. A two-level
 * glob would silently under-report by nine.
 */
function scanRoot(root: string, source: Skill["source"]): Skill[] {
  if (!existsSync(root)) return [];
  const found: Skill[] = [];

  /** `rel` is the path from the root to `dir`, "" at the root itself. */
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;

    let entries: readonly string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return; // An unreadable directory is skipped, never fatal.
    }

    const isSkillRoot = existsSync(join(dir, "SKILL.md"));
    if (isSkillRoot) {
      // The category is where the skill *sits*, which is `rel` minus the
      // skill's own directory name. Including it — as a first version of this
      // did — gives every skill a category of one, so `mlops/inference/vllm`
      // reported the category `mlops/inference/vllm` and the summary degenerated
      // to 102 categories of size 1.
      const parts = rel.split("/").filter(Boolean);
      const skill = readSkill(dir, parts.slice(0, -1).join("/"), source);
      if (skill) found.push(skill);
    }

    for (const name of entries) {
      if (EXCLUDED.has(name)) continue;
      // Only prune a support dir when its parent is a skill; a category may
      // legitimately be called `scripts`.
      if (isSkillRoot && SUPPORT_DIRS.has(name)) continue;
      walk(join(dir, name), rel ? `${rel}/${name}` : name, depth + 1);
    }
  };

  walk(root, "", 0);
  return found;
}

/**
 * Parse the two frontmatter fields worth having.
 *
 * Hand-parsed rather than pulling in a YAML dependency: this repo has no runtime
 * dependencies beyond React, and adding a parser to read two scalars from files
 * we already treat as untrusted is a poor trade. Only `name` and `description`
 * are read, and anything unparseable is skipped rather than guessed at.
 */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  // Normalise line endings *first*. These files are CRLF on Windows, and the
  // closing `\n---` leaves a stray `\r` on the block's final line — which JS
  // `.` does not match, since it excludes `\r` along with `\n`. So
  // `/^description\s*:\s*(.*)$/` silently failed on whichever field came last,
  // costing 15 of the 102 skills their description. Splitting on `/\r?\n/`
  // looks like it handles this and does not: it strips the separators between
  // lines, never a trailing one before the slice boundary.
  const src = text.replace(/\r\n/g, "\n");
  if (!src.startsWith("---")) return {};
  const end = src.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = src.slice(3, end);
  const lines = block.split("\n");

  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = /^(name|description)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as "name" | "description";
    let value = (m[2] ?? "").trim();

    // Folded and literal blocks. Two of the 102 skills installed here use them
    // — `computer-use` has `description: |` and `mlops/ml-model-porting` has
    // `description: >` — and a reader that took the marker as the value would
    // render "|" as the description. Gather the indented continuation instead.
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const cont = lines[j] ?? "";
        if (cont.trim() === "") { parts.push(""); continue; }
        if (!/^\s/.test(cont)) break; // dedented: the block ended
        parts.push(cont.trim());
      }
      value = parts.join(" ").trim();
    } else {
      // Strip one layer of matching quotes; 66 of the 102 descriptions here are
      // double-quoted.
      const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
      if (quoted) value = quoted[2] ?? value;
    }

    if (value) out[key] = value;
  }
  return out;
}

/** Read one skill directory, or null if it has nothing usable. */
function readSkill(dir: string, category: string, source: Skill["source"]): Skill | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }

  const fm = parseFrontmatter(raw);
  const name = (fm.name ?? basename(dir)).trim();
  if (!name) return null;

  // Descriptions are untrusted content (§52): these are files on disk that
  // `hermes skills install` can add from a registry, so a description is
  // attacker-influenceable text that Jarvis will read aloud and may put in a
  // prompt. `sanitiseForDisplay` strips control characters and the zero-width /
  // bidi range that lets text render differently from what it says.
  return {
    name: sanitiseForDisplay(name, 60),
    description: fm.description ? sanitiseForDisplay(fm.description, 200) : "",
    category,
    source,
  };
}

/**
 * Every skill available, user roots shadowing bundled ones by name.
 *
 * Shadowing matches Hermes' own resolution: a user copy of a bundled skill is
 * the one that loads, so listing both would advertise a version that never runs.
 */
export function loadSkills(
  userDir = userSkillsDir(),
  bundledDir = bundledSkillsDir(),
): readonly Skill[] {
  const byName = new Map<string, Skill>();
  for (const skill of scanRoot(bundledDir, "bundled")) byName.set(skill.name, skill);
  for (const skill of scanRoot(userDir, "user")) byName.set(skill.name, skill);
  return [...byName.values()].sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );
}

/** Categories with their counts — how "what can you do?" gets answered out loud. */
export function summariseSkills(skills: readonly Skill[]): readonly { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of skills) {
    const key = s.category || "general";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}
