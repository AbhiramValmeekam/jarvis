/**
 * Delegating a coding task to whatever is installed to do coding with.
 *
 * This adapter exists because of a specific thing Jarvis said. Asked to "open
 * Antigravity and tell it to make a small HTML webpage", it opened nothing and
 * explained that it had no way to drive another program's interface — which was
 * true, and was true of a machine with three coding agents on it, one of which
 * this repository already knew how to run headless (`coding/claude-code-manager.ts`,
 * wired into the runtime since Phase 8 and reachable by nothing). The gap was
 * never a capability. It was that no tool named the capability, so no plan could
 * ask for it.
 *
 * Two tools, and the split matters:
 *
 * `list_coding_platforms` is a reading. It says what is installed and, for each,
 * whether a task can be *given* to it or only prepared for it. A planner that
 * asks this first stops promising delivery it cannot make, which is the failure
 * the screenshot recorded — an apology composed from a guess about the machine
 * rather than a look at it.
 *
 * `delegate_coding_task` acts. It classifies as `execute` through
 * `risk-model.ts#family` (`task`), which is correct: handing a sentence to an
 * agent that edits files is not a lower-risk act than running a command, and in
 * one case it literally is one.
 *
 * ## What it will and will not claim
 *
 * A `headless` platform runs the task and the outcome is `unchecked` — the work
 * started, and whether it is right is a question for `work-check.ts` and not for
 * the tool that asked. A `handoff` platform gets the task staged and the editor
 * opened, and the outcome is `unconfirmed` with a summary that says a paste is
 * outstanding. Neither is ever `verified`, because in neither case has anything
 * here looked at the result — the distinction §43 exists to protect.
 */
import { findProject, type ProjectEntry } from "../../context/project-registry.js";
import { discoverPlatforms, findPlatform, type InstalledPlatform } from "../../coding/platforms.js";
import { promptInvocation, type InvokeDeps } from "../../coding/platform-invoke.js";
import { stageHandoff } from "../../coding/handoff.js";
import type { ProcessRunner } from "../process-run.js";
import {
  readOptionalString,
  readString,
  type Tool,
  type ToolArgs,
  type ToolContext,
  type ToolRun,
} from "../registry.js";

/**
 * `InvokeDeps` is extended rather than re-declared so the filesystem lookups
 * behind an argv — the app binary, the CLI entry point — stay injectable all the
 * way from here. Without that, the one path worth testing most carefully (a
 * prompt reaching a real command line) could only be exercised on a machine that
 * happened to have the editor installed at the path the test guessed.
 */
export interface CodingPlatformDeps extends InvokeDeps {
  /** Read at call time, so a project cloned after boot is a valid target. */
  readonly projects: () => readonly ProjectEntry[];
  /** Injected by tests; production discovers from the filesystem each call. */
  readonly platforms?: () => readonly InstalledPlatform[];
  /** Where a staged task note is written. Jarvis' own directory, not a project. */
  readonly dataDir: string;
  /**
   * Detached start, so an editor the user asked for outlives the runtime.
   *
   * `nodeLauncher`'s shape, third parameter included: a VS Code CLI entry point
   * only runs with `ELECTRON_RUN_AS_NODE` set, and that is the difference between
   * spawning a file and handing a command line to `cmd.exe`.
   */
  readonly launch: (
    file: string,
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
  ) => Promise<void>;
  readonly run?: ProcessRunner;
  readonly platform?: string;
  /**
   * Start a real headless job, and return something to follow it by.
   *
   * Supplied by the runtime as a closure over `startCoding`, which is what
   * carries the snapshot, the budget, the concurrency cap and the after-the-fact
   * work check. Absent means the headless path is not available here — and then
   * a headless platform is *not* silently downgraded to a handoff, because
   * "opened an editor" is not what "delegate this" asked for. It reports the
   * absence instead.
   */
  readonly delegate?: (
    task: string,
    project: ProjectEntry,
  ) => Promise<{ readonly id: string; readonly detail: string }>;
}

/** How a platform travels to the next step, and into the tool pane. */
function facts(p: InstalledPlatform): ToolArgs {
  return {
    id: p.spec.id,
    label: p.spec.label,
    channel: p.spec.channel,
    /** Whether a task can be handed over without a person finishing the job. */
    acceptsTask: p.spec.channel === "headless",
    command: p.command,
    foundVia: p.foundVia,
    checkedOn: p.spec.checkedOn ?? "never",
    note: p.spec.note,
  };
}

function listPlatforms(deps: CodingPlatformDeps): Tool {
  return {
    name: "list_coding_platforms",
    summary: "List the coding tools installed here, and which accept a task directly",
    schema: {},
    async run(_args: ToolArgs, _ctx: ToolContext): Promise<ToolRun> {
      const installed = (deps.platforms ?? discoverPlatforms)();
      if (installed.length === 0) {
        return {
          outcome: "verified",
          summary: "no coding platform is installed here",
          data: { platforms: [] },
        };
      }
      const direct = installed.filter((p) => p.spec.channel === "headless");
      return {
        outcome: "verified",
        summary:
          direct.length === 0
            ? `${installed.length} installed, none that can be given a task directly`
            : `${installed.length} installed, ${direct.length} that can be given a task directly`,
        detail: installed
          .map((p) => `${p.spec.label} (${p.spec.channel === "headless" ? "accepts a task" : "opens only"})`)
          .join(" · "),
        data: { platforms: installed.map(facts) },
      };
    },
  };
}

/** The project a task is about: named, or the only one there is. */
function resolveProject(
  spoken: string | undefined,
  entries: readonly ProjectEntry[],
): { readonly ok: true; readonly project: ProjectEntry } | { readonly ok: false; readonly reason: string } {
  if (entries.length === 0) return { ok: false, reason: "no projects are configured" };
  if (spoken === undefined) {
    // One project is not ambiguous, and making the caller name it would fail a
    // request that had exactly one sensible reading. More than one is genuinely a
    // question, and guessing at it is how an agent edits the wrong repository.
    return entries.length === 1 && entries[0] !== undefined
      ? { ok: true, project: entries[0] }
      : { ok: false, reason: `name a project: ${entries.length} are configured` };
  }
  const lookup = findProject(spoken, entries);
  if (lookup.kind === "one") return { ok: true, project: lookup.project };
  return {
    ok: false,
    reason:
      lookup.kind === "none"
        ? `no project answers to "${spoken}"`
        : `${lookup.candidates.length} projects answer to "${spoken}"`,
  };
}

function delegateTask(deps: CodingPlatformDeps): Tool {
  return {
    name: "delegate_coding_task",
    summary: "Hand a coding task to an installed coding agent or editor",
    schema: {
      // Long, because this is the whole instruction another agent will work from
      // and truncating it silently would be the worst possible edit to make to it.
      task: { kind: "string", required: true, max: 4_000 },
      project: { kind: "string", max: 120 },
      /**
       * Which platform, by id or spoken name. Absent means the strongest
       * installed one — which is the difference between answering "build me a
       * page" and asking the user which program they would like it built in.
       */
      platform: { kind: "string", max: 60 },
    },
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      const task = readString(args, "task");
      const installed = (deps.platforms ?? discoverPlatforms)();
      if (installed.length === 0) {
        return {
          outcome: "failed",
          summary: "nothing installed here can be given a coding task",
          error: "no known coding platform was found on PATH or in its usual install location",
        };
      }
      const named = readOptionalString(args, "platform");
      const platform = named === undefined ? installed[0] : findPlatform(named, installed);
      if (platform === undefined || platform === null) {
        return {
          outcome: "failed",
          summary: `${named} is not installed here`,
          detail: `installed: ${installed.map((p) => p.spec.label).join(", ")}`,
          error: `no installed platform answers to "${named}"`,
          data: { platforms: installed.map(facts) },
        };
      }
      const project = resolveProject(readOptionalString(args, "project"), deps.projects());
      if (!project.ok) {
        return { outcome: "failed", summary: project.reason, error: project.reason };
      }
      return platform.spec.channel === "headless"
        ? runHeadless(platform, task, project.project, deps, ctx)
        : runHandoff(platform, task, project.project, deps, ctx);
    },
  };
}

/**
 * Give the task to something that will actually do it.
 *
 * Two shapes of headless platform, and they are not interchangeable. Claude Code
 * goes through the runtime's own manager, because that is where the concurrency
 * cap, the spend ceiling, the project-scoped `cwd` and the after-the-fact work
 * check live — none of which belong in a tool adapter, and all of which a
 * spoken sentence must not be able to skip by asking for the same thing a
 * different way. Anything else goes through its command line, detached, and the
 * outcome says only that the task was delivered.
 *
 * `unchecked` in both cases, and deliberately. The work is running; nothing here
 * has looked at it. `verified` would be this tool grading an actor's own report
 * of its own work, which is the one thing `verified-action.ts` is written to stop.
 */
async function runHeadless(
  platform: InstalledPlatform,
  task: string,
  project: ProjectEntry,
  deps: CodingPlatformDeps,
  ctx: ToolContext,
): Promise<ToolRun> {
  if (platform.spec.id === "claude-code") {
    if (!deps.delegate) {
      // Not downgraded to a handoff: "delegate this" asked for the work to be
      // done, and opening an editor is a different answer wearing its clothes.
      return {
        outcome: "failed",
        summary: "the headless coding agent is not wired up in this runtime",
        error: "no delegate was supplied, so no job could be started or budgeted",
        data: { platform: facts(platform) },
      };
    }
    const job = await deps.delegate(task, project);
    return {
      outcome: "unchecked",
      summary: `${platform.spec.label} is working on it in ${project.name}`,
      detail: job.detail,
      data: { platform: facts(platform), jobId: job.id, project: project.key, delivered: true },
    };
  }

  const invocation = promptInvocation(platform, task, {
    ...(deps.exists ? { exists: deps.exists } : {}),
    ...(deps.readdir ? { readdir: deps.readdir } : {}),
  });
  if ("refused" in invocation) {
    return {
      outcome: "failed",
      summary: `${platform.spec.label} could not be given the task`,
      detail: platform.spec.note,
      error: `prompt channel unavailable: ${invocation.refused}`,
      data: { platform: facts(platform), refused: invocation.refused },
    };
  }
  try {
    await deps.launch(invocation.file, invocation.args, invocation.env);
  } catch (err) {
    return {
      outcome: "failed",
      summary: `${platform.spec.label} would not start`,
      error: (err as Error).message,
      data: { platform: facts(platform) },
    };
  }
  ctx.log(`delegated to ${platform.spec.id} in ${project.dir}`);
  return {
    outcome: "unchecked",
    summary: `gave the task to ${platform.spec.label} for ${project.name}`,
    detail: `${platform.spec.note}. Nothing here has seen the result yet.`,
    data: { platform: facts(platform), project: project.key, delivered: true },
  };
}

/**
 * Prepare the task for a platform that cannot be told one, and say so.
 *
 * `unconfirmed` is the right outcome and it is worth being precise about why.
 * Something did happen — a file was written, the clipboard holds the task, an
 * editor is open on the project — so `failed` would be a lie in the other
 * direction. But the thing that was asked for, a coding agent working on this,
 * has not started and will not until a person pastes. `unconfirmed` is exactly
 * "acted, and the check says the world has not changed the way it was supposed
 * to", which is the state this leaves the machine in.
 *
 * The summary names the outstanding action rather than burying it in `detail`,
 * because the summary is what gets spoken.
 */
async function runHandoff(
  platform: InstalledPlatform,
  task: string,
  project: ProjectEntry,
  deps: CodingPlatformDeps,
  ctx: ToolContext,
): Promise<ToolRun> {
  const staged = await stageHandoff(platform, project.dir, task, {
    dataDir: deps.dataDir,
    launch: deps.launch,
    ...(deps.exists ? { exists: deps.exists } : {}),
    ...(deps.readdir ? { readdir: deps.readdir } : {}),
    ...(deps.run ? { run: deps.run } : {}),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
    now: ctx.now,
    log: ctx.log,
  });
  const data: ToolArgs = {
    platform: facts(platform),
    project: project.key,
    taskFile: staged.taskFile,
    promptFile: staged.promptFile,
    copied: staged.copied,
    opened: staged.opened,
    delivered: false,
  };
  if (!staged.opened) {
    return {
      outcome: "failed",
      summary: `${platform.spec.label} would not open`,
      detail: `the task is written to ${staged.taskFile}`,
      error: staged.problem ?? "the editor did not start",
      data,
    };
  }
  return {
    outcome: "unconfirmed",
    summary: staged.copied
      ? `opened ${platform.spec.label} on ${project.name}; the task is on the clipboard, paste it into the agent panel`
      : `opened ${platform.spec.label} on ${project.name} with the task in a tab; it has no command line for a prompt`,
    detail: `${platform.spec.note}. Task written to ${staged.taskFile}.`,
    data,
  };
}

export function codingPlatformTools(deps: CodingPlatformDeps): readonly Tool[] {
  return [listPlatforms(deps), delegateTask(deps)];
}
