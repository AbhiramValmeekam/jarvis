/**
 * Finding the coding platforms on a machine, and building an argv for each.
 *
 * The two halves fail differently and so are tested differently.
 *
 * Discovery reads a filesystem and an environment, both injected, so the tests
 * decide what is installed. What matters is not "did it find Code.exe" but the
 * three judgements around that: `PATH` before an install path, `PATHEXT`
 * expansion on Windows only, and `needsShell` decided from the file that was
 * actually resolved rather than from the name that was looked up. The last one
 * is the one with teeth — a `.cmd` that Node will not spawn (CVE-2024-27980)
 * must be recognised as one wherever it came from.
 *
 * Invocation is checked for the property the whole module exists to keep: a
 * prompt is one element of an argv and never a fragment of a command line. The
 * VS Code family reaches its CLI through the app binary under
 * `ELECTRON_RUN_AS_NODE`, because the alternative — the `bin` shim — is a batch
 * file, and spawning one means handing a sentence to `cmd.exe`.
 *
 * Nothing here spawns a process or touches a real install.
 */
import { describe, it, expect } from "vitest";
import {
  PLATFORMS,
  discoverPlatforms,
  findPlatform,
  type InstalledPlatform,
} from "../src/coding/platforms.js";
import { openInvocation, promptInvocation } from "../src/coding/platform-invoke.js";

/** A filesystem: the set of paths that exist, matched case-insensitively. */
function fsOf(...paths: string[]) {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p: string): boolean => set.has(p.toLowerCase());
}

const WIN_ENV = {
  PATH: "C:\\bin;C:\\Program Files\\nodejs",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
  ProgramFiles: "C:\\Program Files",
};

/** An installed platform, without going through discovery to get one. */
function installed(id: string, command: string): InstalledPlatform {
  const spec = PLATFORMS.find((p) => p.id === id);
  if (!spec) throw new Error(`no such platform: ${id}`);
  return {
    spec,
    command,
    needsShell: /\.(?:cmd|bat)$/i.test(command),
    foundVia: command.toLowerCase().includes("\\bin\\") ? "path" : "install",
  };
}

describe("discovering what is installed", () => {
  it("finds a bare name on PATH by expanding PATHEXT", () => {
    const found = discoverPlatforms({
      platform: "win32",
      env: WIN_ENV,
      exists: fsOf("C:\\bin\\antigravity-ide.cmd"),
    });
    expect(found.map((p) => p.spec.id)).toEqual(["antigravity"]);
    // `.CMD`, in `PATHEXT`'s own casing: the extension is not normalised, because
    // what comes back is the candidate that was found rather than a
    // reconstruction of it. Everything downstream compares case-insensitively.
    expect(found[0]?.command).toBe("C:\\bin\\antigravity-ide.CMD");
    expect(found[0]?.needsShell).toBe(true);
    expect(found[0]?.foundVia).toBe("path");
  });

  it("marks a batch shim as needing a shell, and an exe as not", () => {
    // The distinction Node's fix for CVE-2024-27980 forces: a `.cmd` cannot be
    // spawned at all without `shell: true`, and `shell: true` is what turns an
    // argv into a `cmd.exe` command line. Decided from the resolved file, which
    // is why discovery returns the file and not the name it searched for.
    const shim = discoverPlatforms({
      platform: "win32",
      env: WIN_ENV,
      exists: fsOf("C:\\bin\\code.cmd"),
    });
    expect(shim[0]?.needsShell).toBe(true);

    const exe = discoverPlatforms({
      platform: "win32",
      env: WIN_ENV,
      exists: fsOf("C:\\Program Files\\Microsoft VS Code\\Code.exe"),
    });
    expect(exe[0]?.needsShell).toBe(false);
    expect(exe[0]?.foundVia).toBe("install");
  });

  it("prefers PATH over an install location when both are there", () => {
    const found = discoverPlatforms({
      platform: "win32",
      env: WIN_ENV,
      exists: fsOf("C:\\bin\\code.cmd", "C:\\Program Files\\Microsoft VS Code\\Code.exe"),
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.foundVia).toBe("path");
  });

  it("returns the catalogue's order, not the order things were found in", () => {
    // Order is capability: `delegate_coding_task` takes the first entry when no
    // platform was named, so a headless one has to come before an open-only one
    // regardless of which directory happened to be searched first.
    const found = discoverPlatforms({
      platform: "win32",
      env: WIN_ENV,
      exists: fsOf(
        "C:\\Users\\x\\AppData\\Local\\Programs\\Trae\\Trae.exe",
        "C:\\Users\\x\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe",
        "C:\\bin\\claude.exe",
      ),
    });
    expect(found.map((p) => p.spec.id)).toEqual(["claude-code", "antigravity", "trae"]);
  });

  it("splits PATH on a colon off Windows, and asks for the bare name", () => {
    // Asserted by watching what was looked for rather than by comparing a joined
    // path: `node:path` joins with the *host's* separator, so a path built here
    // for a Linux environment is a fact about the machine running the test. What
    // is portable, and what this is about, is that both entries were searched and
    // neither was suffixed — no `PATHEXT` expansion where there is no `PATHEXT`.
    const asked: string[] = [];
    discoverPlatforms({
      platform: "linux",
      env: { PATH: "/usr/bin:/home/x/.local/bin", HOME: "/home/x" },
      exists: (path) => {
        asked.push(path);
        return false;
      },
    });
    const claude = asked.filter((p) => p.includes("claude"));
    expect(claude.some((p) => p.includes("usr") && p.endsWith("claude"))).toBe(true);
    expect(claude.some((p) => p.includes(".local") && p.endsWith("claude"))).toBe(true);
    expect(claude.some((p) => /\.(?:exe|cmd|bat|com)$/i.test(p))).toBe(false);
  });

  it("finds nothing when nothing is installed, and skips empty PATH entries", () => {
    expect(
      discoverPlatforms({ platform: "win32", env: { PATH: ";; ;" }, exists: () => false }),
    ).toEqual([]);
  });

  it("ignores an install candidate whose environment variable is unset", () => {
    // `ProgramFiles` missing must not become a lookup at a relative path.
    const found = discoverPlatforms({
      platform: "win32",
      env: { PATH: "", PATHEXT: ".EXE" },
      exists: (p) => p === "Microsoft VS Code\\Code.exe",
    });
    expect(found).toEqual([]);
  });
});

describe("naming a platform", () => {
  const here = [installed("vscode", "C:\\vsc\\Code.exe"), installed("antigravity", "C:\\ag\\Antigravity IDE.exe")];

  it("matches an id, a label, and a spoken label with the punctuation gone", () => {
    expect(findPlatform("antigravity", here)?.spec.id).toBe("antigravity");
    expect(findPlatform("  Visual Studio Code ", here)?.spec.id).toBe("vscode");
    expect(findPlatform("visualstudiocode", here)?.spec.id).toBe("vscode");
  });

  it("answers null rather than the nearest thing", () => {
    // A wrong platform is a task delivered somewhere the user did not ask for.
    expect(findPlatform("cursor", here)).toBeNull();
    expect(findPlatform("vs", here)).toBeNull();
  });
});

describe("building an argv to open a project", () => {
  it("opens through the app binary beside a PATH shim, never the shim", () => {
    const p = installed("antigravity", "C:\\ag\\bin\\antigravity-ide.cmd");
    const inv = openInvocation(p, "C:\\work\\site", [], {
      exists: fsOf("C:\\ag\\Antigravity IDE.exe"),
    });
    expect(inv).toEqual({
      file: "C:\\ag\\Antigravity IDE.exe",
      args: ["--reuse-window", "C:\\work\\site"],
      env: {},
      needsShell: false,
    });
  });

  it("puts extra files after the directory, so a note opens as a tab", () => {
    const p = installed("antigravity", "C:\\ag\\Antigravity IDE.exe");
    const inv = openInvocation(p, "C:\\work\\site", ["C:\\data\\task-1.md"], { exists: fsOf("C:\\ag\\Antigravity IDE.exe") });
    expect(inv?.args).toEqual(["--reuse-window", "C:\\work\\site", "C:\\data\\task-1.md"]);
  });

  it("refuses when the only file there is a shim", () => {
    // Reported rather than worked around: working around it means `cmd.exe`.
    const p = installed("antigravity", "C:\\ag\\bin\\antigravity-ide.cmd");
    expect(openInvocation(p, "C:\\work\\site", [], { exists: () => false })).toBeNull();
  });
});

describe("building an argv that carries a prompt", () => {
  const PROMPT = 'make a small html page & call it "index" > done';

  it("runs the CLI entry point under ELECTRON_RUN_AS_NODE for the VS Code family", () => {
    const p = installed("vscode", "C:\\vsc\\bin\\code.cmd");
    const inv = promptInvocation(p, PROMPT, {
      exists: fsOf("C:\\vsc\\Code.exe", "C:\\vsc\\resources\\app\\out\\cli.js"),
    });
    expect(inv).toEqual({
      file: "C:\\vsc\\Code.exe",
      args: [
        "C:\\vsc\\resources\\app\\out\\cli.js",
        "chat",
        "-m",
        "agent",
        "--reuse-window",
        "--",
        PROMPT,
      ],
      env: { ELECTRON_RUN_AS_NODE: "1", VSCODE_DEV: "" },
      needsShell: false,
    });
  });

  it("finds the entry point under a per-commit directory too", () => {
    // VS Code's updater interposes one; Antigravity's installer does not. Both
    // shapes are real, and neither is guessable from the other.
    const p = installed("vscode", "C:\\vsc\\Code.exe");
    const inv = promptInvocation(p, "hi", {
      exists: fsOf("C:\\vsc\\Code.exe", "C:\\vsc\\110a328ea5\\resources\\app\\out\\cli.js"),
      readdir: () => ["110a328ea5", "locales", "swiftshader"],
    });
    expect("refused" in inv).toBe(false);
    expect((inv as { args: readonly string[] }).args[0]).toBe(
      "C:\\vsc\\110a328ea5\\resources\\app\\out\\cli.js",
    );
  });

  it("keeps the prompt as one argument, last, after a `--`", () => {
    // The property the module exists for. `--` is what stops a task beginning
    // with a dash from being read as an option.
    const p = installed("vscode", "C:\\vsc\\Code.exe");
    const inv = promptInvocation(p, "-p is not a flag here", {
      exists: fsOf("C:\\vsc\\Code.exe", "C:\\vsc\\resources\\app\\out\\cli.js"),
    });
    const args = (inv as { args: readonly string[] }).args;
    expect(args[args.length - 1]).toBe("-p is not a flag here");
    expect(args[args.length - 2]).toBe("--");
  });

  it("runs a plain agent's own binary with no extra environment", () => {
    const p = installed("claude-code", "C:\\bin\\claude.exe");
    expect(promptInvocation(p, "fix the build", { exists: () => false })).toEqual({
      file: "C:\\bin\\claude.exe",
      args: ["-p", "--output-format", "json", "--", "fix the build"],
      env: {},
      needsShell: false,
    });
  });

  it("refuses with `channel` for an editor that has no way to be told anything", () => {
    // Antigravity 1.107.0 advertises a `chat` subcommand inherited from VS Code
    // and exits 0 running it, while its renderer log says
    // `command 'workbench.action.chat.newChat' not found`. The catalogue records
    // that as `handoff`, and the refusal has to be `channel` — not `no-cli` —
    // because the CLI is right there and it is the wrong question.
    const p = installed("antigravity", "C:\\ag\\Antigravity IDE.exe");
    expect(
      promptInvocation(p, "build a page", {
        exists: fsOf("C:\\ag\\Antigravity IDE.exe", "C:\\ag\\resources\\app\\out\\cli.js"),
      }),
    ).toEqual({ refused: "channel" });
  });

  it("refuses with `no-cli` when a headless platform's entry point is missing", () => {
    const p = installed("vscode", "C:\\vsc\\Code.exe");
    expect(promptInvocation(p, "x", { exists: fsOf("C:\\vsc\\Code.exe"), readdir: () => [] })).toEqual({
      refused: "no-cli",
    });
  });
});

describe("the catalogue itself", () => {
  it("gives promptArgs to exactly the headless platforms, ending each with `--`", () => {
    // The invariant that makes "can this be told anything" a fact about the
    // table rather than about a code path.
    for (const spec of PLATFORMS) {
      expect(spec.promptArgs === undefined, spec.id).toBe(spec.channel !== "headless");
      if (spec.promptArgs) expect(spec.promptArgs.at(-1), spec.id).toBe("--");
    }
  });

  it("names a binary for every VS Code fork, and uses unique ids", () => {
    const ids = PLATFORMS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of PLATFORMS) {
      if (spec.family === "vscode") expect(spec.exeName, spec.id).toBeTruthy();
      expect(spec.note.length, spec.id).toBeGreaterThan(20);
    }
  });
});
