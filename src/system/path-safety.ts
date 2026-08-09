/**
 * Deciding whether a path is one Jarvis is allowed to touch.
 *
 * Every path that reaches this module is untrusted (§52): it may have come from
 * a transcript, a model, a web page, or a document. The threat is not only
 * `../../../Windows/System32` — Win32 offers a long list of ways to write one
 * path and mean another, and a check that compares strings naively is defeated
 * by all of them:
 *
 *   - `C:\Users\me\..\other`         — traversal, the obvious one
 *   - `C:\Users\ME\Docs`             — case, since NTFS compares case-insensitively
 *   - `C:\Users\me\secret.txt.`      — Win32 silently strips trailing dots/spaces
 *   - `C:\Users\me\notes.txt:hidden` — alternate data stream on an allowed file
 *   - `\\?\C:\Users\me`              — the device namespace bypasses normalisation
 *   - `\\.\PhysicalDrive0`           — raw device, not a file at all
 *   - `NUL`, `COM1`                  — reserved names that resolve to devices
 *   - `C:\PROGRA~1`                  — 8.3 aliases for a longer real name
 *   - `\\server\share\x`             — UNC, which is not under any local root
 *
 * So this canonicalises to one comparable form and rejects the shapes that
 * cannot be safely canonicalised at all, rather than trying to repair them.
 *
 * **What this cannot do.** Containment here is lexical. A junction or symlink
 * *inside* an allowed root can still point outside it, and no amount of string
 * work will reveal that — it takes a filesystem call. Callers that are about to
 * write must therefore resolve the real path first and re-check it; see
 * `assertContained`, which is the hook for exactly that.
 */
// win32 explicitly, not the platform default. These are Windows rules being
// enforced, and on a POSIX host the default `path` would read "C:\Users" as one
// relative filename — every check below would still pass while meaning nothing.
import { win32 as path } from "node:path";

const { isAbsolute, normalize, parse, resolve, sep } = path;

export interface PathVerdict {
  ok: boolean;
  /** Canonical form, present only when `ok`. Compare and store this, not the input. */
  path?: string;
  /** Why it was refused, safe to log and to show the user. */
  reason?: string;
}

/**
 * Names Win32 resolves to devices no matter which directory they appear in, so
 * `C:\Users\me\NUL` is not a file. Extensions do not help: `NUL.txt` is still
 * the device.
 */
const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Characters Win32 forbids in a filename. Control characters included. */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>"|?*\u0000-\u001f]/;

/**
 * Canonicalise a path for comparison, or refuse it.
 *
 * Refusal is deliberately preferred over cleaning: a caller that asked to write
 * to `notes.txt:stream` should be told no, not quietly redirected to
 * `notes.txt`, which is a different file than the one it named.
 */
export function canonicalise(input: string): PathVerdict {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, reason: "empty path" };
  }
  // Embedded NULs truncate the path inside Win32 while looking harmless in JS.
  if (input.includes("\u0000")) return { ok: false, reason: "path contains a NUL byte" };

  const raw = input.replace(/\//g, sep);

  // The device namespace opts out of the normalisation everything else relies
  // on, which makes it unanalysable here rather than merely unusual.
  if (/^\\\\[.?]\\/.test(raw)) {
    return { ok: false, reason: "device-namespace paths are not allowed" };
  }
  // UNC cannot be under a local allow-listed root, and treating it as relative
  // would be worse than refusing.
  if (raw.startsWith("\\\\")) return { ok: false, reason: "network paths are not allowed" };

  if (ILLEGAL.test(raw.replace(/^[a-zA-Z]:/, ""))) {
    return { ok: false, reason: "path contains characters Windows does not allow" };
  }
  if (!isAbsolute(raw)) return { ok: false, reason: "path must be absolute" };

  const norm = normalize(resolve(raw));

  // Walk the components rather than the whole string: a reserved name or a
  // stream marker anywhere in the path poisons it, not just at the end.
  const { root } = parse(norm);
  const rest = norm.slice(root.length);
  for (const part of rest.split(sep)) {
    if (!part) continue;
    if (part.includes(":")) {
      return { ok: false, reason: "alternate data streams are not allowed" };
    }
    if (part !== part.replace(/[. ]+$/, "")) {
      // Win32 strips these, so the path the user typed is not the path that
      // would be opened. Refuse rather than resolve the discrepancy silently.
      return { ok: false, reason: "path component ends with a dot or space" };
    }
    const stem = part.split(".")[0]?.toLowerCase() ?? "";
    if (RESERVED.has(stem)) {
      return { ok: false, reason: `"${part}" is a reserved Windows device name` };
    }
    if (part.includes("~") && /~\d/.test(part)) {
      // An 8.3 alias for a name we cannot see. It may well be legitimate; it is
      // also the standard way to write an allow-listed root as something else.
      return { ok: false, reason: "short (8.3) path components are not allowed" };
    }
  }

  return { ok: true, path: norm };
}

/** Case-insensitive, separator-aware containment. NTFS compares this way. */
function within(child: string, parent: string): boolean {
  const c = child.toLowerCase();
  const p = parent.toLowerCase().replace(new RegExp(`\\${sep}+$`), "");
  // The separator check is what stops `C:\Usersecret` passing for `C:\Users`.
  return c === p || c.startsWith(p + sep);
}

/**
 * Canonicalise, then require the result to sit under one of `roots`.
 *
 * An empty allow-list denies everything. That is the intended reading of "no
 * roots configured": a misconfiguration should stop Jarvis touching the disk,
 * not let it touch all of it.
 */
export function checkPath(input: string, roots: readonly string[]): PathVerdict {
  const verdict = canonicalise(input);
  if (!verdict.ok || !verdict.path) return verdict;

  if (roots.length === 0) return { ok: false, reason: "no allowed directories are configured" };

  for (const root of roots) {
    const r = canonicalise(root);
    if (!r.ok || !r.path) continue;
    if (within(verdict.path, r.path)) return { ok: true, path: verdict.path };
  }
  return { ok: false, reason: "path is outside the allowed directories" };
}

/**
 * Throwing form, for call sites that are about to act.
 *
 * `realpath` is the caller's own filesystem resolver, passed in so this module
 * stays free of I/O and so tests can drive it. Supplying it closes the junction
 * hole described at the top: the resolved target is re-checked against the same
 * allow-list, so a link inside an allowed root that points outside it is caught.
 * Omitting it leaves the check lexical, which is honest but weaker.
 */
export function assertContained(
  input: string,
  roots: readonly string[],
  realpath?: (p: string) => string,
): string {
  const verdict = checkPath(input, roots);
  if (!verdict.ok || !verdict.path) {
    throw new Error(`refusing to use "${input}": ${verdict.reason ?? "not allowed"}`);
  }
  if (!realpath) return verdict.path;

  let real: string;
  try {
    real = realpath(verdict.path);
  } catch {
    // Nothing there yet — creating a new file is normal, and the lexical check
    // already passed for the path itself.
    return verdict.path;
  }
  const resolved = checkPath(real, roots);
  if (!resolved.ok || !resolved.path) {
    throw new Error(`refusing to use "${input}": it resolves outside the allowed directories`);
  }
  return resolved.path;
}
