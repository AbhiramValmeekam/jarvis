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
import { isRiskCategory } from "../permissions/risk-model.js";

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
  /**
   * Input make-up gain: `"auto"` (the default) or a fixed multiplier.
   *
   * The daemon needs a speaking voice to arrive somewhere near a peak frame RMS
   * of 0.08, because below roughly 0.01 the VAD's verdict starts depending on
   * what it heard a moment ago rather than on what was said — see the gain
   * section of `voice/daemon.py`. `auto` measures the voice and makes up the
   * difference. A number is for someone who has run `npm run probe:mic`, knows
   * their own device, and would rather state the answer than have it inferred.
   */
  micGain?: number | "auto";
  /**
   * Whisper model for transcription. `base.en` by default; `small.en` is
   * noticeably more accurate for roughly twice the time per utterance, and is
   * the first thing to try if transcripts are close but wrong.
   *
   * Restricted to the models faster-whisper ships names for. A typo here would
   * otherwise be handed to it as a repository to go and download.
   */
  sttModel?: string;
  /** Whisper beam width, 1–10. Higher is more accurate and slower; 5 default. */
  sttBeam?: number;
  /**
   * Acoustic wake sensitivity, 0–1. Default 0.5.
   *
   * Raise it if something in the room keeps waking Jarvis; lower it if a clearly
   * spoken name does not. Prefer `wakeSoftThreshold` for the second case: it
   * costs a transcript rather than a false positive.
   */
  wakeThreshold?: number;
  /**
   * The score band below `wakeThreshold` that is checked against the transcript
   * instead of trusted outright, 0–1. Default 0.25; 0 disables it.
   *
   * A sloppy "javis" scores ~0.23 on the wake model — real, but not confident
   * enough to act on. In this band the daemon records provisionally, transcribes,
   * and only announces a wake if the name is actually in the text. That is what
   * makes a quietly spoken "jarvis" work without lowering the bar for everything
   * that merely rhymes with it.
   */
  wakeSoftThreshold?: number;
  /**
   * Extra spellings of the name to accept in a transcript, one phrase each —
   * e.g. `["hey jarv"]`. At most three words per phrase.
   *
   * "jarvis", "hey jarvis" and the misspellings whisper produces for them are
   * built in and need no entry here. This is for a nickname.
   */
  wakeAliases?: readonly string[];
  /**
   * The directories a mission's steps may act inside. No default, and absence is
   * not "anywhere": the tool adapters fall back to the project roots, so a user
   * who has opted into nothing has opted a mission into nothing either.
   *
   * This is narrower than `projectRoots` on purpose. Scanning a directory to
   * *know* a project is there costs a read; letting an autonomous loop write in
   * it is a different decision, and a person who wants the second one should have
   * to write it down separately from the first.
   */
  missionRoots?: readonly string[];
  /**
   * How many step executions one mission may spend, 1–200. Default 24.
   *
   * Executions, not plan length — a retry spends one. It is the ceiling that ends
   * a mission that is making no progress, so it is deliberately a number a user
   * can lower rather than an internal constant.
   */
  maxMissionSteps?: number;
  /**
   * What a mission may do on its own, per risk class: `auto` runs it, `approval`
   * asks first, `deny` refuses it outright and the step fails with that as its
   * reason.
   *
   * Keys are the classes `classify()` assigns — `read`, `write`, `move`,
   * `delete`, `execute`, `network`, `credential`, `security-control`, `unknown` —
   * and not tool names, because the class is computed from the call and a tool
   * name is only what something called itself. An unknown key is dropped.
   *
   * Absent means the permission engine's own reading of the level, which already
   * asks at 2 and above. This is for tightening that per class: `{"execute":
   * "approval"}` from a user who wants to see every command, `{"delete": "deny"}`
   * from one who wants missions never to remove anything at all.
   */
  missionPolicy?: Readonly<Record<string, "auto" | "approval" | "deny">>;
  /**
   * Which model plans missions: `auto`, `anthropic`, `openai-compatible`,
   * `hermes`, or `offline`. Default `auto`.
   *
   * `auto` picks by what is actually configured — an Anthropic key, then an
   * OpenAI-compatible server, then the supervised agent if it is up — and lands on
   * `offline` when none of those is true. `offline` is not a broken state: the
   * deterministic planner is a real planner, the mission says `planner:
   * "deterministic"` on the wire, and nothing pretends a model was consulted (§32).
   *
   * There is deliberately no key here. Keys live in the process environment or in
   * `.env`; this file sits in `%APPDATA%` next to things the UI can be pointed at,
   * and a secret in it would be a secret in every backup of it.
   */
  llmProvider?: "auto" | "anthropic" | "openai-compatible" | "hermes" | "offline";
  /**
   * The model name to ask for. Default `claude-opus-5` for Anthropic.
   *
   * Not validated against a list: model names change faster than this file ships,
   * and an allowlist here would mean a new model could not be used until Jarvis was
   * rebuilt. A name the provider does not know comes back as its own 404, which is
   * a clearer answer than a silent substitution.
   */
  llmModel?: string;
  /**
   * Base URL for an OpenAI-compatible server or an Anthropic-shaped gateway.
   *
   * `http://127.0.0.1:8080/v1` for a local llama.cpp. Setting this is also what
   * makes `auto` willing to try an OpenAI-compatible server with no key at all:
   * without it, a keyless Jarvis would have a provider pointed at a port nobody is
   * listening on, reporting itself available and failing every mission.
   */
  llmBaseUrl?: string;
  /**
   * Whether the model is allowed to plan. Default true when a provider resolves.
   *
   * Separate from `llmProvider` because they answer different questions: that one
   * is "is there a model", this one is "should it decide what runs". A user who
   * wants the model for diagnosis but the table for planning sets this false, and
   * a user who wants to compare the two flips it without editing their `.env`.
   */
  llmPlanner?: boolean;
  /**
   * Milliseconds one model call may take, 1000–600000. Default 60000.
   *
   * A plan is one round trip at the start of a mission, so this is generous by the
   * standards of everything else in this file — but it is bounded, because an
   * always-on process cannot afford a request that never returns.
   */
  llmTimeoutMs?: number;
  /**
   * Whether the OpenAI-compatible endpoint can be shown an image. Default false.
   *
   * Only read for that provider, because it is the only one where the answer is
   * unknowable: `llmBaseUrl` may be a text-only llama.cpp or a vision model behind a
   * gateway, and both serve the same `/v1/models`. Anthropic answers yes on its own
   * and Hermes answers no on its own, so neither consults this.
   *
   * Default false rather than true because of what the true costs: a vision objective
   * captures the screen *before* it has a model to send it to, so an optimistic answer
   * here spends a consent prompt and takes a picture that nothing can read.
   */
  llmVision?: boolean;
  /**
   * Hosts a mission's network tools may reach *past* the private-address guard.
   *
   * `host` or `host:port`, and nothing else — no scheme, no path, no wildcard. The
   * guard in `tools/net/web-client.ts` refuses loopback, private, link-local and
   * carrier-NAT addresses and every name that resolves to one, which is the defence
   * against an autonomous loop being talked into reading a router's admin page or a
   * cloud metadata endpoint. This is the list of exceptions a person made
   * deliberately: `localhost:3000` while developing, an internal wiki by name.
   *
   * A wildcard is deliberately not supported. `*.internal` would re-open the whole
   * class the guard exists to close, and an entry that has to be typed out in full
   * is one the person typing it has thought about.
   */
  webAllowHosts?: readonly string[];
  /**
   * Whether Jarvis may use what it remembers. Default true.
   *
   * The off switch for the whole memory layer, and it is a *use* switch rather than a
   * delete: nothing is erased by setting this false, and nothing is written either —
   * retrieval returns empty before it reads a store, so no memory, episode or profile
   * field reaches a plan or a prompt. A switch that quietly emptied the files would be
   * a worse answer to "stop using this" than the honest one, and an irreversible one.
   *
   * The Memory page can flip this for the session (`set_memory_enabled`); this is what
   * survives a restart.
   */
  memoryEnabled?: boolean;

  /**
   * Whether Jarvis may offer work nobody asked for.
   *
   * `propose` (the default) lets the world model raise suggestions: the last build
   * failed, a scheduled job is erroring, you are in a project nothing has looked at.
   * Each one waits for an answer and starts nothing — the only path from a suggestion
   * to a mission is `resolve_proposal`, which is a request the user's own window sends.
   *
   * `off` stops them being produced at all, rather than producing them and hiding
   * them: a queue filling up behind a switch the user turned off would be a record
   * they did not ask for. The world graph itself is still readable, because looking at
   * what Jarvis can see is not the same as being offered things.
   *
   * There is no `auto`. A value that ran missions without being asked is the thing
   * this whole subsystem is arranged to make impossible, so it is not spellable here.
   */
  proactive?: "off" | "propose";
}

/**
 * The Whisper models `sttModel` may name.
 *
 * faster-whisper resolves an unknown name as a HuggingFace repository and tries
 * to fetch it, so this is an allowlist rather than a pattern: a typo should
 * leave the default in place, not start a download.
 */
const STT_MODELS: readonly string[] = [
  "tiny", "tiny.en",
  "base", "base.en",
  "small", "small.en",
  "medium", "medium.en",
  "large-v1", "large-v2", "large-v3", "large-v3-turbo",
  "distil-small.en", "distil-medium.en", "distil-large-v3",
];

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

  // Voice tuning. Every one of these is a number or a short name that ends up in
  // the daemon's argv, and every one is dropped rather than clamped when it does
  // not make sense — a gain of 500 is a typo, and honouring it as 64 would leave
  // the user with amplified hiss and a config file that appears to explain it.
  if (obj.micGain === "auto") {
    out.micGain = "auto";
  } else if (typeof obj.micGain === "number" && Number.isFinite(obj.micGain)
             && obj.micGain >= 0.1 && obj.micGain <= 64) {
    out.micGain = obj.micGain;
  }

  if (typeof obj.sttModel === "string" && STT_MODELS.includes(obj.sttModel.trim())) {
    out.sttModel = obj.sttModel.trim();
  }

  if (typeof obj.sttBeam === "number" && Number.isInteger(obj.sttBeam)
      && obj.sttBeam >= 1 && obj.sttBeam <= 10) {
    out.sttBeam = obj.sttBeam;
  }

  for (const key of ["wakeThreshold", "wakeSoftThreshold"] as const) {
    const value = obj[key];
    // 0 is meaningful for the soft threshold — it turns the band off — but a
    // hard threshold of 0 would wake on silence, so the ranges differ.
    const floor = key === "wakeSoftThreshold" ? 0 : 0.01;
    if (typeof value === "number" && Number.isFinite(value)
        && value >= floor && value <= 1) {
      out[key] = value;
    }
  }

  // Spoken words, like `projectAliases`, so no path handling. The shape check is
  // what matters: the phrase becomes `--wake-alias <phrase>`, and it has to be a
  // name rather than a sentence, a flag, or a regex.
  if (Array.isArray(obj.wakeAliases)) {
    const ok: string[] = [];
    for (const item of obj.wakeAliases) {
      if (typeof item !== "string") continue;
      const phrase = item.trim().toLowerCase();
      if (phrase.length > 40) continue;
      if (!/^[a-z][a-z'.]*( [a-z][a-z'.]*){0,2}$/.test(phrase)) continue;
      ok.push(phrase);
    }
    if (ok.length > 0) out.wakeAliases = ok;
  }

  // Mission roots are paths, so they get exactly what `projectRoots` gets: each
  // one canonicalised, the ones that do not survive dropped, and no existence
  // check. Kept as a separate clause rather than folded in with `projectRoots`
  // because the two answer different questions and a user is allowed to say yes
  // to one of them.
  if (Array.isArray(obj.missionRoots)) {
    const ok: string[] = [];
    for (const item of obj.missionRoots) {
      if (typeof item !== "string") continue;
      const verdict = canonicalise(item);
      if (verdict.ok && verdict.path) ok.push(verdict.path);
    }
    if (ok.length > 0) out.missionRoots = ok;
  }

  // A ceiling, so it is dropped rather than clamped for the usual reason: a `0`
  // means a mission that can never run a step and a `10000` means one that is not
  // bounded in any way a person would recognise, and honouring either as 24 would
  // leave a config file that appears to explain behaviour it does not.
  if (typeof obj.maxMissionSteps === "number" && Number.isInteger(obj.maxMissionSteps)
      && obj.maxMissionSteps >= 1 && obj.maxMissionSteps <= 200) {
    out.maxMissionSteps = obj.maxMissionSteps;
  }

  // Risk classes, not paths and not tool names. Both sides are checked against a
  // fixed list, and an entry that fails either check is dropped whole: reading an
  // unrecognised verdict as `auto` would turn a typo into a permission, and
  // reading it as `deny` would silently disable a class the user never mentioned.
  // Dropping it leaves the engine's own level policy in charge, which is the one
  // behaviour that is safe to arrive at by accident.
  if (obj.missionPolicy && typeof obj.missionPolicy === "object" && !Array.isArray(obj.missionPolicy)) {
    const ok: Record<string, "auto" | "approval" | "deny"> = {};
    for (const [rawClass, verdict] of Object.entries(obj.missionPolicy as Record<string, unknown>)) {
      const cls = rawClass.toLowerCase().trim();
      if (!isRiskCategory(cls)) continue;
      if (verdict !== "auto" && verdict !== "approval" && verdict !== "deny") continue;
      ok[cls] = verdict;
    }
    if (Object.keys(ok).length > 0) out.missionPolicy = ok;
  }

  // Each entry is parsed as a URL rather than pattern-matched, because the whole
  // point of this key is to name something the guard would otherwise refuse: a
  // sloppy read here is a hole in the SSRF defence, not a cosmetic problem. A value
  // with a scheme, a path, a wildcard or credentials in it is dropped rather than
  // trimmed into shape — `http://localhost/admin` almost certainly means the user
  // expected a URL allowlist, and honouring the host while silently ignoring the
  // path would allow more than they wrote.
  if (Array.isArray(obj.webAllowHosts)) {
    const ok: string[] = [];
    for (const item of obj.webAllowHosts) {
      if (typeof item !== "string") continue;
      const entry = item.trim().toLowerCase();
      if (entry === "" || entry.length > 200) continue;
      if (/[\/\\?#@*\s]/.test(entry)) continue;
      let parsed: URL;
      try {
        // A bare `host:port` parses as a scheme with an opaque path, so it is
        // given one that cannot be confused for anything else.
        parsed = new URL(`http://${entry}`);
      } catch {
        continue;
      }
      if (parsed.hostname === "" || parsed.pathname !== "/" || parsed.search !== "") continue;
      const host = parsed.hostname.replace(/^\[|\]$/g, "");
      ok.push(parsed.port === "" ? host : `${host}:${parsed.port}`);
    }
    if (ok.length > 0) out.webAllowHosts = ok;
  }

  // The provider is an enum with one spelling each, so an unrecognised value is
  // dropped to `auto` by absence rather than corrected. `auto` is the safe landing
  // place: it uses what is configured and says so, and what it does when nothing is
  // configured is refuse to plan with a model at all.
  if (obj.llmProvider === "auto" || obj.llmProvider === "anthropic"
      || obj.llmProvider === "openai-compatible" || obj.llmProvider === "hermes"
      || obj.llmProvider === "offline") {
    out.llmProvider = obj.llmProvider;
  }

  // A model name, not a path and not a URL. The shape check is loose on purpose —
  // vendors use dots, slashes and colons in these — but it is still a check: a value
  // with a space or a quote in it is a mistake, and sending it would spend a round
  // trip to be told so.
  if (typeof obj.llmModel === "string") {
    const model = obj.llmModel.trim();
    if (model.length > 0 && model.length <= 100 && /^[A-Za-z0-9._:\/-]+$/.test(model)) {
      out.llmModel = model;
    }
  }

  // An `http`/`https` URL, parsed rather than pattern-matched, because this is a
  // value a request is *sent to*: a `file:` or `data:` URL here would be a way to
  // point the planner somewhere that is not a server at all.
  if (typeof obj.llmBaseUrl === "string" && obj.llmBaseUrl.trim() !== "") {
    try {
      const url = new URL(obj.llmBaseUrl.trim());
      if (url.protocol === "http:" || url.protocol === "https:") {
        out.llmBaseUrl = url.toString().replace(/\/+$/, "");
      }
    } catch {
      // Not a URL. Dropped, like every other unusable clause.
    }
  }

  if (typeof obj.llmPlanner === "boolean") out.llmPlanner = obj.llmPlanner;

  if (typeof obj.llmVision === "boolean") out.llmVision = obj.llmVision;

  if (typeof obj.llmTimeoutMs === "number" && Number.isInteger(obj.llmTimeoutMs)
      && obj.llmTimeoutMs >= 1_000 && obj.llmTimeoutMs <= 600_000) {
    out.llmTimeoutMs = obj.llmTimeoutMs;
  }

  if (typeof obj.memoryEnabled === "boolean") out.memoryEnabled = obj.memoryEnabled;

  // Dropped, not corrected, like every clause above: `proactive: "auto"` is a value
  // this build has no meaning for, and guessing that the user meant `propose` would be
  // inventing consent out of a typo.
  if (obj.proactive === "off" || obj.proactive === "propose") out.proactive = obj.proactive;

  return out;
}
