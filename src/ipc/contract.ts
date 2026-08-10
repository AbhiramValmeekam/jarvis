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
export const IPC_PROTOCOL_VERSION = 1;

export function defaultPipeName(): string {
  return "\\\\.\\pipe\\jarvis-runtime";
}

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
