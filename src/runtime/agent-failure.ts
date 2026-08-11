/**
 * Turn a failed agent turn into something a person can act on.
 *
 * Written because of a user report. Asked to open a website, Jarvis showed a red
 * banner reading exactly **"internal error"** and nothing else — no code, no
 * cause, no suggestion. That string is the entire human-readable payload of
 * JSON-RPC `-32603`, and the runtime was relaying `err.message` verbatim.
 *
 * The transport never lost the information: `RpcError` carries `code` and `data`
 * and has since it was written. The runtime simply threw both away one line
 * before the broadcast. So this is not new plumbing — it is the plumbing that
 * already existed, reaching the screen.
 *
 * Three rules the shape of this module follows from:
 *
 * 1. **The agent's error text is untrusted data (§52).** It originates outside
 *    Jarvis — a model provider, a tool, a remote MCP server — and an error
 *    message is as good a place to smuggle an instruction as any other string a
 *    model can influence. It is quoted into a sentence, never concatenated into
 *    something that will later be read as a command, and it is length-bounded so
 *    a hostile payload cannot push the real text off the screen.
 * 2. **It may contain a credential (§53).** Upstream auth failures routinely
 *    echo the offending key back — `invalid api key sk-…`. `redactSecrets` is
 *    reused rather than reimplemented so that this path gets every pattern the
 *    window-title path already has, and every one added to it later.
 * 3. **What Jarvis *says* and what Jarvis *shows* are different texts.** A
 *    spoken "JSON-RPC minus thirty-two thousand six hundred and three" helps
 *    nobody. The speech is a plain sentence; the code lives in the banner, where
 *    it can be read, screenshotted and searched for.
 */
import { RpcError } from "../hermes/hermes-adapter.js";
import { redactSecrets } from "../context/window-facts.js";

/** How much agent-supplied text survives into the banner. */
const MAX_DETAIL = 300;

export interface AgentFailure {
  /** One sentence, for the banner. Safe to render. */
  message: string;
  /** What to say out loud. No codes, no jargon. */
  speech: string;
  /** The JSON-RPC code, when there was one. For logs and for support. */
  code?: number;
  /** True when redaction removed something credential-shaped. Surfaced, not hidden. */
  redacted: boolean;
}

/**
 * The codes worth explaining rather than echoing.
 *
 * Only the ones where Jarvis genuinely knows more than the message does. `-32603`
 * is the whole reason this file exists: it is the JSON-RPC "something went wrong
 * on the server" catch-all, its standard message is the useless string the user
 * saw, and the actionable part is always in `data` if it is anywhere.
 */
const EXPLAINED: ReadonlyMap<number, string> = new Map([
  [-32700, "the agent sent something Jarvis could not parse"],
  [-32600, "the agent rejected the request as malformed"],
  [-32601, "the agent does not support that operation"],
  [-32602, "the agent rejected the request's parameters"],
  [-32603, "the agent hit an internal error"],
]);

/**
 * The JSON-RPC spec's own message text for each standard code.
 *
 * Repeating "the agent hit an internal error — Internal error" back at a user
 * would be the original bug with extra words, so a message that is just the
 * spec's boilerplate is dropped and the explanation stands alone.
 */
const BOILERPLATE = new Set([
  "parse error",
  "invalid request",
  "method not found",
  "invalid params",
  "internal error",
  "server error",
]);

function isBoilerplate(message: string): boolean {
  return BOILERPLATE.has(message.trim().toLowerCase());
}

/**
 * Flatten `data` to a single readable line.
 *
 * JSON-RPC allows any value here, and Hermes puts different shapes in it
 * depending on what failed. A string is the text; an object usually carries the
 * real cause under a familiar key. Anything else is serialised rather than
 * dropped, because "no detail" was the original complaint.
 */
function detailFrom(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "details", "reason", "description"]) {
      const v = o[key];
      if (typeof v === "string" && v.trim()) return v;
      // One level down: providers nest as `{error: {message: "…"}}` often enough
      // that not looking would leave the useful sentence one hop out of reach.
      if (v && typeof v === "object") {
        const inner = (v as Record<string, unknown>)["message"];
        if (typeof inner === "string" && inner.trim()) return inner;
      }
    }
  }
  try {
    return JSON.stringify(data) ?? "";
  } catch {
    // Circular, or a BigInt. Neither is worth failing an error path over.
    return "";
  }
}

/** Collapse whitespace and bound the length. Agent text, so treated as hostile. */
function tidy(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat;
}

/**
 * Describe a failed turn.
 *
 * Total, by design: this runs on the error path, and an error path that can
 * itself throw is how a bad turn becomes a dead assistant. Every branch returns
 * a sentence, including the one where the thrown value is not an `Error` at all.
 */
export function describeAgentFailure(err: unknown): AgentFailure {
  if (err instanceof RpcError) {
    const explained = EXPLAINED.get(err.code);
    const raw = tidy(detailFrom(err.data));
    const { text: detail, redacted } = redactSecrets(raw);

    // The message is only worth showing when it says something the code does
    // not. For a standard code the sender is usually echoing the spec's own
    // text — "Internal error" is precisely the string the user complained about
    // — so `BOILERPLATE` drops it in favour of the explanation, while a sender
    // that bothered to write a real message keeps it.
    const own = tidy(err.message);
    const head = explained ?? (own || "the agent returned an error");
    const body = explained && own && !isBoilerplate(own) ? own : "";

    const parts = [head];
    if (body) parts.push(`— ${body}`);
    if (detail && detail.toLowerCase() !== body.toLowerCase()) parts.push(`(${detail})`);

    return {
      message: `${parts.join(" ")} [rpc ${err.code}]`,
      // Spoken. No code, and no agent-supplied text: the detail is frequently a
      // stack trace or a provider's JSON, and reading either aloud is worse than
      // saying nothing useful at all.
      speech: detail
        ? "That didn't work. There's an explanation on screen."
        : "That didn't work, and the agent didn't say why.",
      code: err.code,
      redacted,
    };
  }

  if (err instanceof Error) {
    const { text, redacted } = redactSecrets(tidy(err.message));
    return {
      message: text || err.name || "the agent failed without a message",
      speech: "That didn't work.",
      redacted,
    };
  }

  // Not an Error. Rare, and exactly when a thrown string or object would
  // otherwise arrive as "[object Object]".
  const { text, redacted } = redactSecrets(tidy(detailFrom(err)));
  return {
    message: text || "the agent failed without a message",
    speech: "That didn't work.",
    redacted,
  };
}
