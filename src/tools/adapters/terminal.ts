/**
 * `run_command` — running a development command in a project directory.
 *
 * The narrowest thing that still deserves the name. Three limits, and the reasons
 * they are limits rather than warnings:
 *
 *  1. **An allow-list of programs, resolved here.** A step names `npm` and this
 *     file decides what `npm` is — on Windows that is `node npm-cli.js`, because
 *     `npm.cmd` is a batch shim Node refuses to spawn (`resolve-npm.ts`, found by
 *     a probe when every delegated task came back `spawn EINVAL`). A step cannot
 *     name a program.
 *  2. **An allow-list of subcommands per program.** `npm run <script>` is a
 *     project's own script; `npm install express` fetches code from the network
 *     and executes its install hooks. The second is not a development command in
 *     the sense this tool means, so it is not here. `node` may run a file inside
 *     the project and may not take `-e`, which would be arbitrary code from
 *     whatever produced the plan.
 *  3. **`cwd` inside the allowed roots.** Checked with `checkPath`, same as every
 *     filesystem tool.
 *
 * Exit code and both streams come back. A failing build is the *answer* a step
 * went to find, not an error in the mission — which is why this cannot use
 * `nodeRunner`, and why `git.ts` and this file share `process-run.ts`.
 */
import { checkPath } from "../../system/path-safety.js";
import { resolveNpm } from "../../coding/resolve-npm.js";
import { runVerified } from "../../permissions/verified-action.js";
import {
  nodeProcessRunner,
  outputTail,
  type ProcessResult,
  type ProcessRunner,
} from "../process-run.js";
import {
  readString,
  readStringArray,
  type Tool,
  type ToolArgs,
  type ToolContext,
  type ToolRun,
} from "../registry.js";

export interface TerminalDeps {
  readonly run?: ProcessRunner;
  /** `process.execPath`, so a test can point `node` somewhere harmless. */
  readonly execPath?: string;
  readonly platform?: string;
}

/** npm subcommands a mission may use. Anything absent is refused, with a reason. */
const NPM_SUBCOMMANDS: readonly string[] = [
  "run",
  "test",
  "ci",
  "ls",
  "outdated",
  "audit",
  "--version",
];

/**
 * `node` flags that turn the runtime into an interpreter for whatever produced
 * the plan. `node build.js` runs code that is already in the project and was
 * already reviewed; `node -e "…"` runs code from the argument, which in Phase 14
 * means code from a model.
 */
const NODE_FORBIDDEN_FLAGS: readonly string[] = [
  "-e",
  "--eval",
  "-p",
  "--print",
  "-r",
  "--require",
  "--import",
  "--experimental-loader",
  "--loader",
];

/** A build is slower than the registry's default, and slower than a git read. */
const COMMAND_TIMEOUT_MS = 180_000;

const MAX_ARGS = 12;

/** What to actually spawn, once the program name has been checked. */
interface SpawnPlan {
  readonly file: string;
  readonly args: readonly string[];
  readonly shell?: boolean;
  /** How the command reads back to the user. Never the resolved argv. */
  readonly display: string;
}

type Planned = SpawnPlan | { readonly reason: string };

function isRefusal(planned: Planned): planned is { readonly reason: string } {
  return "reason" in planned;
}

/**
 * `npm <subcommand> …`.
 *
 * `install` is the interesting absence. It is the most common development
 * command there is, and it is also a network fetch that runs install hooks from
 * whatever the registry serves — so as a step in an autonomous mission it is
 * closer to `execute arbitrary code` than to `build the project`. `npm ci` is
 * here instead: same effect, but bounded by a lockfile that is already in the
 * repository. The refusal says so, because a mission that cannot explain why it
 * stopped is worse than one that stops.
 */
function planNpm(args: readonly string[], deps: TerminalDeps): Planned {
  const [sub, ...rest] = args;
  if (sub === undefined) return { reason: "npm needs a subcommand, for example: run build" };
  if (!NPM_SUBCOMMANDS.includes(sub)) {
    if (sub === "install" || sub === "i" || sub === "add") {
      return {
        reason:
          "npm install is not available to a mission — it fetches and executes code from the network. Use npm ci, which installs exactly what the lockfile already names.",
      };
    }
    return { reason: `npm ${sub} is not one of: ${NPM_SUBCOMMANDS.join(", ")}` };
  }
  if (sub === "run" && rest.length === 0) {
    return { reason: "npm run needs the name of a script" };
  }
  // `npm.cmd` is a batch shim; Node will not spawn it, and the fix is to run
  // npm's own JS entry point under this very interpreter.
  const npm = resolveNpm(deps.execPath ?? process.execPath, deps.platform ?? process.platform);
  return {
    file: npm.file,
    args: [...npm.args, sub, ...rest],
    ...(npm.needsShell ? { shell: true } : {}),
    display: `npm ${args.join(" ")}`,
  };
}

/**
 * `node <file> …`.
 *
 * The first argument has to be a file, and after a file every remaining argument
 * belongs to the script rather than to the runtime — which is what makes the flag
 * check above enough: a `-e` that arrives third is script argv, not an eval.
 * `--version` is allowed on its own because "is node even here" is a fair thing
 * for a mission to ask.
 */
function planNode(args: readonly string[], deps: TerminalDeps): Planned {
  const execPath = deps.execPath ?? process.execPath;
  const [first, ...rest] = args;
  if (first === undefined) {
    return { reason: "node needs a file to run, or --version" };
  }
  if (first === "--version" || first === "-v") {
    return { file: execPath, args: ["--version"], display: "node --version" };
  }
  if (first.startsWith("-")) {
    const named = NODE_FORBIDDEN_FLAGS.includes(first) ? first : "that flag";
    return {
      reason: `node ${named} is not available to a mission — it would run code from the plan rather than from the project. Name a file in the project instead.`,
    };
  }
  return { file: execPath, args: [first, ...rest], display: `node ${args.join(" ")}` };
}

function plan(program: string, args: readonly string[], deps: TerminalDeps): Planned {
  switch (program) {
    case "npm":
      return planNpm(args, deps);
    case "node":
      return planNode(args, deps);
    default:
      // Unreachable through the schema's `oneOf`; kept so adding a program to the
      // list without adding a planner fails loudly rather than silently.
      return { reason: `${program} is not a program this tool can run` };
  }
}

/** How much command output travels in `data` for a later step to read. */
const MAX_OUTPUT_CHARS = 2_000;

function runCommand(deps: TerminalDeps): Tool {
  const runner = deps.run ?? nodeProcessRunner;
  return {
    name: "run_command",
    summary: "Run an allow-listed development command in a project directory",
    schema: {
      program: { kind: "string", required: true, oneOf: ["npm", "node"] },
      args: { kind: "stringArray", maxItems: MAX_ARGS, max: 200 },
      cwd: { kind: "string", required: true, max: 400 },
    },
    // Three timeouts wrap this call — the registry's, `runVerified`'s, and the
    // child's. They are ordered below so the innermost fires first, because it is
    // the only one that can say *why* it stopped rather than just that it did.
    timeoutMs: COMMAND_TIMEOUT_MS + 20_000,
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      const verdict = checkPath(readString(args, "cwd"), ctx.roots);
      if (!verdict.ok || !verdict.path) {
        return {
          outcome: "failed",
          summary: "refused",
          error: verdict.reason ?? "that directory is not allowed",
        };
      }
      const cwd = verdict.path;
      const program = readString(args, "program");
      const planned = plan(program, readStringArray(args, "args"), deps);
      if (isRefusal(planned)) {
        return { outcome: "failed", summary: "refused", error: planned.reason };
      }

      const childTimeoutMs = Math.max(1_000, ctx.timeoutMs - 20_000);
      // A box rather than a `let`: the assignment happens inside `act`, and the
      // type checker will not carry that through to the read after the await.
      const box: { result: ProcessResult | null } = { result: null };

      // The exit status is the observation. That is the one case where a tool may
      // treat what it was told as evidence: the code comes from the operating
      // system's account of a process that has ended, not from a program's
      // description of its own work. It is still narrow — `npm ci` exiting 0 does
      // not prove `node_modules` is complete — so a step that needs more than "it
      // succeeded" is followed by a step that reads the effect.
      const report = await runVerified<ProcessResult | null>(
        {
          description: `run ${planned.display}`,
          observe: () => box.result,
          act: async () => {
            const outcome = await runner(planned.file, planned.args, {
              cwd,
              timeoutMs: childTimeoutMs,
              ...(planned.shell ? { shell: true } : {}),
            });
            box.result = outcome;
            // Both of these are thrown rather than returned so the outcome is
            // `failed` and not `unconfirmed`: a command that exited non-zero is
            // not an unclear result, it is a definite negative one.
            if (outcome.timedOut) {
              throw new Error(`still running after ${Math.round(childTimeoutMs / 1000)}s, stopped`);
            }
            if (outcome.code !== 0) {
              throw new Error(`exit code ${outcome.code} · ${outputTail(outcome)}`);
            }
          },
          verify: (_before, after) => {
            if (after === null) return { ok: false, reason: "the command produced no result" };
            if (after.timedOut) return { ok: false, reason: "it did not finish in time" };
            return after.code === 0
              ? { ok: true, detail: `exit code 0 · ${outputTail(after, 4)}` }
              : { ok: false, reason: `it exited with code ${after.code}` };
          },
        },
        { timeoutMs: Math.max(1_000, ctx.timeoutMs - 10_000), now: ctx.now },
      );

      // Read once into a local: the null case is real — a runner that could not
      // start the program rejects, and `act` never gets as far as assigning.
      const settled: ProcessResult | null = box.result;
      return {
        outcome: report.outcome,
        summary: `${planned.display}: ${report.detail}`,
        // The tail is where a build failure actually says why. It is display text
        // and nothing more; the registry sanitises it on the way out.
        ...(settled !== null ? { detail: outputTail(settled, 12) } : {}),
        ...(report.error !== undefined ? { error: report.error } : {}),
        data: {
          command: planned.display,
          cwd,
          code: settled?.code ?? null,
          timedOut: settled?.timedOut ?? false,
          output: settled !== null ? outputTail(settled, 24).slice(0, MAX_OUTPUT_CHARS) : "",
        },
      };
    },
  };
}

/**
 * The terminal tools.
 *
 * One tool, and it is deliberately not called `terminal`: there is no shell here,
 * no command string, and no way for a step to name a program. `run_command`
 * classifies as an execute (level 3) on its name alone, so by default a mission
 * asks before the first build runs — which is the intended shape, not an
 * inconvenience to tune away.
 */
export function terminalTools(deps: TerminalDeps = {}): readonly Tool[] {
  return [runCommand(deps)];
}
