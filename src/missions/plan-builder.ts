/**
 * The deterministic planner: an objective in, a step graph out.
 *
 * This is the planner Phase 13 ships, and it is not a placeholder for the LLM one.
 * §32 asks for a working offline path, and a plan built from patterns has a property
 * a model's plan never will: given the same objective and the same registry, it is
 * the same plan, so the orchestrator, the permission engine and the report can be
 * tested against a known graph. Phase 14 adds `LlmPlanner` behind the same
 * `Planner` interface and this one stays as the fallback and the reference.
 *
 * Two rules it keeps:
 *
 *  - **A step names a tool that exists.** The registry's own list comes in as
 *    `tools`, and a recipe whose tool is not registered is dropped rather than
 *    planned — a mission that plans `run_command` on a build with no terminal
 *    adapter would fail at execution having promised something it could not do.
 *  - **Binding happens now.** `findProject` resolves the project at plan time, so
 *    the steps carry a real directory and the plan the user reads is the plan that
 *    will run. Nothing is filled in later from a previous step's output.
 *
 * When no recipe matches, the result is an empty plan with a reason — which the
 * mission model turns into `plan_empty` → `failed`. Saying "I don't have a plan for
 * that" is the honest answer for a planner that is a table of patterns; inventing
 * steps that look plausible is the failure mode §43 is about.
 */
import { findProject, type ProjectEntry } from "../context/project-registry.js";
import { routeUtterance } from "../local-intents/intent-model.js";
import { sanitiseForDisplay } from "../permissions/risk-model.js";
import type { StepInput } from "./mission-model.js";

export interface PlannerInput {
  readonly objective: string;
  /** The registry, so a project name becomes a directory here and not later. */
  readonly projects: readonly ProjectEntry[];
  /** Tool names actually registered in this runtime. */
  readonly tools: readonly string[];
}

export interface PlanResult {
  readonly steps: readonly StepInput[];
  readonly planner: "deterministic" | "llm";
  /** Why this plan, or why there is none. Display-safe, and always present. */
  readonly note: string;
}

export interface Planner {
  plan(input: PlannerInput): Promise<PlanResult>;
}

/** Words that mean "tell me whether this works". */
const READINESS = /\b(?:ready|build|builds|compile|compiles|typecheck|type check|test|tests|verify|working|works|broken)\b/;

/** Words that mean "tell me what state this is in". */
const INSPECTION = /\b(?:status|dirty|changed|changes|uncommitted|commits?|branch|branches|recent|log)\b/;

/** Words that mean the whole set rather than one of them. */
const EVERYTHING = /\b(?:projects|repos|repositories|everything|all of them)\b/;

function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim()} `;
}

/**
 * Which project this objective is about.
 *
 * Aliases come from the registry, so the match is against names the user's own
 * folders produced. `findProject` then does the deciding, which is what keeps one
 * word meaning two projects an *ambiguity* here rather than a coin toss.
 */
function projectFor(
  objective: string,
  projects: readonly ProjectEntry[],
): { readonly project: ProjectEntry; readonly alias: string } | { readonly ambiguous: string } | null {
  const text = normalise(objective);
  const aliases = projects
    .flatMap((p) => [p.key, ...p.aliases])
    .filter((alias) => alias.length > 2 && text.includes(` ${alias.toLowerCase()} `))
    // Longest first: "my portfolio site" should try `portfolio site` before `site`.
    .sort((a, b) => b.length - a.length);

  for (const alias of aliases) {
    const lookup = findProject(alias, projects);
    if (lookup.kind === "one") return { project: lookup.project, alias };
    if (lookup.kind === "ambiguous") {
      return {
        ambiguous: `"${alias}" could be ${lookup.candidates.map((c) => c.name).join(" or ")} — say which one`,
      };
    }
  }
  return null;
}

/** A plan with nothing in it, and the reason, which the UI shows verbatim. */
function nothing(note: string): PlanResult {
  return { steps: [], planner: "deterministic", note: sanitiseForDisplay(note, 200) };
}

/**
 * Is this project one npm can be pointed at?
 *
 * `kind` comes from what the scan actually found on disk — a `package.json` makes
 * it `node` — so this is a fact about the project rather than a guess from a name.
 */
function isNode(project: ProjectEntry): boolean {
  return project.kind === "node";
}

/** Steps for "is <project> ready" — the objective the whole phase is shaped around. */
function readinessSteps(
  project: ProjectEntry,
  alias: string,
  tools: ReadonlySet<string>,
): readonly StepInput[] {
  const steps: StepInput[] = [];
  if (tools.has("find_project")) {
    steps.push({
      id: "project",
      title: `Find the ${project.name} project`,
      tool: "find_project",
      args: { name: alias },
      priority: 10,
    });
  }
  if (tools.has("git_status")) {
    steps.push({
      id: "git",
      // Optional on purpose: a project the scan called `node` may not be a git
      // repository at all, and "no repo here" must not fail an objective about
      // whether the build works.
      title: "Read the working tree state",
      tool: "git_status",
      args: { path: project.dir },
      dependsOn: steps.length > 0 ? ["project"] : [],
      priority: 20,
      optional: true,
    });
  }
  if (isNode(project) && tools.has("run_command")) {
    steps.push({
      id: "build",
      title: "Build it",
      tool: "run_command",
      args: { program: "npm", args: ["run", "build"], cwd: project.dir },
      dependsOn: steps.some((s) => s.id === "project") ? ["project"] : [],
      priority: 30,
    });
    steps.push({
      id: "test",
      title: "Run the tests",
      tool: "run_command",
      args: { program: "npm", args: ["test"], cwd: project.dir },
      dependsOn: ["build"],
      priority: 40,
      optional: true,
    });
  }
  return steps;
}

/** Steps for "what state is <project> in" — reads only, so nothing asks. */
function inspectionSteps(
  project: ProjectEntry,
  alias: string,
  tools: ReadonlySet<string>,
): readonly StepInput[] {
  const steps: StepInput[] = [];
  if (tools.has("find_project")) {
    steps.push({
      id: "project",
      title: `Find the ${project.name} project`,
      tool: "find_project",
      args: { name: alias },
      priority: 10,
    });
  }
  const after = steps.length > 0 ? ["project"] : [];
  if (tools.has("git_status")) {
    steps.push({
      id: "git",
      title: "Read the working tree state",
      tool: "git_status",
      args: { path: project.dir },
      dependsOn: after,
      priority: 20,
    });
  }
  if (tools.has("git_list_commits")) {
    steps.push({
      id: "commits",
      title: "Read the recent commits",
      tool: "git_list_commits",
      args: { path: project.dir, count: 5 },
      dependsOn: after,
      priority: 30,
      optional: true,
    });
  }
  return steps;
}

/**
 * The planner.
 *
 * Recipes are tried in order and the first that produces steps wins. Project
 * recipes come before the local-intent one deliberately: "check whether jarvis
 * builds" contains "check", which the intent matcher has no rule for, while "open
 * jarvis" is a local intent and no readiness word appears in it — so the ordering
 * separates the two without either recipe having to know about the other.
 */
export class DeterministicPlanner implements Planner {
  async plan(input: PlannerInput): Promise<PlanResult> {
    const objective = input.objective.trim();
    if (objective.length < 3) return nothing("that objective is too short to act on");

    const tools = new Set(input.tools);
    const text = normalise(objective);
    const found = projectFor(objective, input.projects);

    if (found !== null && "ambiguous" in found) return nothing(found.ambiguous);

    if (found !== null) {
      const { project, alias } = found;
      if (READINESS.test(text)) {
        const steps = readinessSteps(project, alias, tools);
        if (steps.length === 0) {
          return nothing(`I have no tool here that could check ${project.name}`);
        }
        const note = isNode(project)
          ? `checking ${project.name} the way its own scripts do`
          : `${project.name} is a ${project.kind} project, so this reads its state rather than building it`;
        return { steps, planner: "deterministic", note: sanitiseForDisplay(note, 200) };
      }
      if (INSPECTION.test(text)) {
        const steps = inspectionSteps(project, alias, tools);
        if (steps.length === 0) return nothing(`I have no tool here that could read ${project.name}`);
        return {
          steps,
          planner: "deterministic",
          note: sanitiseForDisplay(`reading the state of ${project.name}`, 200),
        };
      }
    }

    // "what am I working on", "list my repos" — the objective is about the set.
    if (EVERYTHING.test(text) && tools.has("list_projects")) {
      return {
        steps: [
          {
            id: "projects",
            title: "List the projects Jarvis knows about",
            tool: "list_projects",
            args: {},
            priority: 10,
          },
        ],
        planner: "deterministic",
        note: sanitiseForDisplay("reading the project registry", 200),
      };
    }

    // One of the 25 built-in intents, asked for in words. `routeUtterance` is the
    // same matcher the conversation path uses, so "open Chrome" plans the step the
    // turn-shaped route would have taken — and the objective text travels as the
    // request, because the adapter re-routes it and classifies the effect itself.
    if (tools.has("run_local_intent")) {
      const routed = routeUtterance(objective);
      if (routed.route === "local") {
        return {
          steps: [
            {
              id: "intent",
              title: `Do that: ${routed.match.id.replace(/[._]/g, " ")}`,
              tool: "run_local_intent",
              args: { request: objective.slice(0, 200) },
              priority: 10,
            },
          ],
          planner: "deterministic",
          note: sanitiseForDisplay(`this is a built-in action (${routed.match.id})`, 200),
        };
      }
      // An ambiguity the matcher already knows how to phrase. Passing its own
      // question through is better than a generic "no plan": the user is one word
      // away from an objective this planner can take.
      if (routed.route === "ask") return nothing(routed.question);
    }

    // The honest ending. §43 is about not inventing work that looks like work, and
    // a table of patterns that met nothing it recognises has exactly one true
    // thing to report — which the mission model turns into `plan_empty` → `failed`.
    if (found !== null) {
      return nothing(
        `I found ${found.project.name}, but nothing in that objective told me what to do with it`,
      );
    }
    return nothing("I have no deterministic plan for that objective");
  }
}
