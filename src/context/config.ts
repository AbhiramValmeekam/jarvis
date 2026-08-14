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
  /**
   * Spoken name → project key, for names that cannot be derived.
   *
   * `aliasesForProject` generates the name, a separator-flattened form, and the
   * leading word. It cannot know that "the work one" means
   * `acme-internal-portal`. This is the user saying so, by hand, which is
   * exactly what this file is for.
   */
  projectAliases?: Readonly<Record<string, string>>;
  /**
   * How much Jarvis may say on its own initiative: `off` / `minimal` / `normal`.
   *
   * Absent means `minimal`, which admits only the categories where silence would
   * leave the user believing something works when it does not — a failed
   * scheduled task, a finished coding job, a question waiting on them. The
   * setting exists because "proactive" is a preference, but the *default* is not
   * a preference: an assistant you have to tell to be quiet has already
   * interrupted you to find that out.
   */
  notifyLevel?: "off" | "minimal" | "normal";
  /**
   * The directory the runtime resolves its relative assets from.
   *
   * Four things are found relative to the process's working directory and
   * nowhere else: the Python venv (`.venv/Scripts/python.exe`) and the voice
   * daemon (`voice/daemon.py`), both in `VoiceSidecar`, and the Piper voice
   * (`models/piper/…`) and Whisper cache (`.research/whisper`) inside
   * `voice/daemon.py` itself. It is also the cwd Hermes' ACP session starts in.
   *
   * Absent means `process.cwd()`, which is right for `npm run runtime` and wrong
   * for every launch a user does not type: Windows starts a Run-key entry in
   * `C:\Windows\system32`, where all four resolve to nothing and Jarvis comes up
   * able to answer typed input and unable to hear its own name. Since the daemon
   * is spawned with this same directory as its cwd, one setting fixes all four —
   * which is why this is a directory and not a list of paths.
   */
  workingDirectory?: string;
  /**
   * Which microphone to listen on, spelled exactly as ffmpeg's dshow backend
   * names it — e.g. `Headset Microphone (Realtek(R) Audio)`. `npm run probe:mic`
   * prints the candidates and the line to paste.
   *
   * Absent means the daemon takes the first device dshow enumerates
   * (`voice/daemon.py`, `Capture.start`), and that is not a choice so much as an
   * accident: enumeration order depends on what Windows initialised in what
   * order, so a headset that was working before a reboot can be replaced by a
   * far-field array that hears nothing. Measured on 2026-08-15, both devices
   * recording the same silent room: the headset idled at a peak RMS of 0.0010 and
   * the array at 0.0001 — digital zero — and the live runtime had landed on the
   * array while ffmpeg was by then enumerating the headset first. Pinning it is
   * the only way to make wake behaviour reproducible across restarts.
   */
  microphone?: string;
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

  // Aliases are spoken words, not paths — so `canonicalise` has nothing to say
  // about them and is deliberately not called. What matters instead is that
  // neither side can carry anything but a plain name: the value resolves against
  // keys the registry already discovered, so a `..\..\windows` on either side of
  // the pair finds no project and does nothing. The length cap is the only real
  // guard, against a config that would otherwise bloat every match attempt.
  if (obj.projectAliases && typeof obj.projectAliases === "object" && !Array.isArray(obj.projectAliases)) {
    const ok: Record<string, string> = {};
    for (const [spoken, key] of Object.entries(obj.projectAliases as Record<string, unknown>)) {
      if (typeof key !== "string") continue;
      const alias = spoken.toLowerCase().trim();
      const target = key.toLowerCase().trim();
      if (!alias || !target || alias.length > 60 || target.length > 60) continue;
      ok[alias] = target;
    }
    if (Object.keys(ok).length > 0) out.projectAliases = ok;
  }

  // An unrecognised value is dropped rather than corrected to a default,
  // matching every clause above. The distinction matters here more than
  // elsewhere: silently reading `"quiet"` as `normal` would make Jarvis louder
  // than a user who typed a wrong word plainly intended.
  if (obj.notifyLevel === "off" || obj.notifyLevel === "minimal" || obj.notifyLevel === "normal") {
    out.notifyLevel = obj.notifyLevel;
  }

  // Same treatment as a project root, and for the same reason: it is a path a
  // human typed into a file, so it goes through `canonicalise` and is dropped
  // rather than repaired if it does not survive. Existence is deliberately not
  // checked here — an external drive that is not mounted yet should leave the
  // setting intact and fail loudly at the point of use, not be silently erased
  // from the config a user is looking at.
  if (typeof obj.workingDirectory === "string") {
    const verdict = canonicalise(obj.workingDirectory);
    if (verdict.ok && verdict.path) out.workingDirectory = verdict.path;
  }

  // A device name, not a path, so `canonicalise` is deliberately not called —
  // `Headset Microphone (Realtek(R) Audio)` is not a filename and has no
  // canonical form. What is checked is what could actually hurt: the value ends
  // up in ffmpeg's `-i audio=<name>` argument. It is passed with `shell: false`
  // so cmd.exe never re-parses it, but a quote would still break dshow's own
  // parsing of the filter string, and a control character would let a config
  // file forge a line in the runtime log that names the device. Both are
  // rejected rather than stripped: a half-corrected device name matches no
  // device, and saying so beats listening to the wrong one.
  if (typeof obj.microphone === "string") {
    const name = obj.microphone.trim();
    // Quote, control character, or a leading dash. The last matters because
    // the value is passed as `--device <name>`, where argparse would read a
    // leading dash as a flag of its own.
    const unsafe =
      name.startsWith("-") ||
      [...name].some((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return ch === '"' || code < 0x20 || (code >= 0x7f && code <= 0x9f);
      });
    if (name && name.length <= 200 && !unsafe) out.microphone = name;
  }

  return out;
}
