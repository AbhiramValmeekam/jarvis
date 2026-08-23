/**
 * Running a program for a mission step, without a shell.
 *
 * `local-intents/executors.ts` already has `nodeRunner`, and this is not a
 * replacement for it. That one rejects on a non-zero exit and returns stdout as a
 * string, which is right for "what is the battery percentage" and wrong here: a
 * build that fails is not an error in the mission, it is the *answer* the step
 * went to find. So this returns the exit code and both streams, and rejects only
 * when the process could not be started at all.
 *
 * The rules it keeps are the ones the Phase 4 executors established:
 *
 *  - argv arrays, never a command string. `shell: false` unless the target is a
 *    Windows batch shim, which only `resolveNpm` can ask for.
 *  - a timeout on everything, because an always-on assistant that waits forever
 *    on one wedged child is down.
 *  - output capped, and the cap reported rather than hidden.
 */
import { execFile } from "node:child_process";

export interface ProcessResult {
  /** `null` when the process was killed by a signal or never reported one. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the timeout killed it, which is a different fact from a bad exit code. */
  readonly timedOut: boolean;
}

export interface ProcessOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  /** Only for a batch shim that Node refuses to spawn directly. See `resolveNpm`. */
  readonly shell?: boolean;
  /**
   * Variables added to the inherited environment for this one call.
   *
   * Merged rather than replacing: a child that loses `PATH` and `SystemRoot`
   * fails in ways that look like the tool being broken. This exists for the two
   * callers that need it — running a VS Code CLI entry point under
   * `ELECTRON_RUN_AS_NODE`, and handing a *path* to a fixed PowerShell command
   * without putting it in the command string — and for nothing else. The values
   * are set by this repository, never by a plan or an utterance.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/** Injected by tests and by the probe, so no test spawns a real build. */
export type ProcessRunner = (
  file: string,
  args: readonly string[],
  opts: ProcessOptions,
) => Promise<ProcessResult>;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 1 << 20;

export const nodeProcessRunner: ProcessRunner = (file, args, opts) =>
  new Promise((resolvePromise, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
        ...(opts.shell ? { shell: true } : {}),
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      },
      (err, stdout, stderr) => {
        // `err.code` is the exit status for a process that ran and failed; it is a
        // string like `ENOENT` when the program does not exist, which is the one
        // case that is genuinely an error rather than a result.
        const status = typeof (err as { code?: unknown } | null)?.code;
        if (err && status === "string") {
          reject(new Error(`could not run ${file}: ${(err as NodeJS.ErrnoException).code}`));
          return;
        }
        resolvePromise({
          code: child.exitCode ?? (typeof err?.code === "number" ? err.code : err ? 1 : 0),
          stdout: String(stdout),
          stderr: String(stderr),
          // `killed` is not on `ErrnoException`, but `execFile` does set it when it
          // is the one that ended the child — which is what a timeout is here.
          // `child.killed` alone would also be true for a process someone else
          // signalled, so both are consulted.
          timedOut: Boolean(err) && (child.killed || (err as { killed?: boolean }).killed === true),
        });
      },
    );
  });

/** The tail of a command's output — where a build failure actually says why. */
export function outputTail(result: ProcessResult, lines = 12): string {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (text === "") return "no output";
  return text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-lines).join(" · ");
}
