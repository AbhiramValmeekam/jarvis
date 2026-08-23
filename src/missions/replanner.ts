/**
 * What to do about a step that did not verify.
 *
 * The orchestrator does not decide this. It hands over the step, the mission so
 * far and the registry, and gets back one of five answers — retry, add steps, ask
 * the user, skip, stop — which keeps "how do we recover" in one readable table
 * instead of spread through the loop.
 *
 * Three rules shape every entry in that table:
 *
 *  - **A remedy must change something.** Re-issuing a call the registry rejected
 *    for its arguments, or re-running a build that failed on the code, produces
 *    the same result and burns a replan doing it. Where a deterministic rule has
 *    no lever, the honest answer is `stop`, and Phase 14's diagnosing replanner is
 *    the thing that gets a lever here — not a retry loop added now.
 *  - **An unknown effect is not retried.** `unconfirmed` and `unchecked` mean the
 *    act may well have happened. Repeating it would be how a mission mutes a
 *    microphone twice or saves a memory twice, so a step whose tool is not
 *    repeatable gets a read-back or a question instead of another attempt.
 *  - **It is bounded, and the bound is checked before the cause.** `maxAttempts`
 *    per step and `maxReplans` per mission are both ceilings a rule cannot argue
 *    its way past, because the failure mode this file could otherwise have is an
 *    always-on process looping on one broken step forever.
 *
 * The cause is read from the step's *recorded* `error` — the same text the report
 * and the UI show. That is deliberate: a diagnosis derived from something the user
 * cannot see would be a diagnosis nobody could check.
 */
import { sanitiseForDisplay } from "../permissions/risk-model.js";
import type { Mission, PlanStep, StepInput } from "./mission-model.js";

/** Why a step did not verify, as one word the report can group by. */
export type Cause =
  | "denied"                // the user turned the step down
  | "tool_missing"          // no tool of that name in this build
  | "bad_arguments"         // the registry rejected the call before it ran
  | "path_refused"          // outside the folders a mission may touch
  | "git_ownership"         // git will not read a repository another account owns
  | "not_a_repository"      // there is no working tree there
  | "dependencies_missing"  // the build cannot find what it imports
  | "missing_script"        // the project has no such npm script
  | "timeout"               // still running when the clock ran out
  | "command_failed"        // a non-zero exit that is about the code
  | "missing_project"       // nothing in the registry answers to that name
  | "ambiguous_project"     // more than one does
  | "needs_words"           // recognised, but under-specified
  | "refused_by_policy"     // a rule said no, and that is not a fault
  | "effect_unknown"        // it may have happened; nothing confirmed it
  | "exhausted"             // the ceiling, whatever the cause was
  | "unknown";

/**
 * Whose words a remedy's `reason` is.
 *
 * Absent is the ordinary case: the sentence was composed in this repository out of the
 * cause, the tool and the step's own recorded error, so it can be checked against them.
 * `"model"` means the sentence is a language model's own diagnosis, quoted through
 * `llm-replanner.ts`. It is still sanitised and still one line, and it is still not the
 * same kind of claim — so the flag travels with it as far as the page, rather than the
 * page presenting a model's prose and a counted fact in the same voice (§43, §52).
 *
 * It marks provenance and grants nothing. No branch anywhere reads it to decide what to
 * run, and a model cannot set it: `LlmReplanner` sets it, about text the model supplied.
 */
export type RemedyVoice = "model";

/**
 * The five answers.
 *
 * `retry` may carry preparatory steps: "install what the lockfile names, then
 * build again" is one remedy and not two, and splitting it would let the retry
 * run before the fix.
 */
export type Remedy =
  | {
      readonly kind: "retry";
      readonly cause: Cause;
      readonly reason: string;
      readonly voice?: RemedyVoice;
      readonly steps: readonly StepInput[];
    }
  | {
      readonly kind: "steps";
      readonly cause: Cause;
      readonly reason: string;
      readonly voice?: RemedyVoice;
      readonly steps: readonly StepInput[];
    }
  | {
      readonly kind: "ask";
      readonly cause: Cause;
      readonly reason: string;
      readonly voice?: RemedyVoice;
      /** Display-safe, and answerable — the user should not have to guess the shape. */
      readonly question: string;
    }
  | {
      readonly kind: "skip";
      readonly cause: Cause;
      readonly reason: string;
      readonly voice?: RemedyVoice;
    }
  | {
      readonly kind: "stop";
      readonly cause: Cause;
      readonly reason: string;
      readonly voice?: RemedyVoice;
    };

export interface ReplanLimits {
  /** Attempts per step, counting the first. 2 means one retry. */
  readonly maxAttempts: number;
  /** Replans per mission, whatever they were spent on. */
  readonly maxReplans: number;
}

export const DEFAULT_REPLAN_LIMITS: ReplanLimits = { maxAttempts: 2, maxReplans: 4 };

export interface ReplanInput {
  readonly mission: Mission;
  readonly step: PlanStep;
  /** Tool names actually registered, so a remedy cannot name one that is absent. */
  readonly tools: readonly string[];
  readonly limits?: ReplanLimits;
}

export interface Replanner {
  replan(input: ReplanInput): Promise<Remedy>;
}

/**
 * Tools a mission may run a second time without acting twice.
 *
 * A fixed table in this repository, like `local-intent.ts`'s effect map and for
 * the same reason: a plan supplies the tool name and must not be able to declare
 * its own call repeatable. `run_command` is on the list because the terminal
 * adapter's allow-list contains nothing that acts outside the project — `npm run
 * build`, `npm test`, `npm ci` — so running one again costs time and changes
 * nothing else. Anything absent from this list is treated as one-shot.
 */
const REPEATABLE: ReadonlySet<string> = new Set([
  "find_project",
  "list_projects",
  "git_status",
  "git_list_commits",
  "git_list_branches",
  "read_file",
  "list_directory",
  "list_memories",
  "search_memory",
  "run_command",
]);

/**
 * Whether a second attempt at this tool is safe.
 *
 * Exported for `LlmReplanner`, which has to hold the same rule: "an unknown effect is
 * not retried" is not a property of the deterministic rules, it is a property of the
 * tools. A model that proposes retrying `delete_memory` is answering a question about
 * effects it cannot see, and this is the one function that says no to it. Reading the
 * same set rather than copying it is deliberate — two lists would drift, and the one
 * that drifted would be the one that repeats a destructive call.
 */
export function isRepeatable(tool: string): boolean {
  return REPEATABLE.has(tool);
}

/**
 * How to find out whether a one-shot step actually took effect.
 *
 * This does not rescue the step: nothing in the mission model lets one step vouch
 * for another, so a `write_memory` that came back `unconfirmed` stays
 * `unverified`. What it buys is a fact in the report — "it is in the store" or "it
 * is not" — which is worth more than a mission that ends unsure having tried
 * nothing.
 */
const READ_BACK: Readonly<Record<string, (step: PlanStep) => StepInput | null>> = {
  write_memory: (step) =>
    typeof step.args.text === "string"
      ? {
          id: `${step.id}-check`,
          title: "Check whether that was saved",
          tool: "search_memory",
          args: { query: step.args.text.slice(0, 200) },
          priority: step.priority + 1,
        }
      : null,
  delete_memory: (step) => ({
    id: `${step.id}-check`,
    title: "Check what is still in memory",
    tool: "list_memories",
    args: {},
    priority: step.priority + 1,
  }),
};

function line(text: string): string {
  return sanitiseForDisplay(text, 200);
}

/**
 * Cause from recorded text, first match wins.
 *
 * Order is load-bearing in one place: a build that cannot find a module also
 * reports an exit code, and `dependencies_missing` is the entry with a fix while
 * `command_failed` is the one without, so the specific test comes first.
 */
const RULES: readonly { readonly cause: Cause; readonly test: RegExp }[] = [
  { cause: "denied", test: /\b(?:declined|denied|deny)\b|turned that down/i },
  { cause: "tool_missing", test: /no tool called/i },
  { cause: "refused_by_policy", test: /not available to a mission|that looks like a (?:secret|password|token|key)/i },
  { cause: "git_ownership", test: /dubious ownership|another account owns it|safe\.directory/i },
  { cause: "not_a_repository", test: /not a git repository/i },
  { cause: "path_refused", test: /is not allowed|outside the|no folders are configured/i },
  { cause: "missing_project", test: /nothing in the registry matches|no project answers/i },
  { cause: "ambiguous_project", test: /projects match/i },
  {
    cause: "dependencies_missing",
    test: /cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|node_modules|is not recognized as|command not found/i,
  },
  { cause: "missing_script", test: /missing script/i },
  { cause: "timeout", test: /timed out|still running after/i },
  {
    cause: "bad_arguments",
    test: /\b(?:is required|must be a|must be one of|is too long|must not be empty|is not in the expected form|has too many entries|must be at (?:least|most))\b/i,
  },
  { cause: "command_failed", test: /exit code/i },
];

export function diagnose(step: PlanStep): Cause {
  const text = (step.error ?? "").trim();
  if (text !== "") {
    for (const rule of RULES) if (rule.test.test(text)) return rule.cause;
    // The intent matcher's own words. It says "did you mean the speakers or the
    // microphone", which is a better question than anything this file could form.
    if (step.tool === "run_local_intent") return "needs_words";
  }
  if (step.outcome === "unconfirmed" || step.outcome === "unchecked") return "effect_unknown";
  return "unknown";
}

/**
 * Stop, or skip.
 *
 * The same dead end reads differently depending on the step: a required step that
 * cannot go on ends the mission, while an optional one is dropped and the rest
 * carries on. Every rule with no lever comes through here rather than deciding
 * that for itself.
 */
function end(step: PlanStep, cause: Cause, reason: string): Remedy {
  return step.optional
    ? { kind: "skip", cause, reason: line(reason) }
    : { kind: "stop", cause, reason: line(reason) };
}

/** The directory a step was pointed at, for a question that has to name one. */
function dirOf(step: PlanStep): string {
  const candidate = step.args.cwd ?? step.args.path ?? step.args.dir;
  return typeof candidate === "string" ? candidate : "that directory";
}

/** `npm ci`, then the same build again — the one deterministic fix in this file. */
function installThenRetry(mission: Mission, step: PlanStep, tools: ReadonlySet<string>): Remedy {
  const cwd = typeof step.args.cwd === "string" ? step.args.cwd : null;
  const id = `${step.id}-install`;
  if (step.tool !== "run_command" || cwd === null || !tools.has("run_command")) {
    return end(step, "dependencies_missing", `${step.title} needs dependencies this build cannot install`);
  }
  if (mission.steps.some((s) => s.id === id)) {
    // Once is a fix; twice is a loop. The lockfile install already ran and the
    // build still cannot resolve what it imports, which is about the project.
    return end(
      step,
      "dependencies_missing",
      "the lockfile install already ran once and the build still cannot find what it imports",
    );
  }
  return {
    kind: "retry",
    cause: "dependencies_missing",
    reason: line("the build cannot find its dependencies, so this installs exactly what the lockfile names and builds again"),
    steps: [
      {
        id,
        title: "Install the dependencies the lockfile names",
        tool: "run_command",
        args: { program: "npm", args: ["ci"], cwd },
        // Below the failed step, so the install runs before the second attempt.
        priority: Math.max(0, step.priority - 5),
      },
    ],
  };
}

function remedyFor(
  cause: Cause,
  mission: Mission,
  step: PlanStep,
  tools: ReadonlySet<string>,
): Remedy {
  const error = (step.error ?? "").trim();
  switch (cause) {
    case "denied":
      // Asking again for something the user just refused is nagging, not planning.
      return { kind: "stop", cause, reason: line("you turned that step down, so the mission stops rather than asking again") };
    case "tool_missing":
      return end(step, cause, `nothing in this build provides ${step.tool}, so there is no second way to try it`);
    case "bad_arguments":
      return end(step, cause, `the call was rejected before it ran — ${error} — and the same arguments would be rejected again`);
    case "refused_by_policy":
      return end(step, cause, `${error} · that is a rule rather than a fault, so there is nothing to retry`);
    case "missing_script":
      return end(step, cause, `that project has no such script — ${error}`);
    case "not_a_repository":
      return end(step, cause, `${dirOf(step)} is not a git repository, so there is no working tree to read`);
    case "command_failed":
      // The exit code came from the code, and nothing this replanner can do
      // changes the code. Phase 14's diagnosis is what reads the output properly.
      return end(step, cause, `${error} · the same command will fail the same way until the project changes`);
    case "dependencies_missing":
      return installThenRetry(mission, step, tools);
    case "path_refused":
      return {
        kind: "ask",
        cause,
        reason: line(`${dirOf(step)} is outside the folders a mission may touch`),
        question: line(`${dirOf(step)} is outside the folders a mission may act in — add it to missionRoots, or point this objective at a project inside them`),
      };
    case "git_ownership":
      return {
        kind: "ask",
        cause,
        reason: line("git will not read a repository another account owns"),
        // The exact command, because it is one line and it is the user's to run.
        question: line(error),
      };
    case "missing_project":
      return {
        kind: "ask",
        cause,
        reason: line(error),
        question: line("I have no project by that name — say which folder it is, or add its parent to the project roots"),
      };
    case "ambiguous_project":
      return {
        kind: "ask",
        cause,
        reason: line(error),
        question: line("more than one project answers to that name — say which one"),
      };
    case "needs_words":
      return { kind: "ask", cause, reason: line(error), question: line(error) };
    case "timeout":
      return REPEATABLE.has(step.tool)
        ? { kind: "retry", cause, reason: line(`${error} · trying it once more`), steps: [] }
        : {
            kind: "ask",
            cause,
            reason: line(error),
            question: line("that step was still running when the clock ran out, and repeating it could act twice — say whether to try again"),
          };
    case "effect_unknown": {
      const readBack = READ_BACK[step.tool]?.(step) ?? null;
      if (readBack !== null && tools.has(readBack.tool)) {
        return {
          kind: "steps",
          cause,
          reason: line("nothing confirmed that took effect, so this reads it back rather than doing it again"),
          steps: [readBack],
        };
      }
      return REPEATABLE.has(step.tool)
        ? { kind: "retry", cause, reason: line("that produced no confirmed reading, and repeating a read is safe"), steps: [] }
        : {
            kind: "ask",
            cause,
            reason: line("it may have taken effect; nothing confirmed it"),
            question: line(`I cannot tell whether ${step.title.toLowerCase()} took effect, and doing it again could do it twice — say whether to try again`),
          };
    }
    case "exhausted":
    case "unknown":
      return end(step, cause, `nothing here says why ${step.title.toLowerCase()} did not work, so I am not going to guess at a fix`);
  }
}

/**
 * The replanner Phase 13 ships.
 *
 * Async because Phase 14's replanner reads the failure with a model and this one
 * has to be substitutable for it — the interface is the point, and an offline
 * build keeps this one as the whole recovery story rather than as a stub.
 */
export class DeterministicReplanner implements Replanner {
  async replan(input: ReplanInput): Promise<Remedy> {
    const limits = input.limits ?? DEFAULT_REPLAN_LIMITS;
    const { mission, step } = input;
    const cause = diagnose(step);

    // The ceilings come first, before any rule gets to propose anything. A rule
    // that could still argue for a retry at the ceiling would not be a ceiling.
    if (mission.replans >= limits.maxReplans) {
      return end(
        step,
        "exhausted",
        `the plan has already changed ${mission.replans} times, which is as far as I will take it without you`,
      );
    }

    const remedy = remedyFor(cause, mission, step, new Set(input.tools));
    if (remedy.kind === "retry" && step.attempt >= limits.maxAttempts) {
      return end(
        step,
        cause,
        `${step.title.toLowerCase()} has already been tried ${step.attempt} time${step.attempt === 1 ? "" : "s"}`,
      );
    }
    return remedy;
  }
}
