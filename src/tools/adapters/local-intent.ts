/**
 * `run_local_intent` — the twenty-six built-in actions, as one mission tool.
 *
 * Nothing here is new capability. `local-intents/` already matches an utterance to
 * an intent and executes it, with device read-backs, its own consent gates and a
 * rule it states plainly: never report success it cannot confirm. This file is the
 * seam that lets a *plan step* reach that, and it adds exactly two things.
 *
 * **A per-call risk classification.** One tool covers "what time is it" and "open
 * Chrome". Classifying the wrapper would put a clock reading behind a consent
 * dialog; classifying nothing would let a launch through as a read. So the matched
 * intent is mapped through `EFFECTS` below to a name that describes the *effect*,
 * and `classify()` decides from that. The table is fixed code in this repository —
 * a step supplies the request, never the effect name.
 *
 * **An honest outcome.** `ExecOutcome.ok` is a claim, and for most of these
 * intents it is a claim the executor earned by reading the device back afterwards
 * (`volumeMute` refuses to announce a mute that did not take). Where it did not —
 * `lock` fires `LockWorkStation` and returns, because a locked session is not
 * something the process that locked it can go and check — the outcome is
 * `unconfirmed`, which is a first-class answer here and not a failure.
 */
import {
  routeUtterance,
  type IntentContext,
  type IntentMatch,
  type LocalIntentId,
} from "../../local-intents/intent-model.js";
import { execute, type ExecOutcome, type ExecutorDeps } from "../../local-intents/executors.js";
import {
  readString,
  type Tool,
  type ToolArgs,
  type ToolContext,
  type ToolRun,
} from "../registry.js";

export interface LocalIntentDeps {
  /** Everything the executors touch the machine through. Built by the runtime. */
  readonly executorDeps: ExecutorDeps;
  /**
   * The matcher's catalogs, read at call time — a project cloned after boot should
   * be findable on the next step, not the next restart.
   */
  readonly intentContext?: () => IntentContext;
  /** Injected by tests, so no test mutes a real microphone. */
  readonly execute?: (match: IntentMatch, deps: ExecutorDeps) => Promise<ExecOutcome>;
}

/**
 * What an intent does, said in the shape `classify()` reads.
 *
 * Three things to know about the names on the right.
 *
 * They are chosen for the effect and not for the level they produce. `screen.read`
 * photographs the display, so it is not called `read_screen` — that would match the
 * read family and come back level 0, which for a camera would be a lie told through
 * a naming convention.
 *
 * Where `risk-model.ts` has no family for something — muting speakers, locking the
 * machine, starting an app — the name falls through to the fail-closed default,
 * level 3, and the step asks. That is over-cautious for volume and exactly right
 * for the rest; a `device-control` category belongs in the risk model rather than
 * in a name picked here to dodge the dialog.
 *
 * `confirms` records who checked. `self` means the executor observes the effect
 * afterwards, or the reading *is* the effect. `claim` means it fired and returned.
 */
interface Effect {
  readonly tool: string;
  readonly confirms: "self" | "claim";
  /** Set when the intent exists but cannot be a mission step, with the reason. */
  readonly unavailable?: string;
}

const EFFECTS: Readonly<Record<LocalIntentId, Effect>> = {
  "time.now": { tool: "read_clock", confirms: "self" },
  "date.today": { tool: "read_date", confirms: "self" },
  "volume.set": { tool: "set_speaker_volume", confirms: "self" },
  "volume.up": { tool: "set_speaker_volume", confirms: "self" },
  "volume.down": { tool: "set_speaker_volume", confirms: "self" },
  "volume.mute": { tool: "set_speaker_mute", confirms: "self" },
  "volume.unmute": { tool: "set_speaker_mute", confirms: "self" },
  "mic.mute": { tool: "set_microphone_mute", confirms: "self" },
  "mic.unmute": { tool: "set_microphone_mute", confirms: "self" },
  screenshot: { tool: "capture_screenshot", confirms: "self" },
  lock: { tool: "lock_workstation", confirms: "claim" },
  battery: { tool: "read_battery", confirms: "self" },
  resources: { tool: "read_system_load", confirms: "self" },
  "app.launch": { tool: "start_application", confirms: "self" },
  "web.open": { tool: "open_url_in_browser", confirms: "self" },
  "media.play": { tool: "open_url_in_browser", confirms: "self" },
  "project.list": { tool: "list_projects", confirms: "self" },
  "project.open": { tool: "start_editor_for_project", confirms: "self" },
  "window.active": { tool: "read_active_window", confirms: "self" },
  "screen.read": {
    tool: "capture_screen_for_agent",
    confirms: "self",
    unavailable:
      "reading the screen hands an image to an agent turn, and a mission step has no agent session to hand it to",
  },
  "memory.remember": { tool: "write_memory", confirms: "self" },
  "memory.recall": { tool: "read_memory", confirms: "self" },
  "memory.forget": { tool: "delete_memory", confirms: "self" },
  "memory.list": { tool: "list_memories", confirms: "self" },
  "skills.list": { tool: "list_skills", confirms: "self" },
  "tasks.list": { tool: "list_scheduled_tasks", confirms: "self" },
  "mcp.list": { tool: "list_mcp_servers", confirms: "self" },
};

/** The request as it reached the matcher, for the classifier and the log. */
function requestOf(args: ToolArgs): string {
  return typeof args.request === "string" ? args.request : "";
}

export function localIntentTools(deps: LocalIntentDeps): readonly Tool[] {
  const run = deps.execute ?? execute;
  const context = (): IntentContext => deps.intentContext?.() ?? {};

  const tool: Tool = {
    name: "run_local_intent",
    summary: "Do one of Jarvis' built-in actions, asked for in plain words",
    schema: { request: { kind: "string", required: true, max: 200 } },
    /**
     * Route first, classify the effect that routing found.
     *
     * `routeUtterance` is a pure matcher over a table of patterns — no I/O, no
     * clock — so calling it here, before the permission engine, costs nothing and
     * cannot have a side effect. An utterance that routes nowhere classifies as
     * the wrapper's own name, which lands in the execute family and asks.
     */
    descriptor: (args: ToolArgs) => {
      const request = requestOf(args);
      const routed = request === "" ? null : routeUtterance(request, context());
      const effect = routed?.route === "local" ? EFFECTS[routed.match.id] : undefined;
      return { tool: effect?.tool ?? "run_local_intent", args: { request } };
    },
    async run(args: ToolArgs, _ctx: ToolContext): Promise<ToolRun> {
      const request = readString(args, "request");
      const routed = routeUtterance(request, context());
      if (routed.route === "ask") {
        // The matcher found more than one reading and will not guess. A step
        // cannot answer a question, so this fails with the question in it — the
        // replanner's job is to turn that into a step that asks the user.
        return { outcome: "failed", summary: "that could mean two things", error: routed.question };
      }
      if (routed.route === "agent") {
        return {
          outcome: "failed",
          summary: "no built-in action matches that",
          error: routed.reason,
        };
      }

      const match = routed.match;
      const effect = EFFECTS[match.id];
      if (effect.unavailable !== undefined) {
        return { outcome: "failed", summary: `${match.id} is not available here`, error: effect.unavailable };
      }

      const outcome = await run(match, deps.executorDeps);
      if (!outcome.ok) {
        return {
          outcome: "failed",
          summary: outcome.speech,
          ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
          error: outcome.detail ?? outcome.speech,
          data: { intent: match.id },
        };
      }
      return {
        // `claim` is the one place this tool cannot say "verified". The executor
        // did what it was asked and nothing looked afterwards, so the outcome says
        // so rather than rounding it up.
        outcome: effect.confirms === "self" ? "verified" : "unconfirmed",
        summary: outcome.speech,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        // `handoff` is deliberately dropped: it is image bytes, and this returns
        // facts a later step may read.
        data: {
          intent: match.id,
          spoken: outcome.speech,
          ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        },
      };
    },
  };

  return [tool];
}
