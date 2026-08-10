/**
 * What Hermes remembers — read, and only read.
 *
 * There is no write path in this file. Not a disabled one, not one behind a
 * flag: an absent one. That is the enforcement of the boundary described at the
 * top of `memory-store.ts`, and `scripts/probe-memory.ts` checks it from the
 * outside by asserting the files' mtime and size are unchanged after a full
 * Jarvis run — because "we don't call write anywhere" is a claim about code, and
 * the project's rule is that a claim by the actor is not evidence.
 *
 * Format verified against the installed Hermes v0.18.2 rather than its docs:
 * `tools/memory_tool.py:59` defines `ENTRY_DELIMITER = "\n§\n"`, and the two
 * stores live at `%LOCALAPPDATA%\hermes\memories\{MEMORY,USER}.md` with a
 * sibling `.lock` file each. The lock is deliberately a *separate* file so the
 * target can still be `os.replace`d atomically — which is also why reading the
 * target without the lock is safe here: a reader either sees the old file or the
 * new one, never a torn one.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

/** Verified from `tools/memory_tool.py:59`. Splitting on a bare `§` would break entries containing one. */
export const ENTRY_DELIMITER = "\n§\n";

/**
 * Undo Python's text-mode newline translation before splitting.
 *
 * `_write_file` opens the temp file with `os.fdopen(fd, "w", encoding="utf-8")`
 * — *text* mode — so every `\n` Python writes lands on Windows as `\r\n`, and
 * the delimiter on disk is really `\r\n§\r\n`. Python never notices: its
 * `read_text` translates back on the way in, so the round-trip is exact for
 * Hermes and broken for everyone else. Reading the bytes as they are, this file
 * found one entry in a store that holds six — a silent undercount, not an error.
 *
 * Normalising also makes `chars` comparable to `HERMES_LIMITS`, which Hermes
 * measures against the `\n` form (2011 of 2200 here, not 2021).
 *
 * The same translation bit `parseFrontmatter` in `skill-catalog.ts`. Any file
 * this project reads that a Python process wrote deserves the suspicion.
 */
function normaliseNewlines(raw: string): string {
  return raw.replace(/\r\n/g, "\n");
}

/** The two stores Hermes keeps, with the limits it enforces on each. */
export type HermesStore = "memory" | "user";

/** Char limits from `tools/memory_tool.py:130`. Reported, not enforced — Hermes enforces them. */
export const HERMES_LIMITS: Readonly<Record<HermesStore, number>> = {
  memory: 2200,
  user: 1375,
};

export interface HermesMemoryFile {
  store: HermesStore;
  path: string;
  /** False when memory is simply off, which is a normal state and not an error. */
  present: boolean;
  entries: readonly string[];
  chars: number;
  limit: number;
}

/** Where Hermes keeps its memory files. */
export function hermesMemoryDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(base, "hermes", "memories");
}

const FILE_NAMES: Readonly<Record<HermesStore, string>> = {
  memory: "MEMORY.md",
  user: "USER.md",
};

/**
 * Read one of Hermes' stores.
 *
 * A missing file reads as empty rather than as an error: `hermes memory off` is
 * a supported state, and a first-run machine has never written one. An
 * unreadable file reads as empty too — this is a display feature, and failing
 * Jarvis' startup because a file Hermes owns is locked would be the wrong
 * trade.
 */
export function readHermesStore(store: HermesStore, dir = hermesMemoryDir()): HermesMemoryFile {
  const path = join(dir, FILE_NAMES[store]);
  const base = { store, path, limit: HERMES_LIMITS[store] };
  if (!existsSync(path)) return { ...base, present: false, entries: [], chars: 0 };

  try {
    const raw = normaliseNewlines(readFileSync(path, "utf8"));
    const entries = raw
      .split(ENTRY_DELIMITER)
      .map((e) => e.trim())
      .filter(Boolean);
    return { ...base, present: true, entries, chars: raw.length };
  } catch {
    return { ...base, present: false, entries: [], chars: 0 };
  }
}

/** Both stores, for the HUD and for "what does Hermes know about me?". */
export function readHermesMemory(dir = hermesMemoryDir()): readonly HermesMemoryFile[] {
  return [readHermesStore("memory", dir), readHermesStore("user", dir)];
}

/**
 * A fingerprint used to prove Jarvis did not write these files.
 *
 * Size and mtime of every file in the directory, including the `.lock` siblings
 * — a stray lock acquisition would touch one of those and nothing else, which is
 * exactly the kind of accidental write worth catching. Used by the probe on
 * either side of a run and compared; see `scripts/probe-memory.ts`.
 */
export function fingerprintHermesMemory(dir = hermesMemoryDir()): string {
  const parts: string[] = [];
  for (const store of ["memory", "user"] as const) {
    for (const suffix of ["", ".lock"]) {
      const path = join(dir, FILE_NAMES[store] + suffix);
      if (!existsSync(path)) {
        parts.push(`${FILE_NAMES[store]}${suffix}:absent`);
        continue;
      }
      try {
        const s = statSync(path);
        parts.push(`${FILE_NAMES[store]}${suffix}:${s.size}:${s.mtimeMs}`);
      } catch {
        parts.push(`${FILE_NAMES[store]}${suffix}:unreadable`);
      }
    }
  }
  return parts.join("|");
}
