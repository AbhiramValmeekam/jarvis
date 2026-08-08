/**
 * Typed view of the ACP surface Hermes actually implements.
 *
 * Every method/field name here was verified against the installed Hermes
 * (v0.18.2) ACP adapter and agent-client-protocol 0.9.0 — not from docs.
 * If a capability is absent upstream it is absent here rather than faked.
 */

/** ACP protocol version implemented by the installed SDK. */
export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC methods the client (Jarvis) calls on the agent (Hermes). */
export const AgentMethod = {
  initialize: "initialize",
  authenticate: "authenticate",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionResume: "session/resume",
  sessionFork: "session/fork",
  sessionList: "session/list",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetMode: "session/set_mode",
  sessionSetModel: "session/set_model",
  sessionSetConfigOption: "session/set_config_option",
} as const;

/** JSON-RPC methods the agent (Hermes) calls back on the client (Jarvis). */
export const ClientMethod = {
  sessionUpdate: "session/update",
  requestPermission: "session/request_permission",
  fsReadTextFile: "fs/read_text_file",
  fsWriteTextFile: "fs/write_text_file",
  terminalCreate: "terminal/create",
  terminalOutput: "terminal/output",
  terminalKill: "terminal/kill",
  terminalRelease: "terminal/release",
  terminalWaitForExit: "terminal/wait_for_exit",
} as const;

/**
 * Discriminator values for `session/update` notifications.
 * NOTE: the wire key is camelCase (`sessionUpdate`) but the values are
 * snake_case — confirmed in acp/schema.py.
 */
export type SessionUpdateKind =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "user_message_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "available_commands_update"
  | "current_mode_update"
  | "session_info_update"
  | "usage_update"
  | "config_option_update";

export interface TextContentBlock {
  type: "text";
  text: string;
}

export type ContentBlock =
  | TextContentBlock
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string };

/** Terminal stop reasons returned by `session/prompt`. */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface PromptResponse {
  stopReason: StopReason;
}

export interface NewSessionResponse {
  sessionId: string;
  models?: unknown;
  modes?: unknown;
}

/** A streamed event surfaced to Jarvis consumers. */
export type HermesStreamEvent =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool_call"; id: string; title: string; status?: string; raw: unknown }
  | { kind: "tool_update"; id: string; status?: string; raw: unknown }
  | { kind: "plan"; entries: unknown }
  | { kind: "other"; update: string; raw: unknown };

/** Outcome of a permission request, mapped to Hermes approval semantics. */
export type PermissionOutcomeId =
  | "allow_once"
  | "allow_session"
  | "allow_always"
  | "deny"
  | "deny_always";

export interface PermissionRequest {
  sessionId: string;
  toolCall: unknown;
  options: Array<{ optionId: string; kind: string; name: string }>;
}
