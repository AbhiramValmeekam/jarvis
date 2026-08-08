/**
 * Per-run IPC authentication token.
 *
 * Why this exists: a Windows named pipe created with default ACLs is reachable
 * by any process running as the same user. That is a low bar for something that
 * can launch applications and drive an autonomous agent, so knowing the pipe
 * name must not be sufficient — a client also has to read a token from a file
 * only this user can open.
 *
 * Handling rules (SECURITY_MODEL.md §3):
 *   - regenerated on every runtime start; never reused across runs
 *   - written to a file with owner-only permissions, never to a log
 *   - compared in constant time, so a wrong guess leaks nothing by timing
 *   - never included in status payloads, events, or error text
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const TOKEN_BYTES = 32;

/** Where runtime-private state lives. Kept out of the repo and out of sync dirs. */
export function runtimeStateDir(): string {
  const base =
    process.env.LOCALAPPDATA ??
    process.env.XDG_STATE_HOME ??
    join(homedir(), ".local", "state");
  return join(base, "Jarvis");
}

export function tokenFilePath(): string {
  return join(runtimeStateDir(), "runtime-token");
}

/** Generate a token in memory. Nothing is written to disk. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Publish a token so local clients can authenticate.
 *
 * Split from generation on purpose: the runtime must not touch the shared token
 * file until it knows it actually owns the pipe. A second instance that fails
 * the single-instance check would otherwise delete the *running* instance's
 * token and lock every UI out of it.
 */
export function publishToken(token: string, path = tokenFilePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  // mode 0o600: owner read/write only. Honoured on POSIX; on Windows the file
  // inherits the user-profile ACL, which already excludes other users.
  writeFileSync(path, token, { encoding: "utf8", mode: 0o600 });
}

/** Create a fresh token and persist it owner-only. Returns the token. */
export function issueToken(path = tokenFilePath()): string {
  const token = generateToken();
  publishToken(token, path);
  return token;
}

/** Read the token a running runtime published. Returns null when absent. */
export function readToken(path = tokenFilePath()): string | null {
  try {
    if (!existsSync(path)) return null;
    const t = readFileSync(path, "utf8").trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Remove the token file on shutdown so a stale token cannot be replayed. */
export function revokeToken(path = tokenFilePath()): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best effort — a leftover token is useless once the pipe is gone */
  }
}

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak length,
 * so lengths are checked first and the result folded into a comparison that
 * always runs over equal-length buffers.
 */
export function tokensMatch(expected: string, provided: unknown): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) {
    // Still burn a comparison of the same size to keep timing flat.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
