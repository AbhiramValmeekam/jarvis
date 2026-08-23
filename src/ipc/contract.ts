/**
 * IPC contract between the headless Jarvis runtime and any UI attached to it.
 *
 * The runtime is the source of truth and outlives every client. A UI is a
 * *viewer*: it connects, subscribes, and may request actions, but closing it
 * must never affect the runtime (§13 — close window ≠ quit).
 *
 * Transport is a Windows named pipe carrying line-delimited JSON. Every frame
 * is one JSON object on one line.
 *
 * Security: the pipe is authenticated with a per-run token (see
 * `src/ipc/token.ts`). Windows named pipes are reachable by other processes in
 * the same session, so possession of the pipe name alone must not be enough to
 * drive the assistant. Unauthenticated connections may only call `hello`.
 */

/** Bumped when the shape below changes incompatibly. */
export const IPC_PROTOCOL_VERSION = 7;

export function defaultPipeName(): string {
  return "\\\\.\\pipe\\jarvis-runtime";
}

/**
 * The exact phrase `forget_everything` requires.
 *
 * Here rather than in the runtime because both ends need it: the page has to know
 * what to make the user type, and the runtime has to compare against the same
 * string. Two copies of a confirmation phrase is one typo away from a button that
 * can never work — or worse, a check that passes on anything.
 */
export const FORGET_EVERYTHING = "forget everything";

// ---------------------------------------------------------------------------
// Client → runtime
// ---------------------------------------------------------------------------

export type ClientRequest =
  /** First frame on every connection. Carries the auth token. */
  | { id: number; type: "hello"; protocolVersion: number; token: string; client: string }
  /** Full snapshot of runtime state. */
  | { id: number; type: "get_status" }
  /** Send a text prompt (typed input path, not voice). */
  | { id: number; type: "prompt"; text: string }
  /** Cancel the in-flight turn. */
  | { id: number; type: "cancel" }
  /** Voice control. */
  | { id: number; type: "set_listening"; enabled: boolean }
  | { id: number; type: "set_muted"; muted: boolean }
  /** Push-to-talk: hold to speak, no wake word needed. */
  | { id: number; type: "push_to_talk"; down: boolean }
  /** Speak a line aloud. Fails honestly when TTS is unavailable. */
  | { id: number; type: "say"; text: string }
  /** Answer an outstanding permission request. */
  | { id: number; type: "permission_response"; requestId: string; decision: PermissionDecision }
  /**
   * The decisions taken so far, newest last.
   *
   * A pull as well as a push, because the runtime is always on and the HUD is
   * not: by the time a window opens, everything Jarvis allowed or refused today
   * has already happened. An events-only Activity view would open empty and
   * imply nothing had.
   */
  | { id: number; type: "get_activity"; limit?: number }
  /**
   * Delegated coding tasks.
   *
   * Listed and cancellable, because a coding task is the one thing Jarvis starts
   * that outlives the sentence that asked for it. A build the user cannot see or
   * stop is a process running with file-write access and no visible owner.
   */
  | { id: number; type: "get_coding_jobs" }
  | { id: number; type: "cancel_coding_job"; jobId: string }
  /**
   * Hermes' scheduled jobs, and whether they will actually fire.
   *
   * One request rather than two, because the answer to "what's scheduled?" is
   * misleading without the answer to "is the scheduler alive?" — a job list on
   * its own reads as a promise that those jobs will run.
   */
  | { id: number; type: "get_tasks" }
  /**
   * The MCP servers Hermes is configured with.
   *
   * Read-only, and there is no `add_mcp_server` beside it. An MCP entry is a
   * command Hermes will spawn with the user's environment, and Hermes screens
   * those at save time (`hermes_cli/mcp_security.py`, written after entries like
   * these were planted in the wild). A write path over this pipe would be a
   * second way in that skips that screening.
   */
  | { id: number; type: "get_mcp" }
  /**
   * What Jarvis has been asked to remember, what it learned, and what it is only
   * *offering* to remember.
   *
   * Protocol 2 had this read-only, on the grounds that a memory is created by saying
   * "remember that…" and a window that could write one would be a second door past
   * `screenMemory`. Phase 16's Memory page is why that changed, and the resolution is
   * that it is not a second door: every write below lands in the same store method,
   * behind the same screen, and a refusal comes back as a refusal the page shows. A
   * user editing their own memories in a window is doing the thing dictation does,
   * with the advantage of being able to see the text they are fixing.
   */
  | { id: number; type: "get_memory" }
  /**
   * Save one memory, exactly as "remember that…" would.
   *
   * `screenMemory` may refuse this (§53) and the refusal is the response — not a
   * silently redacted memory, which would look saved and read back useless.
   */
  | { id: number; type: "remember"; text: string }
  /** Replace the text of one memory. Screened again; the id and `at` survive. */
  | { id: number; type: "edit_memory"; memoryId: string; text: string }
  /** Forget one memory. Irreversible, and there is nothing behind it. */
  | { id: number; type: "forget_memory"; memoryId: string }
  /** Forget one recorded episode. The mission's own log is untouched. */
  | { id: number; type: "forget_episode"; episodeId: string }
  /**
   * Fill in or clear one profile field.
   *
   * `value` absent means clear. The key must be one of the eight in
   * `memory/profile-store.ts` — an unknown one is a `bad_request`, because the
   * vocabulary is a decision made in advance by a human and not something a caller
   * extends.
   *
   * Anything written here is `stated`: the user typed it. There is no way to write an
   * inferred value over this pipe, and no `inferred` for one to be written as.
   */
  | { id: number; type: "set_profile"; key: string; value?: string }
  /**
   * Accept or decline one thing Jarvis offered to remember.
   *
   * The only path from `proposals.json` into a store, and it is here — on a request
   * the user's own window sent — rather than anywhere a mission can reach. `accept`
   * runs the target store's screen again before it writes.
   */
  | { id: number; type: "resolve_learning"; proposalId: string; decision: "accept" | "reject" }
  /**
   * Turn the memory layer off, or on.
   *
   * Off means off: `Retriever.retrieve` returns nothing before reading a store, so no
   * memory and no profile field reaches a plan or a prompt. Nothing is deleted —
   * this is a switch, and a switch that quietly erased what it hid would be a worse
   * answer to "stop using this" than the honest one.
   *
   * Session-scoped like `set_tool_policy`, and for the same reason: the runtime reads
   * `config.json` once at boot, so a request that rewrote it would leave the file and
   * the running process disagreeing. `memoryEnabled` in the file is what outlives the
   * process, and the view says which is in force.
   */
  | { id: number; type: "set_memory_enabled"; enabled: boolean }
  /**
   * Delete every memory, episode, profile field, pending suggestion and vector.
   *
   * Guarded by a literal phrase rather than a boolean: `confirm` must be exactly
   * `forget everything`. A `true` is one mistyped field away from being sent by
   * accident, and this is the one irreversible bulk delete in the subsystem — a
   * spoken "forget it all" has the same effect and gets the same confirmation.
   */
  | { id: number; type: "forget_everything"; confirm: string }
  /**
   * The installed skills — the honest answer to "what can you do?".
   *
   * Scanned off disk, so it answers with Hermes down. The descriptions are file
   * contents that a hub install can add to, which makes them untrusted (§52); they
   * are sanitised before they ever reach this wire.
   */
  | { id: number; type: "get_skills" }
  /**
   * What Jarvis can see around it, and what it would offer to do about it.
   *
   * Assembled on the way out rather than kept warm: the graph is a join over
   * registries that already exist, and a cached one would be a claim about the
   * machine as it was. Costs a project scan and a foreground-window read.
   *
   * There is no `refresh_world` because there is nothing to refresh — asking is
   * refreshing, and nothing here runs on a timer (see `src/world/proposal-store.ts`).
   */
  | { id: number; type: "get_world" }
  /**
   * Accept or decline one thing Jarvis offered to do.
   *
   * The only door from a suggestion to a mission, and it is here — on a request the
   * user's own window sent — for the same reason `resolve_learning` is: a proactive
   * system that could reach its own accept path is a system that acts on its own
   * conclusions. `accept` runs the objective through exactly the code path a typed one
   * takes, and answers when the mission finishes. `decline` starts nothing and keeps
   * the suggestion from coming back for a month.
   */
  | {
      id: number;
      type: "resolve_proposal";
      proposalId: string;
      decision: "accept" | "decline";
    }
  /**
   * Start a mission: an objective, and nothing about how to reach it.
   *
   * The one write path in this block, and the asymmetry with everything above is
   * the point — a mission is the user stating an outcome, so the outcome is the
   * only thing that crosses. There is no `start_mission_with_plan`: a caller that
   * could hand the runtime a step list could hand it a tool call, and every
   * classification and permission check downstream would then be screening a plan
   * this process did not write.
   */
  | { id: number; type: "start_mission"; objective: string }
  /**
   * Look at the screen once, and come back with an objective to consider.
   *
   * The window's half of "fix this", and it is a *request* in both senses: it asks
   * the runtime to look, and what comes back asks the user a question. Nothing has
   * started when this answers. `VisionProposalView` carries the proposed objective
   * and what the model says it saw, and a page that shows both is showing the user
   * the two things they need to disagree with it.
   *
   * There is deliberately no `accept` beside this and no proposal id to accept: a
   * Start button sends `start_mission` with the objective it was shown, which is the
   * identical path a typed objective takes, through the same planner, the same
   * classification and the same consent. An accept path of its own would be a second
   * door into the mission loop whose entrant came from a screenshot — and the value
   * of this request being read-only is that the most invasive input in the system
   * cannot reach the loop except through a human clicking the same button as always.
   *
   * `ask` is what the user typed next to the button, and it is optional because "fix
   * this" is the whole request most of the time. It reaches the model as fenced data.
   *
   * One capture is spent per call, behind the consent gate `ScreenCapture` owns —
   * which is why this is a request a person makes and never something a timer does.
   */
  | { id: number; type: "propose_from_screen"; ask?: string }
  /** Missions this runtime knows about, newest first. Includes finished ones. */
  | { id: number; type: "get_missions"; limit?: number }
  /** One mission in full, with the report built from its own record. */
  | { id: number; type: "get_mission"; missionId: string }
  /**
   * One mission's account of itself: every line it logged, in order, attributed to a role.
   *
   * Separate from `get_mission` rather than a field on it, for two reasons. A trace is
   * read when somebody asks "what did it actually do", which is not every time a mission
   * is opened, and it is by far the largest thing this protocol carries — folding it into
   * the detail view would put a few hundred lines on the wire behind every click on a
   * history row.
   *
   * What comes back is built from the mission's append-only log and nothing else, so what
   * it cannot contain is a property of the source rather than of this projection: the log
   * has never held a prompt, a completion or a model's reasoning (§43). The one line a model
   * authored — a replan diagnosis — arrives marked, and is a conclusion it published rather
   * than its deliberation.
   */
  | { id: number; type: "get_trace"; missionId: string }
  /**
   * Stop a mission where it is.
   *
   * A cancel is not an error and not a failure: the mission ends `cancelled`, the
   * steps that were verified stay verified, and the report says what it got
   * through. A user must be able to end an autonomous loop without the record
   * pretending it either finished or broke.
   */
  | { id: number; type: "cancel_mission"; missionId: string }
  /**
   * Answer the question a step is waiting on.
   *
   * Separate from `permission_response` because the two are answers to different
   * questions: that one settles a tool call Hermes proposed mid-turn, this one
   * settles a step a mission planned. `deny` is a legal mission outcome — the
   * mission ends `blocked`, which is neither a success nor a crash.
   */
  | {
      id: number;
      type: "approve_step";
      missionId: string;
      stepId: string;
      decision: PermissionDecision;
    }
  /**
   * The tools a mission may choose from, with what each classifies as, and the
   * per-class policy governing them.
   *
   * Read-only, and there is no `invoke_tool` beside it. A renderer that could call
   * a tool directly would be a path to the filesystem and the shell that skipped
   * the mission loop, the classification and the permission engine at once —
   * which is every guard this phase has.
   *
   * The inventory and the policy travel together because they answer one question
   * — what may a mission do here — and two requests could be answered a moment
   * apart, leaving a panel showing a class governed one way beside a tool of that
   * class governed another.
   */
  | { id: number; type: "get_tools" }
  /**
   * Change the policy for one risk class, for this session.
   *
   * Not a write to `config.json`: the runtime reads that file once at boot, and a
   * settings panel that edited it would leave the file and the running engine
   * disagreeing until a restart. So this holds an override in memory, says on the
   * wire that it does (`source: "session"`), and the panel tells the user to write
   * `missionPolicy` in `config.json` for something that outlives the process.
   *
   * `verdict: "default"` drops the override, restoring whatever the file says —
   * which may be nothing, in which case the engine's level rule decides again.
   *
   * This governs *missions*, which is the engine the policy was written for. It
   * cannot reach a `forbidden` classification and `auto` cannot cover level 4; see
   * `permissions/permission-engine.ts` for why neither is negotiable from here.
   */
  | {
      id: number;
      type: "set_tool_policy";
      /** A `RiskCategory`. An unrecognised name is a `bad_request`, not a default. */
      category: string;
      verdict: "auto" | "approval" | "deny" | "default";
    }
  /**
   * The demo scenarios, and honestly which of them will run on this machine (§28).
   *
   * Read-only, and deliberately not a way to start one. There is no `start_demo`
   * beside it: each scenario carries the exact objective it stands for, and the Run
   * button sends that string as `start_mission`, which is the identical path a typed
   * objective takes. A second entry point would be a second place for classification,
   * consent and reporting to diverge — and a demo is the one moment nobody is
   * watching for that.
   *
   * The assessment travels with the catalogue for the reason the tool inventory
   * travels with its policy: "what can Jarvis demonstrate here" is one question, and
   * a judge reading a scenario beside a stale verdict about whether it can run is
   * being told something the runtime no longer believes.
   */
  | { id: number; type: "get_demo" }
  /**
   * Write the demo fixtures under the demo directory and make them reachable by a
   * mission.
   *
   * Takes no path. The root is computed by `demo-workspace.ts` from one environment
   * variable, so nothing on this wire can name a directory for Jarvis to write into
   * — the same rule `ToolContext.roots` follows, and the reason a renderer cannot
   * widen a mission's reach by asking nicely.
   *
   * Idempotent, and that is what makes it useful twice: scenario 2's project is
   * *supposed* to fail to build, so re-preparing is how a judge puts the break back
   * after a mission has fixed it.
   */
  | { id: number; type: "prepare_demo" }
  /**
   * Remove the demo fixtures.
   *
   * Deletes the three directories it created, by name, each checked against the demo
   * root, and only when the marker file it wrote is present. A recursive delete of
   * whatever happens to be under that path would be the unrestricted destructive
   * filesystem access this repository refuses missions — and Jarvis' own housekeeping
   * does not get an exemption from a rule written for its tools.
   */
  | { id: number; type: "reset_demo" }
  /** Lifecycle. `quit` is the only way to stop the runtime. */
  | { id: number; type: "restart_hermes" }
  | { id: number; type: "restart_voice" }
  | { id: number; type: "quit" };

export type PermissionDecision = "allow_once" | "allow_always" | "deny";

// ---------------------------------------------------------------------------
// Runtime → client
// ---------------------------------------------------------------------------

export type ServerResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string; code?: IpcErrorCode };

export type IpcErrorCode =
  | "unauthenticated"
  | "bad_request"
  | "unsupported_version"
  | "unavailable"
  | "internal";

/**
 * Unsolicited events pushed to authenticated clients.
 *
 * `unavailable` exists so the UI can honestly show a subsystem as unavailable
 * rather than pretending it works (§4).
 */
export type ServerEvent =
  | { type: "state"; state: string }
  | { type: "status"; status: RuntimeStatus }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "reply_chunk"; text: string }
  | { type: "reply_done"; stopReason: string }
  | { type: "thought"; text: string }
  | { type: "tool_call"; id: string; title: string; status?: string }
  | {
      type: "permission_request";
      requestId: string;
      title: string;
      detail?: string;
      options: string[];
      /**
       * The classified facts behind the question.
       *
       * Optional because a client written against protocol 1 predates them, but
       * without these the dialog is a title and two buttons: "delete every file
       * in Documents" and "open Notepad" would look identical. The UI needs the
       * level to weight the buttons and the paths to name what is at stake.
       *
       * These come from `classify()`, never from anything Hermes supplied — the
       * tool call is untrusted input (§52).
       */
      risk?: {
        level: number;
        category: string;
        /** Capped for the wire; `pathCount` is the true total. */
        paths?: string[];
        /**
         * How many paths the action actually names. Sent separately because
         * `paths` is truncated: showing 12 of 400 without saying so would
         * understate the blast radius at the exact moment it matters most.
         */
        pathCount?: number;
      };
    }
  | { type: "level"; rms: number }
  /** One decision, as it is taken. The same shape `get_activity` returns. */
  | { type: "activity"; entry: ActivityEntry }
  /** A delegated coding task started, or reached its end. */
  | { type: "coding_job"; job: CodingJobView }
  /**
   * Jarvis speaking first.
   *
   * Pushed rather than polled because the whole point of a notification is that
   * nobody asked. The runtime has already applied the level policy and the
   * repeat cooldown before this is sent (`notifications/notifier.ts`), so a
   * client's job is to display it, not to decide whether it deserves display —
   * two clients making that call independently would disagree.
   */
  | { type: "notification"; notification: NotificationView }
  /**
   * A mission's state, whenever it changes.
   *
   * The whole mission travels rather than a delta, because a client that joined
   * halfway through has no earlier version to apply a delta to — and a HUD that is
   * opened while a mission is running is the normal case, not the exception.
   */
  | { type: "mission"; mission: MissionView }
  /** One step reaching a new status. The mission event carries the plan; this is the moment. */
  | { type: "mission_step"; missionId: string; step: MissionStepView }
  /**
   * A line for the mission's activity stream: what the loop just did, in words.
   *
   * Composed by the runtime from the mission's own record — never a model's prose
   * and never a tool's stdout verbatim (§43, §52). The stream is what makes the
   * autonomy visible, so a line in it that no recorded event produced would be the
   * one thing this layer must not do.
   */
  | {
      type: "mission_event";
      missionId: string;
      at: number;
      /**
       * The transition word, when this line is one: `planned`, `step_failed`, …
       *
       * Called `transition` rather than `event` because `event: true` is the
       * frame marker every pushed event carries — a field of that name here would
       * be overwritten by the wrapper on the way out.
       */
      transition?: string;
      note: string;
      /**
       * `"model"` when `note` is a language model's own sentence.
       *
       * Absent on every other line, and that is the ordinary case: notes are composed by
       * the runtime from counted facts, which is what the paragraph above promises. The
       * exception is a replan diagnosis from `llm-replanner.ts`, and rather than let it
       * quietly weaken that promise it is marked here and shown as quoted, so a page can
       * put a model's words and a counted fact in different voices (§43).
       */
      voice?: "model";
    }
  /**
   * Jarvis has something to suggest, and has not done it.
   *
   * Pushed when a suggestion is queued so an open window shows it without polling.
   * Carrying the proposal rather than a count on purpose: a badge that said "1
   * suggestion" would send the user looking for something they cannot judge, and the
   * evidence is the part that makes the suggestion answerable.
   */
  | { type: "proactive"; proposal: ProactiveProposalView }
  /**
   * Jarvis has looked at the screen, and has an objective to propose.
   *
   * Pushed on both doors, so the window shows the same proposal either way. The one
   * that matters is the spoken door: "fix this" said to a microphone produces an
   * offer whose whole content is a sentence Piper reads out, and a user who is at
   * the machine deserves to *see* the objective they are being asked to approve —
   * a misheard word or a model that looked at the wrong window is far easier to
   * catch in text than in speech.
   *
   * A refusal is pushed too, and that is not noise: "I could not see anything that
   * needs doing" and a capture the user denied are both answers, and a window that
   * showed nothing for them would be indistinguishable from one where the button
   * did nothing at all (§4).
   *
   * The picture itself never crosses this pipe, in either direction and in any
   * shape. What was on the screen reaches a client only as the sentence a model
   * wrote about it, redacted and flattened before it left `vision-objective.ts`.
   */
  | { type: "vision_proposal"; proposal: VisionProposalView }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "unavailable"; subsystem: string; reason: string }
  | { type: "log"; line: string };

/**
 * A notification, as a client sees it.
 *
 * The strings are sanitised by the runtime before they get here (§52): a job
 * name is derived from an agent's prompt, and a Windows toast renders outside
 * our window where our own escaping does not reach.
 */
export interface NotificationView {
  /** Identity of the condition, not the moment. Clients may use it to replace. */
  key: string;
  category: string;
  title: string;
  body: string;
  at: number;
}

/**
 * A scheduled job and whether the thing that runs it is alive.
 *
 * A projection of Hermes' ~30-key record, on the `ActivityEntry` principle. The
 * job's `prompt` is deliberately absent — it is the instruction text a future
 * agent turn will execute, and no view here needs it.
 */
export interface TaskView {
  id: string;
  name: string;
  /** Hermes' `schedule_display`, e.g. `every 30m`. */
  schedule: string;
  kind: "once" | "interval" | "cron" | "unknown";
  nextRunAt: number | null;
  lastRunAt: number | null;
  /** `ok` or `error`, or null if it has never run. */
  lastStatus: string | null;
  lastError: string | null;
}

export interface TasksView {
  tasks: TaskView[];
  /**
   * The state of Hermes' cron ticker: `running` / `failing` / `stalled` /
   * `never-run`. There is no standalone cron daemon — the ticker lives inside
   * the gateway — so a job can be perfectly scheduled and never run.
   */
  ticker: string;
  /** True only when jobs exist *and* the ticker is genuinely running. */
  willFire: boolean;
  /** What the user should do about it, naming the exact command (§61). */
  warning?: string;
}

/**
 * One configured MCP server, as the HUD sees it.
 *
 * A projection on the `TaskView` principle, and the omissions are the design.
 * `env` values never travel — only the *names* of the variables, because the
 * values are API keys and Hermes resolves them from `~/.hermes/.env` at spawn
 * time (§53). `url` is origin-only for the same reason: a path or query string
 * on an MCP endpoint is where a token would be.
 */
export interface McpServerView {
  name: string;
  /** `stdio` (a spawned command) or `http` (a remote endpoint). */
  transport: string;
  /** For stdio: the command Hermes will run. Truncated for display. */
  command?: string;
  /** For http: scheme and host only, never the full URL. */
  url?: string;
  /** Names of the environment variables it needs. Never their values. */
  envNames: string[];
  enabled: boolean;
  /** Per-tool allow/block lists, which only `config.yaml` can set. */
  includeTools?: string[];
  excludeTools?: string[];
  /**
   * Why Hermes will refuse to spawn this entry, if it will.
   *
   * Mirrors `hermes_cli/mcp_security.py` so Jarvis can *explain* a refusal, not
   * cause one. Empty for a normal server, which is nearly all of them.
   */
  suspicious: string[];
}

/**
 * One thing Jarvis was told to remember.
 *
 * The whole entry travels, unlike most projections here, because a memory is text
 * the *user* dictated about their own life — there is nothing to withhold from
 * them, and a truncated memory in the one view that lists them would be worse
 * than none. What guarantees it is safe to hold at all is upstream: nothing
 * credential-shaped is ever stored, because `screenMemory` refuses the write
 * rather than redacting it (§53).
 */
export interface MemoryEntryView {
  id: string;
  text: string;
  at: number;
  /** Present only if the text was changed after it was first saved. */
  editedAt?: number;
}

/** One of the eight profile fields, with the label the page shows it under. */
export interface ProfileFieldView {
  key: string;
  label: string;
  hint: string;
  max: number;
  /** Absent when the field is not filled in — which the page must show as empty. */
  value?: string;
  /** `stated` or `confirmed`. There is no third, because nothing is inferred. */
  source?: string;
  at?: number;
}

/**
 * One thing that happened, as the Memory page lists it.
 *
 * `redacted` travels because it changes what the row means: an episode whose detail
 * had something credential-shaped removed is a record with a hole in it, and a page
 * that showed it as complete would be overstating what Jarvis kept.
 */
export interface EpisodeView {
  id: string;
  at: number;
  kind: string;
  title: string;
  outcome: string;
  detail?: string;
  tools?: string[];
  missionId?: string;
  durationMs?: number;
  redacted?: boolean;
}

/**
 * Something Jarvis is *offering* to remember, and has not.
 *
 * `why` is the load-bearing field. A suggestion a user cannot trace is a suggestion
 * they can only guess about, and the whole reason this queue exists rather than a
 * silent write is that the person gets to check the reasoning before it becomes a
 * fact that plans get built on. It is a statement of provenance — which mission, which
 * step — never a model's account of its own thinking (§45).
 */
export interface ProposalView {
  id: string;
  at: number;
  kind: string;
  text: string;
  key?: string;
  why: string;
  missionId?: string;
}

/**
 * How similarity search is actually being done, in words a user can act on.
 *
 * `semantic` is the one that matters and it is why this is on the wire at all: a
 * lexical hash generalises over word forms and typos and knows nothing about meaning,
 * and a page that called that "semantic search" would be claiming a capability the
 * process does not have (§43). The page prints `reason` verbatim.
 */
export interface EmbedderView {
  name: string;
  dims: number;
  semantic: boolean;
  rows: number;
  /** Never a key, and never a URL with credentials in it. */
  reason: string;
}

/**
 * Jarvis' own memory, plus a read-only look at Hermes' separate store.
 *
 * Both are reported because they are genuinely two stores and confusing them is
 * the mistake this view exists to prevent. Jarvis' entries are the ones "remember
 * that…" creates. Hermes keeps its own `MEMORY.md` / `USER.md`, which only an
 * agent turn writes — Jarvis reads their sizes and never their bytes into a
 * window, so the user can see that the other store exists without this process
 * becoming a second writer to a file Hermes locks.
 *
 * Phase 16 adds the other three layers Jarvis keeps — profile, episodes, pending
 * suggestions — and the two facts that make the page honest rather than decorative:
 * whether memory is `enabled` at all, and what `embedder` is behind similarity.
 * Every layer travels in one request because they are read together and shown
 * together; two requests would let the page display a suggestion beside a store that
 * had already accepted it.
 */
export interface MemoryView {
  entries: MemoryEntryView[];
  /** Jarvis' caps, so the view can show headroom rather than a bare count. */
  maxEntries: number;
  /** Characters used against `MAX_TOTAL_CHARS`, which binds before the row count does. */
  chars: number;
  maxChars: number;
  /** False when the user has switched the layer off. Nothing is deleted by that. */
  enabled: boolean;
  /** True when `enabled` is a session override rather than what `config.json` says. */
  enabledIsSession: boolean;
  /** All eight fields, filled or not — the empty ones are half the answer. */
  profile: ProfileFieldView[];
  /** Newest first, and capped for the wire; `episodeCount` is the true total. */
  episodes: EpisodeView[];
  episodeCount: number;
  /** Waiting for the user to accept or decline. Nothing here has been stored. */
  proposals: ProposalView[];
  /** Null when no vector index was constructed at all. */
  embedder: EmbedderView | null;
  /** Hermes' own store: entry counts and byte sizes, never contents. */
  hermes: {
    /** False when memory is simply off — different from an empty file. */
    present: boolean;
    memoryEntries: number;
    userEntries: number;
    bytes: number;
  };
}

/**
 * What every memory write answers with.
 *
 * Two decisions are visible in this shape. First, `memory` is the whole view rather
 * than the row that changed: a page that patched its own list from a success flag
 * would drift from the store the first time a write was partly refused, and a
 * memory list that disagrees with the store is worse than a slower one.
 *
 * Second, a refusal is `saved: false` and not a wire error. `screenMemory`
 * declining a token-shaped sentence is the subsystem doing its job, and rendering
 * that in a page's error slot would tell the user the link had broken. Errors are
 * reserved for malformed requests.
 */
export interface MemoryWriteResult {
  saved: boolean;
  /** Why, in the same words the spoken path would use. Shown verbatim. */
  speech: string;
  memory: MemoryView;
  /** Only on `forget_everything`, and only what was really deleted. */
  counts?: { memories: number; episodes: number; profile: number; proposals: number };
}

/** One installed skill, as the HUD lists it. Descriptions are pre-sanitised (§52). */
export interface SkillView {
  name: string;
  description: string;
  category: string;
  source: "user" | "bundled";
}

/**
 * What Jarvis can actually do, grouped.
 *
 * `categories` travels alongside the list because 100-plus skills is not a thing
 * anyone reads item by item; the grouping is what makes the answer usable, and
 * computing it once here beats every client inventing its own.
 */
export interface SkillsView {
  skills: SkillView[];
  categories: { category: string; count: number }[];
}

export interface McpView {
  servers: McpServerView[];
  /** False when Hermes has no `config.yaml` at all — different from zero servers. */
  configPresent: boolean;
  /**
   * True when the `mcp_servers` block exists but uses YAML this reader does not
   * handle. "I could not tell" and "there are none" are different answers and
   * the UI must not render them the same way.
   */
  unparsed: boolean;
}

/**
 * A decision, for the Activity view.
 *
 * Deliberately not the engine's `AuditEntry`. That type is internal and free to
 * change; this one is a wire contract. The strings are sanitised before they are
 * sent (§52 — the tool name came from a model), and no arguments travel: the
 * Activity view says what was allowed and why, not what was in the payload,
 * because a log that quotes arguments is a log that eventually quotes a secret
 * (§53).
 */
export interface ActivityEntry {
  at: number;
  tool: string;
  level: number;
  category: string;
  verdict: "allow" | "deny";
  reason: string;
  /**
   * What became of it, when Jarvis ran the action itself and checked.
   *
   * Usually absent, and the view must not read that as success. Jarvis grants
   * permission for Hermes' tool calls but does not execute them, so for most
   * entries the honest answer is that the outcome was never verified from here.
   * The four values are `verified` / `unconfirmed` / `failed` / `unchecked`; see
   * `permissions/verified-action.ts` for why "no error" is not one of them.
   */
  outcome?: "verified" | "unconfirmed" | "failed" | "unchecked";
}

/**
 * A delegated coding task, as the HUD sees it.
 *
 * A projection, like `ActivityEntry`, and for a sharper reason: the manager's
 * `CodingResult` carries the agent's full prose reply, which is untrusted content
 * from a process that just read a repository (§52). What crosses the wire is the
 * status, the counted facts, and a sentence Jarvis composed itself.
 *
 * `status` and `check` are two different questions and both are sent. The first
 * is what the coding agent claims; the second is what Jarvis found when it
 * looked. A UI that shows only the first would print "done" over a broken build.
 */
export interface CodingJobView {
  id: string;
  /** What the user asked for, in their words. */
  task: string;
  /** The project directory. A path the user nominated, so it is theirs to see. */
  cwd: string;
  state: "running" | "done";
  startedAt: number;
  /** The agent's own claim: `reported` / `refused` / `failed` / `timed-out` / `cancelled`. */
  status?: "reported" | "refused" | "failed" | "timed-out" | "cancelled";
  /** What Jarvis independently established. Absent while running. */
  check?: {
    outcome: "passed" | "failed" | "none" | "unchecked";
    /** How many files changed. A count, not the diff. */
    changedCount: number;
    command: string | null;
  };
  /** One sentence for the view. Composed by Jarvis, never quoted from the agent. */
  detail?: string;
  costUsd?: number;
}

/**
 * One step of a mission, as a client sees it.
 *
 * A projection, on the `ActivityEntry` principle, and the omission that matters is
 * `args`: the arguments are what a path or a command line lives in, and no view
 * needs them to draw a plan graph. What crosses is what happened — the status, the
 * attempt, the outcome, and one line of detail already sanitised by the layer that
 * recorded it.
 *
 * `status` and `outcome` are both sent because they are different claims. The
 * status is where the step is; the outcome is what `runVerified()` established
 * when it ran. Only `verified` becomes `done`, so a view that showed a green tick
 * for "the tool returned" would be showing something no check supports (§18, §43).
 */
export interface MissionStepView {
  id: string;
  title: string;
  tool: string;
  /**
   * `pending` / `awaiting_approval` / `running` / `done` / `unverified` /
   * `failed` / `skipped` / `cancelled`.
   */
  status: string;
  /** 1 on the first run. Above 1 is a retry, which is how a recovery reads. */
  attempt: number;
  /** `replan` marks a step the replanner added while the mission was running. */
  origin: "plan" | "replan";
  priority: number;
  /** A step whose failure the mission survives. */
  optional: boolean;
  dependsOn: string[];
  /** What the check found: `verified` / `unconfirmed` / `failed` / `unchecked`. */
  outcome?: "verified" | "unconfirmed" | "failed" | "unchecked";
  /** The result or the error, whichever the record holds. One line, sanitised. */
  detail?: string;
  /** True when the capability behind it was mocked or absent. Never hidden (§43). */
  simulated?: boolean;
  startedAt?: number;
  finishedAt?: number;
  /**
   * What this call classified as, when it has been classified.
   *
   * From `classify()`, never from the tool's own claim, and absent until the step
   * is prepared — a level shown before anything computed one would be a guess in
   * the field a user is meant to weigh a decision with.
   */
  risk?: { level: number; category: string };
}

/** Step arithmetic, mirroring the model's `StepCounts`. Counted, never estimated. */
export interface MissionCountsView {
  total: number;
  done: number;
  unverified: number;
  failed: number;
  skipped: number;
  cancelled: number;
  pending: number;
  running: number;
  awaitingApproval: number;
  corrective: number;
  simulated: number;
}

/**
 * One citation retrieval produced. A summary, not the content it came from.
 *
 * `method` is Phase 16's addition and it is not decoration: "found because your
 * memory contains these words" and "found because a lexical vector was nearby" are
 * different strengths of claim, and the retrieval card shows which one it was rather
 * than presenting both as Jarvis having understood the objective (§43).
 */
export interface MissionMemoryView {
  source: "memory" | "project" | "skill" | "window" | "task" | "profile" | "episode";
  summary: string;
  /** `keyword` / `vector` / `both` / `profile` / `recent`. Absent for the older sources. */
  method?: string;
}

/**
 * A mission, as a client sees it.
 *
 * The plan travels whole because the plan graph *is* the view: a client that only
 * received the step it was told about could not draw what is waiting on what.
 */
export interface MissionView {
  id: string;
  objective: string;
  /**
   * `planning` / `retrieving` / `executing` / `verifying` / `replanning` /
   * `waiting_approval` / `completed` / `failed` / `blocked` / `cancelled`.
   */
  state: string;
  /** True for the four states a mission does not come back from. */
  terminal: boolean;
  createdAt: number;
  finishedAt?: number;
  /** `deterministic` or `llm`. A first-class answer either way (§32). */
  planner: string;
  replans: number;
  counts: MissionCountsView;
  steps: MissionStepView[];
  memory: MissionMemoryView[];
  /** Why it stopped, in the mission's own words. Absent while it runs. */
  conclusion?: string;
}

/** One line of a report's list. Already display-safe when it is composed. */
export interface MissionReportEntryView {
  id: string;
  title: string;
  tool: string;
  detail?: string;
  attempt: number;
  simulated?: boolean;
}

/**
 * The §47 report, as a client sees it.
 *
 * Every field is counted or composed from the mission's own steps by
 * `missions/mission-report.ts` — nothing here is prose from a model or text from a
 * tool, which is the only reason a report is safe to read *instead of* watching.
 * `nextAction` is absent rather than invented when the record supports no
 * recommendation.
 */
export interface MissionReportView {
  missionId: string;
  objective: string;
  state: string;
  headline: string;
  /** Null for a running mission the runtime was not asked to time. */
  durationMs: number | null;
  counts: MissionCountsView;
  planner: string;
  replans: number;
  /** Steps that failed and then verified on a later attempt. */
  recovered: MissionReportEntryView[];
  verified: MissionReportEntryView[];
  /** Everything that is not `done`, each with a stated reason. */
  outstanding: MissionReportEntryView[];
  simulated: MissionReportEntryView[];
  tools: { tool: string; attempts: number; verified: number; failed: number; unverified: number }[];
  memory: MissionMemoryView[];
  conclusion?: string;
  nextAction?: string;
}

// ---------------------------------------------------------------------------
// What Jarvis can see, and what it would offer to do about it
// ---------------------------------------------------------------------------

/**
 * One thing in the world, as a client sees it.
 *
 * `source` is on the wire because it is what makes the graph auditable: "project
 * registry" and "foreground window" are different kinds of claim, and a view that
 * showed both as facts about the machine would be flattening the difference between
 * a directory that exists and a title a page chose.
 */
export interface WorldEntityView {
  id: string;
  /** `project` | `app` | `window` | `task` | `mission`. */
  kind: string;
  key: string;
  label: string;
  detail?: string;
  /** The source's own word for its state — a mission's `failed`, a job's `error`. */
  status?: string;
  /** Null when nothing dates it. A project has no timestamp until something happens. */
  at: number | null;
  source: string;
}

/**
 * One connection, and why it is claimed.
 *
 * `basis` is the load-bearing field and it is never optional: an edge is an inference,
 * and an inference a user cannot check is one they can only believe. `steerable` marks
 * the ones derived from text something other than the user chose — a window title, a
 * job name (§52). A UI must show that, because "you are working on X" and "a web page
 * said X" look identical once the reason is dropped.
 */
export interface WorldEdgeView {
  kind: string;
  from: string;
  to: string;
  at: number | null;
  basis: string;
  steerable?: boolean;
}

/**
 * Something Jarvis is offering to do, and has not done.
 *
 * `because` is the same idea as a learning proposal's `why`, in list form: each line
 * names a record — a mission id, a job's reported status, a time — so accepting is a
 * decision the user can make from evidence rather than from trust. It is composed from
 * the world graph, never from a model's account of its own reasoning (§45).
 */
export interface ProactiveProposalView {
  id: string;
  at: number;
  /** Which rule produced it: `left-failing` | `job-failing` | `focused-untouched`. */
  rule: string;
  /** Exactly what would run, worded from the registry rather than from a title. */
  objective: string;
  because: string[];
  /** The entity it is about, so a UI can point at it in the graph. */
  entityId: string;
}

/**
 * What one look at the screen produced: an objective to consider, or a reason there
 * is none.
 *
 * A union rather than a shape with optional halves, because the two outcomes are read
 * by different code: one draws a proposal with a Start button, the other draws a
 * sentence. A flat shape would let a page render a refusal as a proposal with three
 * missing fields, which is exactly the "success state not backed by anything" §43
 * forbids.
 *
 * What is *not* here is the projection worth stating. There is no image and no
 * reference to one — the screenshot is sent to a model and then dropped, and this
 * protocol has no frame that could carry it. There is no proposal id either, because
 * nothing on the runtime side is holding a proposal open to be accepted by id: what
 * a client does with this is show it and, if the user says so, send `start_mission`
 * with the objective, which is a fresh objective as far as the mission layer knows.
 * And a refusal's `note` — the branch name `vision-objective.ts` logs — stays in the
 * log; `refusal` names the branch in one word and `speech` is the sentence a person
 * is owed, so the log line would add a second wording of the same fact on the wire.
 */
export type VisionProposalView =
  | {
      kind: "proposed";
      /** When the look happened, not when the client got it. */
      at: number;
      /** Which door asked: a spoken "fix this", or the button in Mission Control. */
      source: "voice" | "window";
      /** What the model says is on the screen. How a person checks the objective. */
      observed: string;
      /** The proposal. The exact string a Start button sends as `start_mission`. */
      objective: string;
      /** Which model looked, how long it took, and how large the picture was. */
      model: string;
      ms: number;
      bytes: number;
    }
  | {
      kind: "refused";
      at: number;
      source: "voice" | "window";
      /** A `VisionRefusal`: `no-model` | `no-vision` | `no-capture` | … */
      refusal: string;
      /** What Jarvis said, which is what the window shows. Already display-safe. */
      speech: string;
    };

/** `get_world`: the graph, what the user appears to be on, and what is on offer. */
export interface WorldView {
  /** When this was assembled. It is a snapshot, and it says so. */
  at: number;
  entities: WorldEntityView[];
  edges: WorldEdgeView[];
  /** Null when no foreground window could be read. */
  focus: {
    windowId: string;
    appId?: string;
    projectId?: string;
    /** True when the project came out of a title something else chose. */
    steerable: boolean;
  } | null;
  /** True when a cap was hit, so a view can say "and more" rather than imply "all". */
  truncated: boolean;
  proposals: ProactiveProposalView[];
  /**
   * Whether Jarvis may suggest at all, and why it is or is not suggesting.
   *
   * `off` is a configured choice (`proactive: "off"`), and the reason says so in
   * words: a page that showed an empty list either way would make a switched-off
   * feature indistinguishable from a quiet one.
   */
  proactive: { enabled: boolean; reason: string };
  /** One line of counts, as the runtime logs it. Never a claim about meaning. */
  summary: string;
}

/**
 * What `resolve_proposal` answers with.
 *
 * `mission` is present only for an accepted suggestion that actually ran, and it is
 * the same `MissionDetailView` a typed objective produces — because it *is* one. A
 * declined suggestion answers with `resolved: true` and no mission, which is the whole
 * point: the record shows a suggestion that was made and refused, and nothing else
 * happened.
 */
export interface ProposalResult {
  resolved: boolean;
  /** What Jarvis would say about it. Shown verbatim. */
  speech: string;
  world: WorldView;
  mission?: MissionDetailView;
}

/** `get_missions`: the list, plus which of them are running right now. */
export interface MissionsView {
  missions: MissionView[];
  /** Ids of the missions the loop is actually turning. Empty when it costs nothing. */
  running: string[];
}

/** `get_mission`: one mission and the report built from it, in the same answer. */
export interface MissionDetailView {
  mission: MissionView;
  report: MissionReportView;
}

/** One recorded action, as the Agent Trace shows it. */
export interface TraceEntryView {
  /** Position in the whole log, counted before trimming, so a cut middle is visible. */
  seq: number;
  at: number;
  /** The role this line is attributed to. One of the seven `agents/roles.ts` names. */
  role: string;
  /** What happened, composed by the runtime from this line's own fields. */
  action: string;
  /**
   * Why it happened: the line's own recorded note, or a sentence built from its fields.
   *
   * Never a motive and never an inference. When `voice` is set this is a model's sentence
   * about a failure it was shown, and the page renders it as a quotation.
   */
  because: string;
  stepId?: string;
  stepTitle?: string;
  tool?: string;
  /** `verified`, `unconfirmed`, `failed` or `unchecked`, when the line settled a step. */
  outcome?: string;
  attempt?: number;
  /** What the step classified as at that moment — a retry may differ from its first try. */
  risk?: { level: number; category: string };
  voice?: "model";
  simulated?: boolean;
}

/** One of the seven roles, and what it did in this mission. */
export interface TraceRoleView {
  role: string;
  label: string;
  /** What the role is for, so the count beside it can be checked against a claim. */
  purpose: string;
  /** Recorded lines attributed to it. Counted over the whole log, not the shown entries. */
  actions: number;
  engaged: boolean;
}

/**
 * `get_trace`: what one mission did, in order.
 *
 * `lines` and `omitted` are both here because a trace that showed 200 entries of 900
 * without saying so would be the "no silent caps" failure in the one pane whose whole
 * job is to be complete. `gap` is set instead of entries when the log is empty: a
 * mission Jarvis cannot account for says so, rather than having its account
 * reconstructed from the state it ended in (§43).
 */
export interface TraceView {
  missionId: string;
  objective: string;
  state: string;
  entries: TraceEntryView[];
  roles: TraceRoleView[];
  lines: number;
  omitted: number;
  /** Why there is nothing to show, when there is nothing to show. */
  gap?: string;
}

/**
 * One tool a mission may choose, as the tool list shows it.
 *
 * `typicalLevel` is what the tool classifies as with no arguments, not a promise
 * about a call: the real level is computed per invocation from the arguments, and
 * a call can be higher. It is here so a user can see the shape of what a mission
 * is able to do before one runs, which is a different question from what any
 * single step will ask for.
 */
export interface ToolView {
  name: string;
  summary: string;
  typicalLevel: number;
  category: string;
  /**
   * Which agent role this tool belongs to — `research`, `computer`, `coding`, `memory`.
   *
   * A name for a group, and nothing more. It grants nothing, restricts nothing and is
   * not consulted by the permission engine: `category` is still what a policy is written
   * against, and the level beside it is still what the engine will see. The role is here
   * so the tool pane can answer "what kind of thing can Jarvis do" without a user having
   * to infer faculties from twenty-eight tool names (`agents/roles.ts`).
   */
  role: string;
  /** True when this tool stands in for a capability that is mocked or absent (§43). */
  simulated: boolean;
}

/**
 * One risk class and how a mission's steps in it are governed right now (§42).
 *
 * A class, not a tool. The policy is applied to what `classify()` computed from a
 * call's arguments, so `delete` covers every tool that turns out to be deleting
 * something — including one added later, and including a call whose tool name
 * suggested otherwise.
 */
export interface ToolPolicyEntry {
  /** The class exactly as `classify()` names it: `read`, `delete`, `network`, … */
  category: string;
  /**
   * What the engine will do with the next step of this class.
   *
   * `default` means no policy applies and the level rule decides — see
   * `ToolPolicyView.autoAllowUpTo` for what that lets through.
   */
  effective: "auto" | "approval" | "deny" | "default";
  /** Where `effective` came from. `session` is forgotten on restart. */
  source: "session" | "config" | "default";
  /** What `config.json` says, so "default" is a known value and not a mystery. */
  configured: "auto" | "approval" | "deny" | null;
}

/** `get_tools`: the inventory, and the policy that governs it. */
export interface ToolsView {
  tools: ToolView[];
  policy: ToolPolicyEntry[];
  /**
   * The level that runs without asking where the policy is `default`.
   *
   * Sent rather than assumed because the engine takes it as an option: a panel
   * that printed the constant would be describing a different engine than the one
   * deciding.
   */
  autoAllowUpTo: number;
  /**
   * The highest level `auto` can cover.
   *
   * Below the top level on purpose. `auto` is a decision made in advance, and the
   * irreversible actions are the ones nobody remembers permitting — so a level 4
   * step still asks even where the class is set to `auto`, and the panel has to be
   * able to say so rather than promising silence it will not deliver.
   */
  autoCeiling: number;
}

/**
 * Why one demo scenario will not run here.
 *
 * A blocker, not a warning: a scenario with any of these does not get a Run button.
 * The kinds are ordered by how cheaply they are fixed, and the panel shows them in
 * that order, because "press Prepare" and "configure a model in .env" are very
 * different asks to make of someone with a laptop open in front of a judge.
 */
export interface DemoBlockerView {
  /** `workspace` — fixtures absent · `planner` — no model · `tool` — not registered · `busy`. */
  kind: string;
  /** One sentence naming what is missing. Never a hint that it might work anyway. */
  detail: string;
}

/** One §28 scenario, and whether this machine can actually do it. */
export interface DemoScenarioView {
  id: string;
  /** 1–4, so the panel can present them in the order §28 lists them. */
  ordinal: number;
  title: string;
  /**
   * The exact objective the Run button sends as `start_mission`.
   *
   * Sent verbatim and shown verbatim, which is the whole design: a judge reads the
   * string, presses the button, and the same string goes down the same path a typed
   * one takes. Nothing here is a script, and there is no request that runs a
   * scenario by name.
   */
  objective: string;
  /** The master-prompt sections this stands for, e.g. `§28.1`. For the judge. */
  sections: string[];
  /** What to watch for while it runs — plan, memory, failure, replan, report. */
  watch: string;
  /** The stages §28 names for this scenario, in order. Descriptive, never executed. */
  stages: string[];
  /** What this scenario cannot honestly claim to do, or null. Shown before it runs. */
  caveat: string | null;
  runnable: boolean;
  blockers: DemoBlockerView[];
  /** Registered tools this needs whose capability is mocked (§43). Not a blocker. */
  mocked: string[];
  /** Tools this needs that are not registered at all. Each one is a blocker. */
  missing: string[];
}

/** One prepared fixture on disk. */
export interface DemoFixtureView {
  /** `hackathon-site`, `broken-cli` or `inbox`. */
  fixture: string;
  /** How many files are in it. A count, so "prepared" is a number and not a claim. */
  files: number;
  /**
   * Whether its dependencies are installed.
   *
   * The single most load-bearing field in this view. Both node fixtures ship
   * deliberately broken — a dependency the lockfile names and `node_modules` does not
   * have — so `installed: false` is what makes scenario 2's failure real, and seeing
   * it flip to true after a mission ran `npm ci` is the §46 replan arc, on disk.
   */
  installed: boolean;
}

/** `get_demo`: the four scenarios, the workspace they need, and an honest verdict. */
export interface DemoView {
  /** Where the fixtures live. One computed path, never one this wire supplied. */
  root: string;
  /** True when the marker file is there, which `prepare_demo` writes last. */
  prepared: boolean;
  fixtures: DemoFixtureView[];
  scenarios: DemoScenarioView[];
}

export interface SubsystemStatus {
  /** `available` only when the thing genuinely works right now. */
  state: "available" | "unavailable" | "starting" | "degraded";
  detail?: string;
}

export interface RuntimeStatus {
  protocolVersion: number;
  /** Assistant state machine state. */
  state: string;
  startedAt: number;
  hermes: {
    state: string;
    pid: number | null;
    sessionId: string | null;
    restartCount: number;
    gaveUpReason: string | null;
  };
  voice: {
    state: string;
    pid: number | null;
    wakeWord: string | null;
    device: string | null;
    /** True only when audio is genuinely being captured right now. */
    capturing: boolean;
    /**
     * How long the input has been at a level indistinguishable from a dead line,
     * or null/absent when it has been heard from recently.
     *
     * Optional because it is diagnostic rather than structural: `capturing` says
     * the device is open, this says whether anything is coming out of it, and the
     * two disagreed on the machine this was written for.
     */
    silentForMs?: number | null;
    restartCount: number;
    gaveUpReason: string | null;
  };
  subsystems: {
    wakeWord: SubsystemStatus;
    stt: SubsystemStatus;
    tts: SubsystemStatus;
    hermes: SubsystemStatus;
  };
  listening: boolean;
  muted: boolean;
  /**
   * Missions, as a field of their own rather than a state of the assistant.
   *
   * Deliberately outside `state`: that is the conversation state machine, whose
   * window closes after 30 seconds, and a mission has to outlive the sentence that
   * started it. Folding the two together would mean either a mission that ends
   * when the conversation does or a conversation that never closes.
   */
  missions: {
    /** How many are running right now. 0 is the resting state and costs a timer. */
    running: number;
    /** Ids of those missions, so a client can ask for one without a list call. */
    runningIds: string[];
    /** Steps waiting on the user across all of them. Non-zero means someone is blocked. */
    awaitingApproval: number;
    /** How many the store holds, finished ones included. */
    recorded: number;
  };
  /**
   * The model behind the planner, as four facts and one sentence.
   *
   * A projection, like everything else on this pipe, and the strictest one in the
   * file: no key, no endpoint credentials, no request or response text. `note` is
   * built by the provider from how it was configured — an endpoint, a character count,
   * or "not set" — because "is a model configured" is a question the UI must be able
   * to answer and "which key" is one it must not.
   *
   * `simulated` and `available` are here for §43: a Jarvis with no model says so in
   * the window rather than looking like one that simply had nothing to plan.
   */
  llm: {
    /** `anthropic`, `openai-compatible`, `hermes`, or `offline`. */
    provider: string;
    model: string;
    available: boolean;
    simulated: boolean;
    /**
     * Whether this model can be shown a picture.
     *
     * On the wire because a window that offers to look at the screen has to be able to
     * say why it cannot, before it asks for the screen. A greyed-out button with a
     * reason is honest; one that captures first and fails afterwards has already taken
     * the screenshot it turned out not to need.
     */
    acceptsImages: boolean;
    /** One display-safe line. Says how it was configured, never with what. */
    note: string;
    /** Whether the model is allowed to plan, which is a separate setting. */
    planning: boolean;
  };
}

export type IpcFrame =
  | ClientRequest
  | ServerResponse
  | ({ event: true } & ServerEvent);

/**
 * Omit that distributes over a union.
 *
 * Plain `Omit<ClientRequest, "id">` collapses the union to its common keys
 * (just `type`), which silently rejects every request that carries a payload.
 * The `T extends unknown` clause forces per-member evaluation.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** A request body as callers supply it: everything but the correlation id. */
export type ClientRequestBody = DistributiveOmit<ClientRequest, "id">;

/** Wrap an event so a client can tell it apart from a response. */
export function eventFrame(e: ServerEvent): { event: true } & ServerEvent {
  return { event: true, ...e };
}

export function isEventFrame(f: unknown): f is { event: true } & ServerEvent {
  return typeof f === "object" && f !== null && (f as { event?: unknown }).event === true;
}
