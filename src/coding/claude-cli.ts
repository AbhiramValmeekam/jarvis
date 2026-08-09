/**
 * The Claude Code headless contract, as it actually behaves on this machine.
 *
 * Everything here is pure: build an argument list, read a JSON result, decide
 * what it means. The process handling lives in `claude-code-manager.ts`, so the
 * hard part — "did the coding task actually succeed?" — is testable without
 * spawning anything.
 *
 * ## Why this file re-derives the contract instead of trusting the notes
 *
 * `docs/JARVIS_DEMO_ANALYSIS.md` §2.2 recorded a working invocation. Re-probed
 * against the installed CLI (2.1.222), three parts of it are now wrong, and each
 * one fails in a way that would have been easy to miss:
 *
 *   - `--allowedTools ""` is no longer how the built-in set is selected;
 *     `--tools ""` is. The old flag still parses, so nothing complains.
 *   - `--model claude-haiku-4-5-20251001` returned HTTP 503 from the configured
 *     inference gateway: no channel for that model. A pinned model is a hard
 *     dependency on someone else's routing table, so nothing here pins one.
 *   - the prompt still needs the `--` separator, which is the one detail from
 *     the notes that survived.
 *
 * ## The part that matters: success is not what the CLI says it is
 *
 * Two real runs from that probe, both of which a naive caller reads as success:
 *
 *   1. A 503 from the gateway came back as exit code **0**, `subtype:"success"`,
 *      and `is_error:true`. Reading the exit code alone reports a failed turn as
 *      a completed one.
 *   2. A write was declined at a permission prompt that, in headless mode, no
 *      human can answer. The result was exit code 0, `is_error:**false**`,
 *      `terminal_reason:"completed"` — and no file on disk. The model then
 *      *explained* that it had been declined, in prose, which is exactly the
 *      shape of a report that reads as done to a machine and as failed to a
 *      person.
 *
 * So the verdict is assembled from several independent signals — transport,
 * envelope, `is_error`, `api_error_status`, `permission_denials` — and even then
 * it only ever claims `reported`. Whether the code is right is a question for
 * the caller's own verification, which is why `CodingResult` has no `ok` field.
 * `src/permissions/verified-action.ts` explains at length why this project does
 * not let an actor grade its own work; this is the same rule applied to an actor
 * that is itself an agent.
 */

/** The subset of the CLI's JSON result Jarvis relies on. */
export interface ClaudeJson {
  result: string;
  session_id: string;
  is_error: boolean;
  /** Non-null when the API itself failed. `is_error` is true but exit code is 0. */
  api_error_status: number | null;
  /** Tool calls the model tried to make and was refused. */
  permission_denials: readonly { tool_name: string }[];
  total_cost_usd: number;
  num_turns: number;
  duration_ms: number;
  /** `"completed"`, `"api_error"`, and others. Advisory, not authoritative. */
  terminal_reason: string;
}

/**
 * What became of a delegated coding task.
 *
 * Deliberately not a boolean, and deliberately without an `ok`. The vocabulary
 * mirrors `ActionOutcome`:
 *
 *   reported   the CLI ran a turn and claims it did the work. Not verified.
 *   refused    tools were denied, so some or all of the work did not happen.
 *   failed     the turn did not complete: API error, crash, bad JSON.
 *   timed-out  killed at the deadline; the work may be half-done.
 *   cancelled  the user stopped it.
 */
export type CodingStatus =
  | "reported"
  | "refused"
  | "failed"
  | "timed-out"
  | "cancelled";

export interface CodingResult {
  status: CodingStatus;
  /** What the agent said. Untrusted content (§52) — never executed, never parsed for commands. */
  text: string;
  /** Carried forward to continue the conversation. Null when the run never got that far. */
  sessionId: string | null;
  /** Tools the model was refused, deduplicated. Empty unless status is `refused`. */
  denied: readonly string[];
  costUsd: number;
  turns: number;
  tookMs: number;
  /** One sentence for the Activity view. Never claims more than was established. */
  detail: string;
}

export interface BuildArgsOptions {
  prompt: string;
  /** Resume an earlier conversation. A UUID from a previous result. */
  sessionId?: string;
  /**
   * Built-in tools the worker may use, as CLI names (`"Read"`, `"Write"`, `"Edit"`,
   * `"Bash"`). Empty means no tools at all, which is the right setting for a
   * question about code and the wrong one for a change to it.
   */
  tools?: readonly string[];
  /**
   * How tool requests are answered when there is no human at a keyboard.
   *
   * There is no default here on purpose. Leaving it unset gives the CLI's
   * interactive default, under which every tool call is put to a prompt that
   * nobody can answer — and the run then reports `is_error:false` having done
   * nothing. That silent no-op is the single worst failure mode of this
   * integration, so the caller has to say what it means.
   */
  permissionMode: "acceptEdits" | "plan" | "dontAsk";
  /**
   * Model override. Unset means "whatever this installation is configured for",
   * which is the only safe default: the model named in the original notes is
   * unroutable on this machine.
   */
  model?: string;
  /** Hard ceiling on spend for one task. A voice command must not be able to cost real money unbounded. */
  maxBudgetUsd?: number;
  /** Extra prose appended to the system prompt. */
  appendSystemPrompt?: string;
}

/**
 * Assemble the argument list.
 *
 * `--` last, always. Without it a prompt beginning with a dash is read as a
 * flag, and a prompt following a variadic option is swallowed as one of its
 * values — which is how "add error handling to the parser" becomes a tool name.
 */
export function buildArgs(o: BuildArgsOptions): string[] {
  const args = ["-p", "--output-format", "json", "--permission-mode", o.permissionMode];

  // `--tools ""` is meaningful and must survive: it is how a read-only question
  // is asked. `?? []` rather than a truthiness check, so an explicit empty list
  // is not silently upgraded to "all tools".
  args.push("--tools", (o.tools ?? []).join(","));

  if (o.model) args.push("--model", o.model);
  if (o.sessionId) args.push("--resume", o.sessionId);
  if (o.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(o.maxBudgetUsd));
  if (o.appendSystemPrompt) args.push("--append-system-prompt", o.appendSystemPrompt);

  args.push("--", o.prompt);
  return args;
}

/** Fields whose absence means the envelope is not a result at all. */
function hasShape(v: Record<string, unknown>): boolean {
  return typeof v.result === "string" && typeof v.session_id === "string";
}

/**
 * Read the CLI's stdout.
 *
 * Throws on anything that is not a well-formed result. A caller that cannot tell
 * "the model said nothing" from "the CLI printed a stack trace" would report the
 * second as an empty success.
 */
export function parseClaudeJson(stdout: string): ClaudeJson {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) throw new Error("claude produced no output");

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    // The first line only: stdout may hold a long stack trace, and §53 forbids
    // spraying an unbounded child's output into a log that may contain a token.
    throw new Error(`claude did not return JSON: ${trimmed.split("\n")[0]?.slice(0, 120)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("claude returned a non-object result");
  }
  const obj = raw as Record<string, unknown>;
  if (!hasShape(obj)) throw new Error("claude returned JSON without a result field");

  const denials = Array.isArray(obj.permission_denials)
    ? obj.permission_denials.filter(
        (d): d is { tool_name: string } =>
          !!d && typeof d === "object" && typeof (d as { tool_name?: unknown }).tool_name === "string",
      )
    : [];

  return {
    result: obj.result as string,
    session_id: obj.session_id as string,
    is_error: obj.is_error === true,
    api_error_status: typeof obj.api_error_status === "number" ? obj.api_error_status : null,
    permission_denials: denials,
    total_cost_usd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
    num_turns: typeof obj.num_turns === "number" ? obj.num_turns : 0,
    duration_ms: typeof obj.duration_ms === "number" ? obj.duration_ms : 0,
    terminal_reason: typeof obj.terminal_reason === "string" ? obj.terminal_reason : "unknown",
  };
}

/**
 * Turn a parsed result into a verdict.
 *
 * Order is the whole content of this function. `is_error` is checked before
 * denials because an API error means the turn never really ran and a denial list
 * from it would be noise; denials are checked before success because they are
 * the case that reports `is_error:false` while having changed nothing.
 */
export function classifyResult(json: ClaudeJson, tookMs: number): CodingResult {
  const base = {
    text: json.result,
    sessionId: json.session_id,
    costUsd: json.total_cost_usd,
    turns: json.num_turns,
    tookMs,
  };

  if (json.is_error || json.api_error_status !== null) {
    const why =
      json.api_error_status !== null
        ? `API error ${json.api_error_status}`
        : `the run reported an error (${json.terminal_reason})`;
    return { ...base, status: "failed", denied: [], detail: why };
  }

  const denied = [...new Set(json.permission_denials.map((d) => d.tool_name))];
  if (denied.length > 0) {
    // The important sentence in this file. The CLI said `is_error:false`; the
    // work did not happen. Saying "done" here is the lie this whole module is
    // shaped to avoid.
    return {
      ...base,
      status: "refused",
      denied,
      detail: `blocked: ${denied.join(", ")} ${denied.length === 1 ? "was" : "were"} not permitted, so the change may be incomplete`,
    };
  }

  return {
    ...base,
    status: "reported",
    denied: [],
    detail: `the coding agent reports it finished in ${json.num_turns} turn(s); not independently verified`,
  };
}

/**
 * How to describe a result out loud.
 *
 * Voice replies are short and cannot be re-read, so the distinction between
 * "reports it finished" and "finished" has to survive compression to one
 * sentence. `reported` never becomes "done".
 */
export function speakResult(r: CodingResult, task: string): string {
  switch (r.status) {
    case "reported":
      return `Claude Code says it finished ${task}. I have not checked the result yet.`;
    case "refused":
      return `Claude Code was blocked from using ${r.denied.join(" and ")}, so ${task} is probably not finished.`;
    case "failed":
      return `Claude Code could not finish ${task}: ${r.detail}.`;
    case "timed-out":
      return `Claude Code ran out of time on ${task}. Some of the work may be half done.`;
    case "cancelled":
      return `I stopped ${task}.`;
  }
}
