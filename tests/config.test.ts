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
