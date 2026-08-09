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
  | { type: "error"; message: string; fatal: boolean }
  | { type: "unavailable"; subsystem: string; reason: string }
  | { type: "log"; line: string };

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
