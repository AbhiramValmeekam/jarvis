/**
 * How npm gets invoked, which sounds like plumbing and was a silent failure.
 *
 * `work-check.ts` is the second opinion on delegated coding work. It spawned
 * `npm.cmd` with no shell, which Node has refused since the fix for
 * CVE-2024-27980: `spawn EINVAL`, thrown before the child exists. So every
 * completed task was graded `failed` — correct-looking output, wrong reason, and
 * invisible to a unit test that injects the runner. `scripts/probe-coding.ts`
 * found it on the first live run.
 *
 * These tests pin the resolution itself: prefer something spawnable directly,
 * and ask for a shell only when there is no alternative.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveNpm } from "../src/coding/resolve-npm.js";

describe("resolveNpm", () => {
  it("runs npm's own JS entry point through node when it ships beside it", () => {
    // Asserted against this machine's real layout rather than a fake, because
    // the claim being made is about the filesystem.
    const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(cli)) return; // covered by the fallback test below
    const npm = resolveNpm();
    expect(npm).toEqual({ file: process.execPath, args: [cli], needsShell: false });
    expect(npm.needsShell).toBe(false);
  });

  it("falls back to the batch shim on Windows, and says it needs a shell", () => {
    // A node installed somewhere without a bundled npm. The shim is nameable,
    // but it cannot be spawned directly — so the flag has to travel with it.
    expect(resolveNpm("C:\\nowhere\\node.exe", "win32")).toEqual({
      file: "npm.cmd",
      args: [],
      needsShell: true,
    });
  });

  it("needs no shell off Windows", () => {
    expect(resolveNpm("/nowhere/bin/node", "linux")).toEqual({
      file: "npm",
      args: [],
      needsShell: false,
    });
  });

  it("never asks for a shell when it resolved a real file", () => {
    // The invariant that keeps DEP0190 out of the normal path: a shell is only
    // ever requested for the fallback, where no concrete path was found.
    for (const platform of ["win32", "linux", "darwin"]) {
      const npm = resolveNpm(process.execPath, platform);
      if (npm.args.length > 0) expect(npm.needsShell).toBe(false);
    }
  });
});
