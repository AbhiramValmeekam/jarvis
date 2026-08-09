/**
 * Configuration: the parts a user can write down.
 *
 * No JSON validator, no defaults sprawl. This reads what matters from a file
 * the user can edit without opening code, and skips anything it does not
 * understand. An unknown key is the shape every future addition takes, so
 * refusing one would mean a newer Jarvis can produce a config an older build
 * cannot read — forwards compatibility is free here and strict validation costs
 * it, so strict validation does not happen.
 *
 * **The file is not the runtime state.** Options like `pipeName` and restart
 * policy are programmatic and are never written here; this is purely the
 * decisions a person makes by hand. Config is read once at boot.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { canonicalise } from "../system/path-safety.js";

/** Where Jarvis looks for a user's config file. */
export function configFilePath(): string {
  const base =
    process.env.LOCALAPPDATA ??
    process.env.XDG_CONFIG_HOME ??
    join(homedir(), ".config");
  return join(base, "Jarvis", "config.json");
}

export interface JarvisConfig {
  /** Roots the project registry scans. No default: scanning must be opted into. */
  projectRoots?: readonly string[];
}

/**
 * Read the config file, or return defaults if one does not exist.
 *
 * Errors are swallowed rather than thrown. A missing file is normal — first run
 * has no config to load — and a malformed one should not stop Jarvis coming up,
 * it should just leave the user with factory settings and a log line saying why.
 */
export function loadConfig(path = configFilePath(), onError?: (msg: string) => void): JarvisConfig {
  const file = path;
  if (!existsSync(file)) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    const msg = `ignoring malformed config at ${file}: ${err}`;
    if (onError) onError(msg);
    return {};
  }
  if (!raw || typeof raw !== "object") return {};

  const obj = raw as Record<string, unknown>;
  const out: JarvisConfig = {};

  // Project roots are the one thing here right now. When there are more, each
  // gets its own clause — validate, canonicalise, drop the ones that fail, and
  // keep going. The whole read never throws, it just returns a subset of what
  // the file asked for.
  if (Array.isArray(obj.projectRoots)) {
    const ok: string[] = [];
    for (const item of obj.projectRoots) {
      if (typeof item !== "string") continue;
      const verdict = canonicalise(item);
      if (verdict.ok && verdict.path) ok.push(verdict.path);
    }
    if (ok.length > 0) out.projectRoots = ok;
  }

  return out;
}
