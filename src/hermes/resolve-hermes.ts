/**
 * Resolve the `hermes` executable to a concrete path.
 *
 * Rationale: spawning with `shell: true` on Windows concatenates arguments
 * without escaping (Node DEP0190). We only ever pass a fixed argument, but
 * resolving the real shim path lets us drop the shell entirely, which is both
 * safer and faster.
 *
 * Search order:
 *   1. JARVIS_HERMES_PATH env override
 *   2. Known native-Windows install location (%LOCALAPPDATA%\hermes\...)
 *   3. PATH lookup via `where` / `which`
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

let cached: string | null = null;

function candidateInstallPaths(): string[] {
  const out: string[] = [];
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const base = path.join(localAppData, "hermes", "hermes-agent", "venv", "Scripts");
      out.push(path.join(base, "hermes.exe"));
      out.push(path.join(base, "hermes.cmd"));
      out.push(path.join(base, "hermes-acp.exe"));
    }
  } else {
    const home = process.env.HOME;
    if (home) out.push(path.join(home, ".hermes", "hermes-agent", "venv", "bin", "hermes"));
  }
  return out;
}

function lookupOnPath(): string | null {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const stdout = execFileSync(finder, ["hermes"], {
      encoding: "utf8",
      windowsHide: true,
    });
    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      // Prefer a directly executable image over a shell shim.
      if (process.platform === "win32" && !/\.(exe|cmd|bat)$/i.test(line)) continue;
      if (existsSync(line)) return line;
    }
  } catch {
    /* not found */
  }
  return null;
}

export interface ResolvedHermes {
  /** Absolute path to the executable. */
  path: string;
  /** True when the file must be run through cmd.exe (a .cmd/.bat shim). */
  needsShell: boolean;
}

export function resolveHermesExecutable(override?: string): ResolvedHermes {
  const explicit = override ?? process.env.JARVIS_HERMES_PATH;
  if (explicit) {
    return { path: explicit, needsShell: /\.(cmd|bat)$/i.test(explicit) };
  }
  if (cached) return { path: cached, needsShell: /\.(cmd|bat)$/i.test(cached) };

  for (const candidate of candidateInstallPaths()) {
    if (existsSync(candidate)) {
      cached = candidate;
      return { path: candidate, needsShell: /\.(cmd|bat)$/i.test(candidate) };
    }
  }

  const onPath = lookupOnPath();
  if (onPath) {
    cached = onPath;
    return { path: onPath, needsShell: /\.(cmd|bat)$/i.test(onPath) };
  }

  throw new Error(
    "Could not locate the `hermes` executable. Install Hermes Agent or set JARVIS_HERMES_PATH.",
  );
}

/** Test seam: forget the cached resolution. */
export function clearHermesPathCache(): void {
  cached = null;
}
