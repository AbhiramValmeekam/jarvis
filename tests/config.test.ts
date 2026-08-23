/**
 * `loadConfig` had no test until `workingDirectory` needed one.
 *
 * That key is load-bearing in a way the others are not: it decides whether an
 * auto-started Jarvis can find its Python venv, its voice daemon, its Piper
 * voice and its Whisper cache, all four of which resolve against the process's
 * working directory. A Run-key launch starts in `C:\Windows\system32`, so the
 * difference between reading this key and dropping it is the difference between
 * an assistant that hears its name and one that does not.
 *
 * The file is written to a temp path rather than mocked, because the thing worth
 * proving is that a real `JSON.parse` of a real file produces the right subset —
 * and because "never throws" is a claim about I/O, not about a stub.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/context/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a config file and read it back the way boot does. */
function read(contents: string, onError?: (msg: string) => void) {
  const file = join(dir, "config.json");
  writeFileSync(file, contents);
  return loadConfig(file, onError);
}

describe("workingDirectory", () => {
  it("is canonicalised, not taken verbatim", () => {
    const config = read(
      JSON.stringify({ workingDirectory: "E:/jarvis/tools/.." }),
    );
    // Forward slashes in, Windows separators and a resolved `..` out — the value
    // is compared against and spawned into, so the stored form has to be the
    // canonical one.
    expect(config.workingDirectory).toBe("E:\\jarvis");
  });

  it("drops a path that cannot be canonicalised, and keeps the rest of the file", () => {
    const config = read(
      JSON.stringify({
        // Relative: `canonicalise` refuses it, because resolving it here would
        // resolve it against the *reader's* cwd, which is the exact bug this key
        // exists to fix.
        workingDirectory: "jarvis",
        notifyLevel: "normal",
        projectAliases: { portfolio: "my-site" },
      }),
    );

    expect(config.workingDirectory).toBeUndefined();
    // A bad value for one key must not cost the user the others. `loadConfig`
    // returns a subset of what the file asked for, never nothing.
    expect(config.notifyLevel).toBe("normal");
    expect(config.projectAliases).toEqual({ portfolio: "my-site" });
  });

  it.each([
    ["a device-namespace path", "\\\\?\\E:\\jarvis"],
    ["a UNC share", "\\\\server\\share\\jarvis"],
    ["a reserved device name", "E:\\jarvis\\NUL"],
    ["a non-string", 42],
    ["an empty string", ""],
  ])("refuses %s", (_label, value) => {
    expect(read(JSON.stringify({ workingDirectory: value })).workingDirectory)
      .toBeUndefined();
  });
});

describe("microphone", () => {
  it("keeps a dshow device name exactly as ffmpeg spells it", () => {
    // No `canonicalise`: this is not a path, and the name has to match the
    // string ffmpeg prints, parentheses, registered trademark and all.
    const name = "Headset Microphone (Realtek(R) Audio)";
    expect(read(JSON.stringify({ microphone: name })).microphone).toBe(name);
  });

  it("trims the whitespace a hand-edited file collects", () => {
    expect(read(JSON.stringify({ microphone: "  Microphone Array  " })).microphone).toBe(
      "Microphone Array",
    );
  });

  it.each([
    ["a non-string", 42],
    ["an empty string", ""],
    ["only whitespace", "   "],
    // The name reaches ffmpeg as `-i audio=<name>`. It is passed with
    // `shell: false` so cmd.exe never sees it, but a quote would still break
    // dshow's own parsing of the filter string.
    ['a double quote', 'Mic" (Realtek)'],
    // Would arrive as `--device -x`, which argparse reads as a flag.
    ["a leading dash", "-x"],
    // A config file must not be able to forge a line in the runtime log.
    ["a control character", "Mic\u0007 (Realtek)"],
    ["a name longer than 200 characters", "M".repeat(201)],
  ])("refuses %s", (_label, value) => {
    expect(read(JSON.stringify({ microphone: value })).microphone).toBeUndefined();
  });

  it("keeps the rest of the file when it refuses one", () => {
    const config = read(
      JSON.stringify({ microphone: "-x", notifyLevel: "normal", workingDirectory: "E:/jarvis" }),
    );
    expect(config.microphone).toBeUndefined();
    expect(config.notifyLevel).toBe("normal");
    expect(config.workingDirectory).toBe("E:\\jarvis");
  });
});

describe("reading the file at all", () => {
  it("returns defaults for a file that does not exist", () => {
    expect(loadConfig(join(dir, "absent.json"))).toEqual({});
  });

  it("reports malformed JSON instead of throwing", () => {
    const seen: string[] = [];
    const config = read("{ not json", (msg) => seen.push(msg));

    expect(config).toEqual({});
    expect(seen.join(" ")).toMatch(/malformed config/);
  });

  it("keeps unknown keys from breaking a read", () => {
    // Forwards compatibility is the documented contract: a newer Jarvis writing
    // a key this build has never heard of must not cost the user the keys it
    // does understand.
    const config = read(
      JSON.stringify({ somethingFromTheFuture: { deep: true }, notifyLevel: "off" }),
    );
    expect(config.notifyLevel).toBe("off");
  });

  it("drops a notifyLevel it does not recognise rather than defaulting it", () => {
    // Reading "quiet" as `normal` would make Jarvis louder than the user asked.
    expect(read(JSON.stringify({ notifyLevel: "quiet" })).notifyLevel).toBeUndefined();
  });
});

describe("voice tuning", () => {
  // These exist because the voice fix is only as good as the settings that reach
  // the daemon, and every one of them ends up in its argv. The rule throughout:
  // a value that does not make sense is dropped, never clamped. Honouring
  // `micGain: 500` as 64 would leave a user with amplified hiss and a config file
  // that appears to explain it.
  it("reads a measured gain and the word auto", () => {
    expect(read(JSON.stringify({ micGain: 11.5 })).micGain).toBe(11.5);
    expect(read(JSON.stringify({ micGain: "auto" })).micGain).toBe("auto");
  });

  it("drops a gain outside the range a microphone could need", () => {
    for (const micGain of [0, 0.05, 65, 500, -3, Number.NaN, Number.POSITIVE_INFINITY, "11.5"]) {
      expect(read(JSON.stringify({ micGain })).micGain).toBeUndefined();
    }
  });

  it("only accepts Whisper models faster-whisper has names for", () => {
    expect(read(JSON.stringify({ sttModel: "small.en" })).sttModel).toBe("small.en");
    expect(read(JSON.stringify({ sttModel: " base.en " })).sttModel).toBe("base.en");
    // An unknown name is not a typo to faster-whisper — it is a HuggingFace
    // repository to go and download. Hence an allowlist rather than a pattern.
    expect(read(JSON.stringify({ sttModel: "small.eng" })).sttModel).toBeUndefined();
    expect(read(JSON.stringify({ sttModel: "evil/model" })).sttModel).toBeUndefined();
  });

  it("reads beam width only as a whole number in range", () => {
    expect(read(JSON.stringify({ sttBeam: 5 })).sttBeam).toBe(5);
    for (const sttBeam of [0, 11, 2.5, -1, "5"]) {
      expect(read(JSON.stringify({ sttBeam })).sttBeam).toBeUndefined();
    }
  });

  it("reads both wake thresholds", () => {
    const config = read(JSON.stringify({ wakeThreshold: 0.6, wakeSoftThreshold: 0.3 }));
    expect(config.wakeThreshold).toBe(0.6);
    expect(config.wakeSoftThreshold).toBe(0.3);
  });

  it("allows 0 for the soft threshold but not for the hard one", () => {
    // 0 turns the transcript-confirmed band off, which is a real choice. A hard
    // threshold of 0 would mean waking on silence, which is not.
    expect(read(JSON.stringify({ wakeSoftThreshold: 0 })).wakeSoftThreshold).toBe(0);
    expect(read(JSON.stringify({ wakeThreshold: 0 })).wakeThreshold).toBeUndefined();
  });

  it("drops a threshold above 1", () => {
    // Scores are probabilities. 50 is someone thinking in percent, and honouring
    // it as 1 would silently make the wake word unreachable.
    expect(read(JSON.stringify({ wakeThreshold: 50 })).wakeThreshold).toBeUndefined();
    expect(read(JSON.stringify({ wakeSoftThreshold: 1.5 })).wakeSoftThreshold).toBeUndefined();
  });

  it("reads wake aliases as short lower-cased phrases", () => {
    expect(read(JSON.stringify({ wakeAliases: ["Hey Jarv", "JARV"] })).wakeAliases)
      .toEqual(["hey jarv", "jarv"]);
  });

  it("refuses an alias that is a sentence, a flag, or punctuation", () => {
    // The phrase becomes `--wake-alias <phrase>` in the daemon's argv, and an
    // alias is a name rather than a pattern: `.*` would match every utterance.
    const config = read(JSON.stringify({
      wakeAliases: ["please wake up now", "--device", ".*", "", "jarv3", "hey  jarv"],
    }));
    expect(config.wakeAliases).toBeUndefined();
  });

  it("keeps the good aliases and drops the bad ones from the same list", () => {
    const config = read(JSON.stringify({ wakeAliases: ["jarv", "--device", 7] }));
    expect(config.wakeAliases).toEqual(["jarv"]);
  });

  it("leaves every voice key absent when the file does not mention them", () => {
    // The daemon's own defaults are the single source of truth for "unset".
    // Anything this layer invents is a default in a second place, which is how
    // the two drift.
    const config = read(JSON.stringify({ microphone: "Headset Microphone (Realtek(R) Audio)" }));
    expect(config.micGain).toBeUndefined();
    expect(config.sttModel).toBeUndefined();
    expect(config.sttBeam).toBeUndefined();
    expect(config.wakeThreshold).toBeUndefined();
    expect(config.wakeSoftThreshold).toBeUndefined();
    expect(config.wakeAliases).toBeUndefined();
  });
});

describe("what a mission is allowed to do", () => {
  it("canonicalises mission roots, and keeps them separate from project roots", () => {
    const config = read(
      JSON.stringify({ projectRoots: ["E:/code"], missionRoots: ["E:/jarvis/tools/.."] }),
    );
    expect(config.missionRoots).toEqual(["E:\\jarvis"]);
    // Opting into a scan is not opting into being acted upon: reading one key
    // must not populate the other.
    expect(config.projectRoots).toEqual(["E:\\code"]);
  });

  it("drops the roots it cannot canonicalise and keeps the rest", () => {
    // Same rules as `projectRoots`, because it is the same kind of value: a
    // relative path would resolve against whichever process happened to read the
    // file, and a device path is not a directory a mission can be confined to.
    const config = read(
      JSON.stringify({ missionRoots: ["jarvis", "\\\\?\\E:\\jarvis", 7, "", "E:/jarvis"] }),
    );
    expect(config.missionRoots).toEqual(["E:\\jarvis"]);
  });

  it("leaves mission roots absent rather than inventing one", () => {
    // Absence has to stay legible: a mission with no stated roots is confined by
    // the adapters' own fallback, and a default invented here would be a second
    // place that decides where an autonomous loop may write.
    expect(read(JSON.stringify({ missionRoots: ["jarvis"] })).missionRoots).toBeUndefined();
    expect(read(JSON.stringify({ missionRoots: "E:/jarvis" })).missionRoots).toBeUndefined();
    expect(read(JSON.stringify({})).missionRoots).toBeUndefined();
  });

  it("reads a step ceiling only as a whole number in range", () => {
    expect(read(JSON.stringify({ maxMissionSteps: 8 })).maxMissionSteps).toBe(8);
    expect(read(JSON.stringify({ maxMissionSteps: 200 })).maxMissionSteps).toBe(200);
    // 0 is a mission that can never run a step, and 10_000 is not a ceiling a
    // person would recognise as one. Both are dropped, not clamped to 24 — a
    // corrected value would leave a config file that appears to explain behaviour
    // it does not.
    for (const maxMissionSteps of [0, -1, 201, 12.5, "8", Number.NaN, null]) {
      expect(read(JSON.stringify({ maxMissionSteps })).maxMissionSteps).toBeUndefined();
    }
  });

  it("reads a policy per risk class, not per tool", () => {
    const config = read(
      JSON.stringify({ missionPolicy: { execute: "approval", DELETE: "deny", read: "auto" } }),
    );
    expect(config.missionPolicy).toEqual({ execute: "approval", delete: "deny", read: "auto" });
  });

  it("drops a class it does not classify anything as", () => {
    // Keys are the classes `classify()` assigns, not tool names: `run_command` is
    // what a caller called itself, and a policy keyed on it would govern nothing
    // while looking like it governed something.
    const config = read(
      JSON.stringify({ missionPolicy: { run_command: "deny", network: "approval" } }),
    );
    expect(config.missionPolicy).toEqual({ network: "approval" });
  });

  it("drops a verdict it does not recognise instead of guessing which way it meant", () => {
    // This is the one clause where the direction of a wrong guess matters twice
    // over: reading `"ask"` as `auto` would turn a typo into a permission, and
    // reading it as `deny` would disable a class the user never mentioned.
    const config = read(
      JSON.stringify({ missionPolicy: { execute: "ask", delete: true, write: "approval" } }),
    );
    expect(config.missionPolicy).toEqual({ write: "approval" });
  });

  it("leaves the policy absent when nothing in it survived", () => {
    // Absent means the permission engine's own level policy stays in charge,
    // which is the only outcome that is safe to arrive at by accident.
    expect(read(JSON.stringify({ missionPolicy: { execute: "ask" } })).missionPolicy).toBeUndefined();
    expect(read(JSON.stringify({ missionPolicy: ["execute"] })).missionPolicy).toBeUndefined();
    expect(read(JSON.stringify({ missionPolicy: "deny" })).missionPolicy).toBeUndefined();
  });

  it("keeps the voice settings when a mission key is wrong", () => {
    const config = read(
      JSON.stringify({
        maxMissionSteps: 0,
        missionPolicy: { nope: "deny" },
        missionRoots: ["jarvis"],
        wakeAliases: ["jarv"],
        sttBeam: 5,
      }),
    );
    expect(config.maxMissionSteps).toBeUndefined();
    expect(config.missionPolicy).toBeUndefined();
    expect(config.missionRoots).toBeUndefined();
    expect(config.wakeAliases).toEqual(["jarv"]);
    expect(config.sttBeam).toBe(5);
  });
});
