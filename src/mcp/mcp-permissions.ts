/**
 * What an MCP tool is allowed to do, decided before it runs.
 *
 * Phase 5 classified Hermes' *built-in* tools by name: `terminal` executes,
 * `write_file` writes, `web_search` reaches the network. MCP breaks that
 * assumption, and this file exists because of exactly how it breaks.
 *
 * An MCP tool arrives as `mcp__{server}__{tool}` (`MCP_TOOL_NAME_PREFIX`,
 * `tools/mcp_tool.py:4473`), and the half after the second `__` is a name
 * chosen by **whoever wrote the server** — not by Hermes, not by Jarvis, and
 * not necessarily by the user. Run `mcp__shell__search` through `family()` in
 * `risk-model.ts` and it matches `search` and comes back level 0, read-only.
 * That is the bug this module closes: for MCP, the same string shape covers a
 * note lookup and a shell, so the floor has to be caution and the evidence has
 * to come from three places — the verb, the arguments, and the *surface* the
 * server names itself after (`CAPABILITY_SURFACES`, which is what actually
 * catches `mcp__shell__search`). Never from the server's own description of
 * itself, which `_scan_mcp_description` (`mcp_tool.py:4775`) already treats as
 * prompt-injection surface (§52).
 *
 * What this module does **not** do is let a name reach a refusal. §61's
 * forbidden ground is about effects, so `classify` matches those rules against
 * an MCP tool's arguments alone (`risk-model.ts`, at the `probe` line) — a
 * server author must not be able to make a tool permanently unusable, nor to
 * spend the user's trust on an alarm about a word. Names raise the level and ask;
 * only arguments refuse.
 *
 * **Where the enforcement really lands, stated honestly.** Verified against the
 * installed v0.18.2: Hermes gates MCP *elicitations* through its approval
 * system (`mcp_tool.py:1432` → `request_elicitation_consent`), but an ordinary
 * MCP tool call is not gated — nothing in `tools/mcp_tool.py` calls
 * `prompt_dangerous_approval` for a tool invocation, and `tool.started` fires
 * *after* the block checks, immediately before dispatch
 * (`agent/tool_executor.py:1166`), so it is an observation and not a veto. The
 * one true pre-execution veto is `resolve_pre_tool_block`
 * (`hermes_cli/plugins.py:2228`), a plugin hook inside Hermes' own process, and
 * Jarvis does not install plugins into Hermes.
 *
 * So Jarvis enforces at the two points it genuinely controls —
 * `session/request_permission`, which it already answers, and which servers
 * reach a session at all — and the docs claim that and no more. A prompt that
 * said "Jarvis will block this tool" when it cannot would be exactly the fake
 * feature the master prompt forbids.
 *
 * This module imports **nothing** from `risk-model.ts`, types aside. The
 * dependency runs one way, `risk-model` → here, so `classify()` stays the
 * single decision point rather than acquiring a second opinion that callers
 * have to remember to consult.
 */
import type { RiskCategory, RiskLevel } from "../permissions/risk-model.js";

/** `mcp__` — `MCP_TOOL_NAME_PREFIX` (`tools/mcp_tool.py:4473`). */
export const MCP_TOOL_PREFIX = "mcp__";

export interface McpToolName {
  /** Server component, raw. Callers sanitise before display. */
  server: string;
  /** Tool component, raw. Empty when the name carries no tool half. */
  tool: string;
}

/**
 * Split `mcp__{server}__{tool}`.
 *
 * Ambiguous by construction: server `a__b` with tool `c` produces the same
 * string as server `a` with tool `b__c`. Hermes solved this by recording
 * provenance at registration time and explicitly warns against prefix matching
 * (`is_mcp_tool_parallel_safe`, `mcp_tool.py:5040`). Jarvis sees no
 * registration event, so it splits on the **first** `__` after the prefix.
 *
 * A mis-split still cannot lower a verdict, and it is worth being precise about
 * why, because the reason is structural rather than careful. Splitting on the
 * first `__` means the tool half is always a *superset* of the true tool name
 * (a server called `a__b` donates `b` to it), so `VERB_RULES` never loses a
 * dangerous verb to the split. The one thing that can go missing is a word from
 * the far end of a compound server name — which is exactly why the
 * capability check below reads **both halves at once** and only ever raises.
 */
export function parseMcpToolName(name: string): McpToolName | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const idx = rest.indexOf("__");
  // `mcp__foo` with no tool half is a real shape to classify, not to reject.
  if (idx <= 0) return { server: rest, tool: "" };
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}

export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/**
 * Verbs that appear in MCP tool names, mapped to the effect they imply.
 *
 * Ordered most-dangerous first and matched in that order, because a real tool
 * is called `delete_and_reindex` and the dangerous half has to win. Matching is
 * on whole words split out of the name, never on substrings: `search` must not
 * match inside `research`, and `rm` must not match inside `form`. That is the
 * same false-positive discipline `SECRET_PATTERNS` needed in Phase 8, and the
 * cost of getting it wrong is the same — a guard people learn to click past.
 */
const VERB_RULES: ReadonlyArray<{
  verbs: readonly string[];
  level: RiskLevel;
  category: RiskCategory;
  reason: string;
}> = [
  {
    verbs: ["exec", "execute", "run", "shell", "spawn", "eval", "command", "sudo", "install", "uninstall"],
    level: 3,
    category: "execute",
    reason: "runs something on this machine",
  },
  {
    verbs: ["delete", "remove", "rm", "destroy", "drop", "purge", "wipe", "truncate", "revoke"],
    level: 3,
    category: "delete",
    reason: "deletes something",
  },
  {
    // Deliberately without `book`, `order`, `message` and `commit`, which are
    // nouns at least as often as verbs — `address_book`, `get_order`,
    // `get_message`, `get_commit` are all ordinary reads. Dropping them costs
    // nothing, and that is the point worth keeping in mind: the floor for an
    // unmatched name is already level 3, so `book_flight` still asks. All the
    // ambiguous entry bought was a *false reason* — telling someone that reading
    // their contacts "sends something off this machine" is the kind of alarm
    // that teaches people to stop reading them.
    verbs: [
      "send", "post", "publish", "email", "tweet", "notify", "share",
      "upload", "deploy", "push", "pay", "charge",
    ],
    level: 3,
    category: "network",
    reason: "sends something off this machine, where it cannot be taken back",
  },
  {
    verbs: [
      "write", "create", "update", "edit", "set", "put", "patch", "insert",
      "add", "append", "rename", "move", "upsert",
    ],
    level: 2,
    category: "write",
    reason: "changes stored data",
  },
  {
    verbs: [
      "read", "get", "list", "search", "find", "query", "fetch", "lookup",
      "describe", "show", "status", "count", "view",
    ],
    level: 0,
    category: "read",
    reason: "reads without changing anything",
  },
];

/**
 * Words that, appearing anywhere in `{server}__{tool}`, mean a read verb cannot
 * be taken at face value.
 *
 * This is the rule the module's opening paragraph is about. `mcp__shell__search`
 * has a perfectly innocent verb; what makes it dangerous is the surface it runs
 * on, and the surface is named in the half `VERB_RULES` never looks at. A server
 * that calls itself a shell has told you that its tools can run things, and
 * "search" on a shell is one `| sh` away from "execute".
 *
 * Scanned across the **whole** name rather than the server half, which makes the
 * result independent of where `parseMcpToolName` happened to split: server
 * `my__shell` with tool `search` and server `my` with tool `shell__search`
 * produce the same string and now reach the same verdict.
 *
 * Deliberately short, and limited to interpreters and system-control surfaces —
 * the cases where a read-shaped name plausibly hides arbitrary execution. It is
 * not a list of things that sound scary: `mcp__github__list_issues` must stay
 * level 0, because a guard that prompts on every ordinary read is a guard the
 * user learns to dismiss without reading, and then it is worth less than nothing.
 */
const CAPABILITY_SURFACES = new Set([
  "shell", "bash", "sh", "zsh", "cmd", "powershell", "pwsh", "terminal",
  "console", "repl", "exec", "execute", "subprocess", "process",
  "ssh", "telnet", "winrm", "sudo", "root", "admin",
  "system", "kernel", "registry", "firewall", "defender",
]);

function words(tool: string): string[] {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== "")
    .map((w) => w.toLowerCase());
}

/**
 * Argument shapes that raise a verdict whatever the verb said.
 *
 * `mcp__x__get` with `{"path": "C:\\Windows\\System32"}` is not a read of the
 * server's own data. These run after the verb match and can only ever raise,
 * matching the rule the rest of the permission layer follows: every step after
 * classification may escalate, none may downgrade.
 */
const ARG_ESCALATIONS: ReadonlyArray<{ re: RegExp; level: RiskLevel; reason: string }> = [
  {
    re: /(?<![\w.-])(?:rm|del|rmdir|format|diskpart|shutdown)(?![\w.-])|reg\s+delete/i,
    level: 4,
    reason: "its arguments carry a destructive system command",
  },
  {
    re: /\b(?:password|passwd|secret|api[_-]?key|token|private[_-]?key|credential)s?\b/i,
    level: 3,
    reason: "its arguments mention credentials",
  },
  {
    re: /[A-Za-z]:\\(?:Windows|Program Files)|\/etc\/|%SystemRoot%/i,
    level: 3,
    reason: "its arguments point at system locations",
  },
];

/** What `classifyMcpTool` hands back to `risk-model.ts` to assemble. */
export interface McpVerdict {
  level: RiskLevel;
  category: RiskCategory;
  /** Contains the raw tool name; the caller sanitises before it is shown. */
  reason: string;
  server: string;
  tool: string;
}

/**
 * Classify an MCP tool call from its name and already-flattened arguments.
 *
 * Returns `null` for a non-MCP tool, so `classify()` falls straight through to
 * its own families rather than this file becoming a second opinion on
 * `terminal`. The floor for anything it recognises is level 3, not level 0:
 * "I don't know what this does" and "this is safe" must never produce the same
 * verdict when the name was chosen by a third party.
 */
export function classifyMcpTool(toolName: string, flatArgs: string): McpVerdict | null {
  const parsed = parseMcpToolName(toolName);
  if (parsed === null) return null;

  const tokens = new Set(words(parsed.tool));

  let level: RiskLevel = 3;
  let category: RiskCategory = "unknown";
  let reason =
    parsed.tool === ""
      ? "this comes from an MCP server and its name says nothing about what it does"
      : `"${parsed.tool}" comes from the "${parsed.server}" MCP server and I can't tell what it does from its name`;

  for (const rule of VERB_RULES) {
    if (rule.verbs.some((v) => tokens.has(v))) {
      level = rule.level;
      category = rule.category;
      reason = `"${parsed.tool}" from the "${parsed.server}" MCP server ${rule.reason}`;
      break;
    }
  }

  // The capability check, and the only place the server half is read. It can
  // raise and never lower, so a mis-split cannot buy an attacker anything: the
  // worst it does is decline to raise a verdict the verb rules already set.
  const surface = [...words(parsed.server), ...tokens].find((w) => CAPABILITY_SURFACES.has(w));
  if (surface !== undefined && level < 3) {
    level = 3;
    category = "execute";
    reason = `"${parsed.tool}" comes from an MCP server whose name says "${surface}", so I can't treat it as harmless whatever it is called`;
  }

  for (const esc of ARG_ESCALATIONS) {
    if (esc.level > level && esc.re.test(flatArgs)) {
      level = esc.level;
      // A "read" that trips an escalation is no longer describable as a read.
      if (category === "read") category = "unknown";
      reason = `"${parsed.tool}" from the "${parsed.server}" MCP server needs a closer look: ${esc.reason}`;
    }
  }

  return { level, category, reason, server: parsed.server, tool: parsed.tool };
}
