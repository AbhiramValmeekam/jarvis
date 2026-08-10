/**
 * Ranking MCP servers by relevance to what was just said.
 *
 * This started life as the "relevance-based tool selection" item on the Phase 10
 * list, on the assumption that Jarvis could hand `session/new` a narrowed
 * `mcpServers` list and shrink the prompt. **Reading the installed v0.18.2
 * showed that assumption is wrong**, and the correction is written here rather
 * than buried, because the wrong version of this module would have claimed a
 * latency win that never happens.
 *
 * What the code actually does, verified:
 *
 *  - `SessionManager.create_session` (`acp_adapter/session.py:611-622`) reads
 *    `mcp_servers` from `config.yaml` itself and seeds the session's
 *    `enabled_toolsets` with `mcp-{name}` for **every** entry not explicitly
 *    `enabled: false`. That happens before Jarvis's `session/new` params are
 *    looked at.
 *  - `discover_mcp_tools()` already ran at ACP process startup
 *    (`acp_adapter/entry.py:255-256`), registering those servers' tools into the
 *    process-global registry under those same `mcp-{name}` toolsets
 *    (`_register_server_tools`, `mcp_tool.py:4750`).
 *  - `_expand_acp_enabled_toolsets` (`acp_adapter/session.py:129-144`) **only
 *    appends**. `_register_session_mcp_servers` returns early on an empty list
 *    (`server.py:798`), and `register_mcp_servers` is documented idempotent for
 *    already-connected names (`mcp_tool.py:4879`).
 *
 * So ACP `mcpServers` is **purely additive**. Sending three of five configured
 * servers does not remove the other two — they were already in the prompt.
 * There is no subtractive lever on the wire Jarvis owns; the only real one is
 * `enabled: false` in `config.yaml`, which is Hermes' file and which
 * `mcp-store.ts` deliberately does not write.
 *
 * Hence this module ranks and explains, and does not pretend to gate. The score
 * answers "which of your servers is this about?" — for the spoken answer, the
 * HUD, and for deciding which of *Jarvis's own* additions (a server absent from
 * `config.yaml`) would be worth attaching, which is the one case where the
 * additive path has an effect. `hermes-adapter.ts` still sends `mcpServers: []`
 * and says why at the call site.
 *
 * The scoring is deliberately dumb: token overlap between the utterance and the
 * server's own name and tool names, the same technique `memory-store.ts` uses
 * for recall and for the same reason — this is the local fast path, it must
 * answer in microseconds with Hermes down, and the fallback for a miss is an
 * agent that can ask. No embeddings.
 *
 * The failure modes are asymmetric and the defaults follow that. Omitting a
 * server the user meant costs a wrong answer. Including one they didn't costs a
 * longer sentence. So `selectServers` is generous: on no signal at all it
 * returns everything enabled, rather than guessing.
 */
import type { McpServer } from "./mcp-store.js";

/** Words too common to carry signal. Kept short — this is not a stemmer. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at", "my",
  "me", "i", "is", "are", "do", "does", "can", "you", "please", "with", "from",
  "what", "whats", "how", "get", "show", "tell", "about", "it", "this", "that",
  "jarvis", "use", "using", "server", "servers", "mcp", "tool", "tools",
]);

function tokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !STOP.has(w));
}

export interface ServerScore {
  server: McpServer;
  score: number;
  /** Which words matched, for the log line that explains a selection. */
  matched: string[];
}

/**
 * Score one server against an utterance.
 *
 * The name is weighted above the tool names: a user who says "check my linear
 * issues" is naming the server, and a tool called `list_issues` on three
 * different servers should not outvote that.
 */
export function scoreServer(server: McpServer, utterance: string): ServerScore {
  const want = new Set(tokens(utterance));
  if (want.size === 0) return { server, score: 0, matched: [] };

  const matched: string[] = [];
  let score = 0;

  for (const w of tokens(server.name)) {
    if (want.has(w)) {
      score += 3;
      matched.push(w);
    }
  }

  // Only `include` lists are real tool names Jarvis can see without connecting.
  // An `exclude` list names tools that will *not* be there, so matching against
  // it would score a server highest for the one thing it cannot do.
  for (const t of server.includeTools) {
    for (const w of tokens(t)) {
      if (want.has(w) && !matched.includes(w)) {
        score += 1;
        matched.push(w);
      }
    }
  }

  return { server, score, matched };
}

export interface SelectOptions {
  /** Cap on how many servers come back. */
  max?: number;
}

/** Default cap. Beyond a handful, a ranked list stops being an answer. */
export const DEFAULT_MAX_SERVERS = 4;

/**
 * Rank the configured servers against one utterance.
 *
 * Rules, in order:
 *  - Anything `suspicious` is dropped outright. Hermes will refuse to spawn it
 *    (`_filter_suspicious_mcp_servers`, `mcp_tool.py:3718`), so ranking it as
 *    relevant would point the user at something that is not going to run.
 *  - Anything `enabled: false` is dropped: the user turned it off, and a
 *    relevance score is not a reason to overrule that. This is also the only
 *    switch that genuinely removes a server's tools from the prompt, and it
 *    lives in Hermes' `config.yaml`, not here.
 *  - If nothing scores, everything left is returned up to `max`. No signal is
 *    not evidence of irrelevance.
 */
export function selectServers(
  servers: readonly McpServer[],
  utterance: string,
  opts: SelectOptions = {},
): McpServer[] {
  const max = opts.max ?? DEFAULT_MAX_SERVERS;
  const eligible = servers.filter((s) => s.enabled && s.suspicious.length === 0);
  if (eligible.length === 0) return [];

  const scored = eligible.map((s) => scoreServer(s, utterance));
  const hits = scored.filter((s) => s.score > 0);

  if (hits.length === 0) return eligible.slice(0, max);

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, max).map((h) => h.server);
}
