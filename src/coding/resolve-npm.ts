/**
 * Resolve a way to run `npm` that actually works on Windows.
 *
 * `npm` on Windows is `npm.cmd`, a batch shim. Since the fix for
 * CVE-2024-27980, Node refuses to spawn a `.cmd` or `.bat` without a shell:
 * `spawn EINVAL`, before the child exists. `scripts/probe-coding.ts` caught
 * exactly this — every delegated task came back `failed: spawn EINVAL`, so the
 * second opinion in `work-check.ts` was never actually a second opinion. The
 * unit tests could not have caught it: they inject the runner.
 *
 * The obvious repair is `shell: true`, and it is the wrong one to reach for
 * first. On Windows that concatenates the argv into a command line for cmd.exe
 * (Node DEP0190), which is the same reasoning `resolve-hermes.ts` records for
 * dropping the shell there.
 *
 * So: prefer the npm CLI's own JavaScript entry point, which ships beside
 * `node.exe` and is an ordinary file that `node` can run with no shell at all.
 * `npm.cmd` remains the fallback for an installation that keeps npm somewhere
 * else, and that path — and only that path — asks for a shell.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ResolvedNpm {
  /** The program to spawn. */
  file: string;
  /** Arguments that come before `run <script>`. */
  args: readonly string[];
  /** True when `file` is a batch shim and cannot be spawned directly. */
  needsShell: boolean;
}

/**
 * Where npm's JS entry point lives relative to the running node binary.
 *
 * True for the Windows installer, nvm-windows, fnm and Volta, all of which keep
 * a per-version `node_modules` next to the executable. Checked rather than
 * assumed, because being wrong here means falling back, not failing.
 */
function bundledCli(execPath: string): string | null {
  const candidate = join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(candidate) ? candidate : null;
}

/**
 * How to invoke npm on this machine.
 *
 * Takes its inputs as parameters so the fallback is reachable in a test without
 * uninstalling npm.
 */
export function resolveNpm(
  execPath: string = process.execPath,
  platform: string = process.platform,
): ResolvedNpm {
  const cli = bundledCli(execPath);
  if (cli) return { file: execPath, args: [cli], needsShell: false };
  // Nothing bundled: name the shim explicitly rather than relying on PATHEXT to
  // turn `npm` into `npm.cmd`, so the shell flag below matches what will run.
  return platform === "win32"
    ? { file: "npm.cmd", args: [], needsShell: true }
    : { file: "npm", args: [], needsShell: false };
}
