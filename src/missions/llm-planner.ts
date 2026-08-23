/**
 * The planner that asks a model, and the validation that makes that safe.
 *
 * `DeterministicPlanner` is a table of recipes: it plans readiness checks and
 * inspections and the 25 built-in intents, and it plans nothing else. This one takes
 * the objective a table has no row for. That is the whole reason the LLM layer exists.
 *
 * Everything else in this file is the answer to a single question: what do you do with
 * a step graph proposed by something that can be confidently wrong? The rules, in the
 * order they matter:
 *
 *  1. **A step names a tool that exists, or it is dropped.** `PlannerInput.tools` is
 *     the set actually registered on this machine, and a model that proposes
 *     `send_email` on a Jarvis with no mail adapter has proposed nothing (§43: a
 *     capability absent is a capability not registered). The step goes; the plan
 *     continues without it.
 *  2. **Arguments are shape-checked here and validated again later.** This file only
 *     insists they are a flat object of primitives. `ToolRegistry.prepare` is what
 *     decides whether they are *valid*, and `classify()` decides what they cost — so a
 *     model cannot lower a step's risk by describing it nicely, and cannot reach
 *     outside the mission roots by proposing a path, because `ToolContext.roots` comes
 *     from the runtime and never from a step.
 *  3. **`dependsOn` may only point backwards.** Dependencies are resolved against the
 *     steps already accepted, which makes a cycle unrepresentable rather than
 *     detectable. A step whose dependency was dropped is dropped too: its precondition
 *     is gone, and running it anyway is how "check the build" runs before "install".
 *  4. **`planner: "llm"` is a claim, so it is only made when true.** Provider down,
 *     no JSON, JSON with no usable step, an answer cut off at `max_tokens` — every one
 *     of those falls back to the deterministic planner and says `"deterministic"` on
 *     the wire. The UI's planner badge is load-bearing (§32) and this is where it stops
 *     being a decoration.
 *  5. **The model's prose does not reach the note.** The note is built here from
 *     counted facts. Sanitising the model's own summary and showing it would be safe
 *     from injection and still be a sentence nobody verified.
 *
 * The model never sees a key, a grant, or a path outside what the objective and the
 * project registry already contain, and nothing it returns becomes an instruction —
 * it becomes at most a *proposal* for a step, which then goes through consent like any
 * other (§52).
 */
import { extractJson, LLMUnavailableError, type LLMProvider } from "../llm/provider.js";
import { sanitiseForDisplay } from "../permissions/risk-model.js";
import type { Schema, ToolRegistry } from "../tools/registry.js";
import type { StepInput } from "./mission-model.js";
import { DeterministicPlanner, type Planner, type PlannerInput, type PlanResult } from "./plan-builder.js";

/**
 * Ceiling on how many steps a model may propose.
 *
 * Lower than `maxMissionSteps` (24) on purpose: the mission budget has to leave room
 * for the replanner's corrective steps, and a plan that arrives already at the limit
 * cannot be recovered from. Extra steps are dropped from the end rather than the plan
 * being rejected — the first ten steps of a twenty-step plan are still a plan.
 */
export const MAX_LLM_STEPS = 12;

const MAX_ARGS_PER_STEP = 12;
const MAX_ARG_STRING = 500;
const MAX_ARG_ITEMS = 20;
const MAX_TITLE = 120;

/** Step ids: slug-shaped, because they appear in `dependsOn` and in the UI. */
const ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface LlmPlannerOptions {
  readonly provider: LLMProvider;
  /** Used whenever the model cannot be trusted to have planned. Defaults to the table. */
  readonly fallback?: Planner;
  /**
   * Read for tool summaries and argument schemas.
   *
   * Optional because the planner is testable without one: with no registry the prompt
   * lists bare tool names, which is worse guidance but not a different contract.
   */
  readonly registry?: ToolRegistry;
  readonly maxSteps?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
}

/** One line per field: `path: string (required)`. Enough to fill args in, no more. */
function describeSchema(schema: Schema): string {
  const parts: string[] = [];
  for (const [key, spec] of Object.entries(schema)) {
    const bits: string[] = [spec.kind];
    if (spec.required === true) bits.push("required");
    if (spec.kind === "string" && spec.oneOf !== undefined) bits.push(`one of ${spec.oneOf.join("|")}`);
    parts.push(`${key}: ${bits.join(", ")}`);
  }
  return parts.length === 0 ? "no arguments" : parts.join("; ");
}

/**
 * The tool list the model plans against.
 *
 * Built from `input.tools` — the names actually registered — rather than from the
 * registry's own list, so the prompt cannot advertise a tool the validator will then
 * reject. Same set, one source.
 */
function toolLines(input: PlannerInput, registry: ToolRegistry | undefined): string {
  const lines: string[] = [];
  for (const name of input.tools) {
    const tool = registry?.get(name);
    if (tool === undefined) {
      lines.push(`- ${name}`);
      continue;
    }
    lines.push(`- ${name} — ${tool.summary} [${describeSchema(tool.schema)}]`);
  }
  return lines.join("\n");
}

/** The projects, so a step can name a real root instead of inventing one. */
function projectLines(input: PlannerInput): string {
  if (input.projects.length === 0) return "(none registered)";
  return input.projects
    .slice(0, 20)
    .map((project) => `- ${project.name} (${project.kind}) at ${project.dir}`)
    .join("\n");
}

/**
 * The instructions, which are not the task.
 *
 * Sent as the provider's system field so the objective arrives separately and labelled.
 * That separation is the same one `memory-prompt.ts` makes for stored memories, for the
 * same reason: text a user typed is data to plan *about*, and a model that reads it as
 * instructions is a model that can be told to plan something else.
 */
const SYSTEM = `You plan work for Jarvis, an assistant that runs steps on a Windows machine.

Answer with one JSON object and nothing else. No prose, no markdown fence.

{"steps": [{"id": "slug", "title": "what this does, one line", "tool": "tool_name",
            "args": {}, "dependsOn": ["earlier-slug"], "priority": 10, "optional": false}]}

Rules:
- Use only the tools listed. A tool that is not listed does not exist here.
- ids are lowercase slugs, unique, and "dependsOn" may only name steps listed before it.
- Order the work with "priority" (lower runs first) and "dependsOn" for real prerequisites.
- Mark a step "optional": true when the objective still succeeds without it.
- Prefer reading and verifying over changing. Every step that changes something will be
  shown to the user for approval, so a plan of ten write steps is a plan they will reject.
- Do not invent paths. Use the project directories given below.
- If the objective cannot be planned with these tools, answer
  {"steps": [], "question": "the one thing you need the user to tell you"}.`;

function buildPrompt(input: PlannerInput, registry: ToolRegistry | undefined, maxSteps: number): string {
  return [
    `Objective (from the user):\n${input.objective}`,
    ``,
    `Tools available:\n${toolLines(input, registry)}`,
    ``,
    `Projects Jarvis knows about:\n${projectLines(input)}`,
    ``,
    `Plan at most ${maxSteps} steps.`,
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Check The Build` → `check-the-build`. Returns "" when nothing usable is left. */
function slug(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const out = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return ID_SHAPE.test(out) ? out : "";
}

/**
 * Arguments, flattened to what a `Schema` can describe.
 *
 * Nested objects and arrays of objects are dropped rather than serialised: no tool has
 * a field for one, so a model that sent one has misunderstood the schema, and turning
 * it into a string would hand a validator something that passes as text and means
 * nothing. Strings are capped here as well as in the registry — a 2 MB argument is a
 * problem before it reaches validation.
 */
function plainArgs(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(raw)) return out;
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= MAX_ARGS_PER_STEP) break;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(key)) continue;
    if (typeof value === "string") {
      out[key] = value.slice(0, MAX_ARG_STRING);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      out[key] = (value as readonly string[]).slice(0, MAX_ARG_ITEMS).map((item) => item.slice(0, MAX_ARG_STRING));
    } else {
      continue;
    }
    count++;
  }
  return out;
}

function priorityOf(raw: unknown, index: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 10_000) {
    return Math.round(raw);
  }
  // Position, spaced the way the deterministic recipes space theirs, so a model that
  // omitted priorities still gets the order it wrote them in.
  return (index + 1) * 10;
}

export interface CoercedPlan {
  readonly steps: readonly StepInput[];
  /** The model's question, when it said it could not plan. Display-safe. */
  readonly question: string | null;
  /** What was thrown away and why, for the log. Never shown as the plan's note. */
  readonly dropped: readonly string[];
}

/**
 * A model's answer, turned into steps or into nothing.
 *
 * Exported because this — not the prompt — is the part worth testing exhaustively: a
 * plan naming a tool that does not exist, an id that repeats, a dependency pointing
 * forwards, arguments nested three deep. Each of those has a test, and each of them
 * ends with a plan that is smaller rather than a mission that is wrong.
 */
export function coercePlan(
  payload: unknown,
  allowed: ReadonlySet<string>,
  maxSteps: number,
  /**
   * Step ids that already exist and may be depended on.
   *
   * Empty for a fresh plan — the first step of a mission has nothing to wait for. The
   * replanner passes the mission's current step ids, so a repair step may legitimately
   * say "after the install that is already in the plan" without being dropped as a
   * forward reference.
   */
  known: ReadonlySet<string> = new Set(),
): CoercedPlan {
  const dropped: string[] = [];
  if (!isRecord(payload)) return { steps: [], question: null, dropped: ["the answer was not a JSON object"] };

  const rawQuestion = payload.question;
  const question =
    typeof rawQuestion === "string" && rawQuestion.trim() !== "" ? sanitiseForDisplay(rawQuestion, 200) : null;

  const rawSteps = payload.steps;
  if (!Array.isArray(rawSteps)) {
    return { steps: [], question, dropped: ["the answer had no steps array"] };
  }

  const steps: StepInput[] = [];
  const accepted = new Set<string>();
  const seenTitles = new Set<string>();

  for (const [index, raw] of rawSteps.entries()) {
    if (steps.length >= maxSteps) {
      dropped.push(`${rawSteps.length - steps.length} step(s) past the ${maxSteps}-step limit`);
      break;
    }
    if (!isRecord(raw)) {
      dropped.push(`step ${index + 1} was not an object`);
      continue;
    }

    const tool = typeof raw.tool === "string" ? raw.tool.trim() : "";
    if (tool === "" || !allowed.has(tool)) {
      // The §43 case, and the most likely one: a model naming a capability this
      // machine does not have. Named in the log so the gap is visible to whoever
      // decides which adapter to write next.
      dropped.push(`step ${index + 1} named ${tool === "" ? "no tool" : `an unregistered tool (${tool})`}`);
      continue;
    }

    let id = slug(raw.id) || slug(raw.title) || `step-${index + 1}`;
    if (accepted.has(id)) {
      const unique = `${id}-${index + 1}`;
      dropped.push(`step ${index + 1} repeated the id ${id}; renamed to ${unique}`);
      id = unique;
      if (accepted.has(id)) continue;
    }

    const dependsOn: string[] = [];
    let brokenDependency = false;
    if (Array.isArray(raw.dependsOn)) {
      for (const dep of raw.dependsOn) {
        const wanted = slug(dep);
        if (wanted === "") continue;
        if (accepted.has(wanted)) {
          if (!dependsOn.includes(wanted)) dependsOn.push(wanted);
        } else if (known.has(wanted)) {
          if (!dependsOn.includes(wanted)) dependsOn.push(wanted);
        } else {
          // Either a forward reference (a cycle waiting to happen) or a dependency
          // that was itself dropped. Both mean this step's precondition is not in the
          // plan, so the step goes with it.
          brokenDependency = true;
        }
      }
    }
    if (brokenDependency) {
      dropped.push(`step ${index + 1} (${id}) depended on a step that is not in the plan`);
      continue;
    }

    const title = sanitiseForDisplay(typeof raw.title === "string" && raw.title.trim() !== "" ? raw.title : tool, MAX_TITLE);
    // Two steps with the same title read as a UI bug rather than a plan. Keeping the
    // id in the second one is uglier and truthful.
    const shownTitle = seenTitles.has(title) ? `${title} (${id})` : title;
    seenTitles.add(title);

    steps.push({
      id,
      title: shownTitle,
      tool,
      args: plainArgs(raw.args),
      dependsOn,
      priority: priorityOf(raw.priority, index),
      optional: raw.optional === true,
      // Never from the model: `origin` is how the UI tells a plan from a repair, and
      // `simulated` is the registry's to set from the tool that actually ran.
      origin: "plan",
    });
    accepted.add(id);
  }

  return { steps, question, dropped };
}

export class LlmPlanner implements Planner {
  private readonly provider: LLMProvider;
  private readonly fallback: Planner;
  private readonly registry: ToolRegistry | undefined;
  private readonly maxSteps: number;
  private readonly maxTokens: number | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly log: (line: string) => void;

  constructor(options: LlmPlannerOptions) {
    this.provider = options.provider;
    this.fallback = options.fallback ?? new DeterministicPlanner();
    this.registry = options.registry;
    this.maxSteps = Math.max(1, Math.min(options.maxSteps ?? MAX_LLM_STEPS, MAX_LLM_STEPS));
    this.maxTokens = options.maxTokens;
    this.timeoutMs = options.timeoutMs;
    this.log = options.log ?? (() => {});
  }

  async plan(input: PlannerInput): Promise<PlanResult> {
    const objective = input.objective.trim();
    // The deterministic planner's own floor, applied before spending a round trip.
    if (objective.length < 3) return this.fallback.plan(input);

    if (!this.provider.available) {
      this.log(`no model available (${this.provider.health().note}); planning from the table`);
      return this.fallback.plan(input);
    }
    if (input.tools.length === 0) {
      // Nothing to plan *with*. The fallback says this better than a model would.
      return this.fallback.plan(input);
    }

    let text: string;
    let modelName: string;
    try {
      const result = await this.provider.complete({
        prompt: buildPrompt(input, this.registry, this.maxSteps),
        system: SYSTEM,
        ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
        ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
      });
      if (result.stopReason === "max_tokens") {
        // The JSON is cut off. It may even parse — a truncated object with a balanced
        // prefix does — and the steps after the cut are simply absent, which is a plan
        // that is silently missing its verification. Not usable.
        this.log("the model's plan was cut off at the token limit; planning from the table");
        return this.withNote(await this.fallback.plan(input), "the model's plan was cut off, so this is the built-in plan");
      }
      text = result.text;
      modelName = result.model;
    } catch (err) {
      const why = err instanceof LLMUnavailableError || err instanceof Error ? err.message : String(err);
      // Already redacted by the provider. Logged, not shown: the note the user sees
      // says the model was unavailable, which is the part that affects them.
      this.log(`the model could not plan: ${why}`);
      return this.withNote(await this.fallback.plan(input), "the model was unavailable, so this is the built-in plan");
    }

    const coerced = coercePlan(extractJson(text), new Set(input.tools), this.maxSteps);
    for (const line of coerced.dropped) this.log(`dropped from the model's plan: ${line}`);

    if (coerced.steps.length === 0) {
      const fallen = await this.fallback.plan(input);
      // The model's question is only worth showing when the table had nothing either.
      // Otherwise a real plan arrives with a note asking a question it already answered.
      if (fallen.steps.length === 0 && coerced.question !== null) {
        return { steps: [], planner: "llm", note: coerced.question };
      }
      return this.withNote(fallen, "the model proposed nothing I could run, so this is the built-in plan");
    }

    const dropped = coerced.dropped.length;
    return {
      steps: coerced.steps,
      // Earned: these steps came from the model and every one of them names a tool
      // that exists on this machine.
      planner: "llm",
      note: sanitiseForDisplay(
        `${modelName} planned ${coerced.steps.length} step(s)${dropped === 0 ? "" : `; ${dropped} proposal(s) dropped`}`,
        200,
      ),
    };
  }

  /**
   * Re-note a fallback plan without touching its steps or its `planner` field.
   *
   * The deterministic planner's own note explains the *plan*; this prepends why it is
   * the one running. Both matter, and the wire has one field, so they are joined.
   */
  private withNote(result: PlanResult, why: string): PlanResult {
    if (result.steps.length === 0) return result;
    return {
      steps: result.steps,
      planner: result.planner,
      note: sanitiseForDisplay(`${why} — ${result.note}`, 200),
    };
  }
}

