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
  /** Answer an outstanding permission request. */
  | { id: number; type: "permission_response"; requestId: string; decision: PermissionDecision }
  /** Lifecycle. `quit` is the only way to stop the runtime. */
  | { id: number; type: "restart_hermes" }
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
  | { type: "permission_request"; requestId: string; title: string; detail?: string; options: string[] }
  | { type: "level"; rms: number }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "unavailable"; subsystem: string; reason: string }
  | { type: "log"; line: string };

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
