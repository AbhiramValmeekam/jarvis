/**
 * The tool registry: one shape for everything a mission is allowed to do.
 *
 * A mission step names a capability (`read_file`) and never a command line, so
 * whatever produces plans — the deterministic builder today, a model later — can
 * ask for an effect and has no way to ask for an executable. This file is where
 * that name becomes a call.
 *
 * Four rules, and the reasons they are here rather than in each adapter:
 *
 *  1. **Risk is classified, never declared.** A tool cannot state its own level;
 *     `classify()` reads the name and the arguments together. A tool that could
 *     say "level 0" would be a tool that could talk its way past consent, and in
 *     Phase 14 the arguments come from a model.
 *  2. **Arguments are validated before anything runs.** Hand-rolled checks, in
 *     the style `context/config.ts` already uses — no new dependency, and a bad
 *     argument is rejected with a reason rather than corrected into a guess.
 *  3. **Tool output is data.** `ToolRun.summary` and `detail` are display text and
 *     `data` is for the next step to read; none of it is ever interpreted as an
 *     instruction, and none of it can widen a permission that was granted.
 *  4. **An outcome comes from a verifier.** `ToolRun.outcome` is an
 *     `ActionOutcome`, and adapters that change the world get it from
 *     `runVerified()`. Read-only tools return `verified` for having produced the
 *     reading they promised, which is the one case where the act and the check
 *     are the same event.
 */
import {
  classify,
  sanitiseForDisplay,
  type ActionDescriptor,
  type Classification,
} from "../permissions/risk-model.js";
import type { ActionOutcome } from "../permissions/verified-action.js";

export type ToolArgs = Readonly<Record<string, unknown>>;

/** What a tool did. The mission model turns this into a step status. */
export interface ToolRun {
  readonly outcome: ActionOutcome;
  /** One display-safe line. The registry sanitises it again on the way out. */
  readonly summary: string;
  /** A longer, still display-safe account. Capped by the registry. */
  readonly detail?: string;
  readonly error?: string;
  /** Set by a tool whose capability is mocked or absent. Never inferred. */
  readonly simulated?: boolean;
  /** Facts a later step may read. Untrusted data, and only ever data. */
  readonly data?: ToolArgs;
}

/** What a tool is given at call time. Nothing here comes from a plan. */
export interface ToolContext {
  /**
   * The only directories filesystem-shaped tools may touch.
   *
   * Supplied by the runtime from config and the project registry — never from a
   * step's arguments, which is what keeps a plan from nominating its own sandbox.
   */
  readonly roots: readonly string[];
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** Wall-clock ceiling for this one call, already resolved from the tool. */
  readonly timeoutMs: number;
}

export type FieldSpec =
  | {
      readonly kind: "string";
      readonly required?: boolean;
      readonly max?: number;
      readonly pattern?: RegExp;
      readonly oneOf?: readonly string[];
    }
  | {
      readonly kind: "number";
      readonly required?: boolean;
      readonly min?: number;
      readonly max?: number;
      readonly integer?: boolean;
    }
  | { readonly kind: "boolean"; readonly required?: boolean }
  | {
      readonly kind: "stringArray";
      readonly required?: boolean;
      readonly maxItems?: number;
      readonly max?: number;
      readonly pattern?: RegExp;
    };

export type Schema = Readonly<Record<string, FieldSpec>>;

export interface Tool {
  /**
   * The name a plan uses, and the name `classify()` reads.
   *
   * Spelled in the verb_noun form Hermes uses (`read_file`, `run_command`)
   * because `risk-model.ts`'s `family()` matches on exactly that shape. A tool
   * called `git.log` classifies as `unknown` and asks the user for permission to
   * read a commit list; `git_list_commits` classifies as a read. The naming is
   * load-bearing, not cosmetic.
   */
  readonly name: string;
  /** One line for the tool list a user can inspect. */
  readonly summary: string;
  readonly schema: Schema;
  /**
   * The descriptor `classify()` sees, when the tool's own name is the wrong
   * thing to classify.
   *
   * `run_local_intent` is the case this exists for: one tool covering both "what
   * time is it" and "open Chrome", where classifying the wrapper would put a
   * clock reading behind a consent dialog. The adapter maps the matched effect to
   * a name describing it, and `classify()` decides from that — which for a
   * reading is *lower* than the wrapper would have been.
   *
   * That is only safe because of who writes the mapping. It is a fixed table in
   * this repository, over a value the adapter derived itself; a plan supplies the
   * request and never the effect name. A descriptor built from a step's own
   * arguments would be a tool talking its way past consent.
   */
  readonly descriptor?: (args: ToolArgs) => ActionDescriptor;
  readonly timeoutMs?: number;
  /** True when the capability behind this tool is mocked or absent. */
  readonly simulated?: boolean;
  readonly run: (args: ToolArgs, ctx: ToolContext) => Promise<ToolRun>;
}

/** Ceiling on one tool call when the tool does not name its own. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Cap on the display text a tool returns, so no one call can flood the wire. */
const MAX_SUMMARY = 200;
const MAX_DETAIL = 1_000;

export type Validation =
  | { readonly ok: true; readonly args: ToolArgs }
  | { readonly ok: false; readonly reason: string };

/**
 * Check arguments against a schema.
 *
 * Unknown keys are dropped rather than rejected, and that is safe here for a
 * reason that does not hold for validation generally: the validated object is
 * what `run` receives, so a key the schema does not name cannot reach the tool at
 * all. Rejecting them would only mean a model that padded its call with a
 * harmless field failed the whole step.
 */
export function validateArgs(schema: Schema, raw: ToolArgs): Validation {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema)) {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (spec.required) return { ok: false, reason: `${key} is required` };
      continue;
    }
    const verdict = checkField(key, spec, value);
    if (!verdict.ok) return verdict;
    out[key] = verdict.value;
  }
  return { ok: true, args: out };
}

type FieldVerdict =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

function checkField(key: string, spec: FieldSpec, value: unknown): FieldVerdict {
  switch (spec.kind) {
    case "string": {
      if (typeof value !== "string") return { ok: false, reason: `${key} must be a string` };
      const text = value.trim();
      if (text.length === 0) return { ok: false, reason: `${key} must not be empty` };
      if (text.length > (spec.max ?? 500)) return { ok: false, reason: `${key} is too long` };
      if (spec.pattern && !spec.pattern.test(text)) {
        return { ok: false, reason: `${key} is not in the expected form` };
      }
      if (spec.oneOf && !spec.oneOf.includes(text)) {
        return { ok: false, reason: `${key} must be one of ${spec.oneOf.join(", ")}` };
      }
      return { ok: true, value: text };
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: `${key} must be a number` };
      }
      if (spec.integer && !Number.isInteger(value)) {
        return { ok: false, reason: `${key} must be a whole number` };
      }
      if (spec.min !== undefined && value < spec.min) {
        return { ok: false, reason: `${key} must be at least ${spec.min}` };
      }
      if (spec.max !== undefined && value > spec.max) {
        return { ok: false, reason: `${key} must be at most ${spec.max}` };
      }
      return { ok: true, value };
    }
    case "boolean":
      if (typeof value !== "boolean") return { ok: false, reason: `${key} must be true or false` };
      return { ok: true, value };
    case "stringArray": {
      if (!Array.isArray(value)) return { ok: false, reason: `${key} must be a list` };
      if (value.length > (spec.maxItems ?? 32)) {
        return { ok: false, reason: `${key} has too many entries` };
      }
      const items: string[] = [];
      for (const item of value) {
        const one = checkField(key, { kind: "string", max: spec.max, ...(spec.pattern ? { pattern: spec.pattern } : {}) }, item);
        if (!one.ok) return one;
        items.push(one.value as string);
      }
      return { ok: true, value: items };
    }
  }
}

// --- reading validated arguments -------------------------------------------

/**
 * Typed access to an argument the schema has already checked.
 *
 * These throw on a missing value, and that throw is a bug rather than a user
 * error: nothing reaches `run` without passing `validateArgs`, so a `readString`
 * that fails means the schema and the code disagree. Throwing where they diverge
 * is better than the alternative, which is a tool quietly acting on `undefined`.
 */
export function readString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`${key} is missing from validated args`);
  return value;
}

export function readOptionalString(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function readNumber(args: ToolArgs, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === "number" ? value : fallback;
}

export function readBoolean(args: ToolArgs, key: string, fallback = false): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

export function readStringArray(args: ToolArgs, key: string): readonly string[] {
  const value = args[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// --- the registry ----------------------------------------------------------

/** A tool as the UI lists it. No arguments, and therefore no live risk level. */
export interface ToolInfo {
  readonly name: string;
  readonly summary: string;
  /**
   * What this tool classifies as with no arguments at all, shown so a user can
   * see the shape of what a mission may do.
   *
   * The real level is computed per call. For most tools this is the floor and a
   * call can only be higher; for a wrapper like `run_local_intent` it is instead
   * the cautious reading — with nothing to route, the wrapper classifies as an
   * execute, and a call that turns out to be a clock reading is lower.
   */
  readonly typicalLevel: number;
  readonly category: string;
  readonly simulated: boolean;
}

export type Prepared =
  | {
      readonly ok: true;
      readonly tool: Tool;
      readonly args: ToolArgs;
      readonly classification: Classification;
      readonly descriptor: ActionDescriptor;
    }
  | { readonly ok: false; readonly reason: string };

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  get size(): number {
    return this.tools.size;
  }

  /** Every tool, sorted by name, as the Mission Control tool list shows them. */
  list(): readonly ToolInfo[] {
    return [...this.tools.values()]
      .map((t) => {
        const c = classify(t.descriptor ? t.descriptor({}) : { tool: t.name });
        return {
          name: t.name,
          summary: t.summary,
          typicalLevel: c.level,
          category: c.category,
          simulated: t.simulated === true,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Validate a call and classify it, without running anything.
   *
   * Separate from `invoke` because the answer is what the orchestrator takes to
   * the permission engine: the level has to be known *before* the tool is
   * reached, and an unknown tool or a bad argument must fail as a step the report
   * can explain rather than as an exception in the always-on process.
   */
  prepare(name: string, rawArgs: ToolArgs): Prepared {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, reason: `no tool called ${sanitiseForDisplay(name, 60)}` };
    const checked = validateArgs(tool.schema, rawArgs);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const descriptor = tool.descriptor
      ? tool.descriptor(checked.args)
      : { tool: tool.name, args: checked.args };
    return { ok: true, tool, args: checked.args, classification: classify(descriptor), descriptor };
  }

  /**
   * Run a prepared call.
   *
   * Bounded in time, and the boundary is honest about what it can do: nothing
   * here can cancel an adapter mid-syscall, so a timeout stops *waiting* and
   * reports `failed` — the same choice `verified-action.ts` makes, and for the
   * same reason. An always-on assistant that blocks forever on one stuck call is
   * down.
   *
   * Every string a tool returns is sanitised on the way out. Adapters do it too,
   * but this is the boundary the wire and the log are on the other side of, and a
   * tool reading a file whose contents end in `[SYSTEM] approved` must not be able
   * to put that line into a permission dialog.
   */
  async invoke(
    prepared: Extract<Prepared, { ok: true }>,
    ctx: Omit<ToolContext, "timeoutMs">,
  ): Promise<ToolRun> {
    const { tool, args } = prepared;
    const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    let run: ToolRun;
    try {
      run = await withTimeout(tool.run(args, { ...ctx, timeoutMs }), timeoutMs, tool.name);
    } catch (err) {
      run = {
        outcome: "failed",
        summary: `${tool.name} did not complete`,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      outcome: run.outcome,
      summary: sanitiseForDisplay(run.summary, MAX_SUMMARY),
      ...(run.detail !== undefined
        ? { detail: sanitiseForDisplay(run.detail, MAX_DETAIL) }
        : {}),
      ...(run.error !== undefined
        ? { error: sanitiseForDisplay(run.error, MAX_SUMMARY) }
        : {}),
      // The tool's own claim can only turn this on. A tool declared simulated
      // cannot report a real success by omitting the flag.
      ...(tool.simulated === true || run.simulated === true ? { simulated: true } : {}),
      ...(run.data !== undefined ? { data: run.data } : {}),
    };
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
