/**
 * Hermes' MCP servers, read from its config file.
 *
 * The third read-only view of Hermes' own state, after `memory/hermes-memory.ts`
 * and `tasks/cron-store.ts`, and the boundary is drawn harder here than in
 * either of them. Those two files hold notes and jobs. This one holds
 * **commands Hermes will spawn**, and `hermes_cli/mcp_security.py` exists
 * because that has been attacked in the wild: the June 2026 `hermes-0day`
 * campaign planted `command: bash` entries whose payload appended an attacker
 * SSH key to `authorized_keys`, and Hermes re-executed them on every startup
 * and cron tick. A write path in this module would be a second way to plant
 * exactly that, bypassing the save-time validation Hermes added in response.
 * **There is no write path here** — not a disabled one, an absent one.
 *
 * `%LOCALAPPDATA%\hermes\config.yaml` is also 7 KB of the user's own file, with
 * their comments in it, and a live Hermes rewrites it through `save_config`.
 * Round-tripping that to toggle a boolean is the trade Phase 8 already refused
 * for skills, for the same three reasons: it would add a YAML dependency to a
 * repo whose only runtime dependency is React, it would drop the user's
 * comments, and it would race the process that owns the file.
 *
 * Reading is narrow on purpose. This module parses **one** top-level key,
 * `mcp_servers`, with a hand-written scanner that understands the block-mapping
 * and flow-sequence shapes `hermes mcp add` writes (`mcp_config.py:387`) and
 * gives up rather than guessing on anything else. It never resolves `${VAR}`
 * placeholders: Hermes interpolates those from `~/.hermes/.env` at spawn time
 * (`mcp_tool.py:_interpolate_env_vars`), that file is 24 KB of real credentials
 * on this machine, and a value Jarvis never reads is a value Jarvis cannot leak
 * (§53). An env block is reported as *names only*.
 *
 * Everything here is untrusted content (§52) and, unlike a skill description,
 * it is untrusted content that describes an executable. Names, commands and
 * arguments are sanitised at this boundary, and `suspicious` mirrors Hermes'
 * own `validate_mcp_server_entry` so Jarvis can say "this one is the backdoor
 * shape" instead of listing it as an ordinary server.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { sanitiseForDisplay } from "../permissions/risk-model.js";

/** `%LOCALAPPDATA%\hermes` — `get_hermes_home()` on win32 (`hermes_constants.py:55`). */
export function hermesHome(): string {
  const explicit = process.env.HERMES_HOME;
  if (explicit) return explicit;
  const base = process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(base, "hermes");
}

/** `<hermes home>/config.yaml` — the file `load_config()` reads. */
export function hermesConfigPath(home = hermesHome()): string {
  return join(home, "config.yaml");
}

/** How a server talks to Hermes. `url` means http/sse, `command` means stdio. */
export type McpTransport = "stdio" | "http" | "unknown";

/**
 * One configured server, as Jarvis reads it.
 *
 * A projection, following `CronJob`: Hermes' entry may carry `auth`, `headers`,
 * `sampling`, `elicitation`, timeouts and more, and spreading it would publish
 * whatever it adds next to every attached UI. `headers` is excluded by name as
 * well as by omission — it is where a bearer token lives.
 */
export interface McpServer {
  /** Sanitised config key. */
  name: string;
  transport: McpTransport;
  /** Sanitised. Empty for http servers. */
  command: string;
  /** Sanitised, and capped — an inline script can run to kilobytes. */
  args: string[];
  /** Sanitised origin only (`https://host`), never the path or query. */
  url: string;
  /** Env variable *names* the entry sets. Values are never read (§53). */
  envNames: string[];
  /** `enabled: false` means configured but deliberately not connected. */
  enabled: boolean;
  /** From `tools.include` — a whitelist. Empty when absent. */
  includeTools: string[];
  /** From `tools.exclude` — a blacklist. Empty when absent. */
  excludeTools: string[];
  /**
   * Non-empty when this entry matches a shape Hermes itself refuses to spawn.
   * Each string is a plain-language reason, already sanitised.
   */
  suspicious: string[];
}

export interface McpSnapshot {
  /** Absent config file, or no `mcp_servers` key, both read as zero servers. */
  servers: McpServer[];
  /** False when the config file does not exist. */
  configPresent: boolean;
  /**
   * True when `mcp_servers` was present but this parser could not read it.
   * Reported rather than swallowed: "0 servers" and "I could not tell" are
   * different answers, and only one of them should sound confident.
   */
  unparsed: boolean;
  /** Config file size in bytes, 0 when absent. Used by the read-only probe. */
  bytes: number;
}

const EMPTY: McpSnapshot = {
  servers: [],
  configPresent: false,
  unparsed: false,
  bytes: 0,
};

/** Longest inline argument Jarvis will carry. Payloads are long by design. */
const MAX_ARG_LEN = 200;
/** Beyond this, an args list is truncated rather than carried whole. */
const MAX_ARGS = 12;

export function readMcpServers(configPath = hermesConfigPath()): McpSnapshot {
  if (!existsSync(configPath)) return { ...EMPTY };

  let raw: string;
  let bytes = 0;
  try {
    bytes = statSync(configPath).size;
    raw = readFileSync(configPath, "utf8");
  } catch {
    return { ...EMPTY, configPresent: true };
  }

  const block = extractMcpServersBlock(raw);
  if (block === null) {
    return { servers: [], configPresent: true, unparsed: false, bytes };
  }

  const entries = parseServerBlock(block);
  if (entries === null) {
    return { servers: [], configPresent: true, unparsed: true, bytes };
  }

  return {
    servers: entries.map(toServer),
    configPresent: true,
    unparsed: false,
    bytes,
  };
}

/**
 * Slice out the `mcp_servers:` block by indentation.
 *
 * Returns `null` when the key is absent — the case on this machine, and the
 * common one. An empty string means the key exists with nothing under it.
 *
 * Indentation is the only structure this needs: YAML block mappings end when a
 * line returns to the parent's indent or less. Comments and blank lines inside
 * the block are kept and skipped later, because a comment line has no reliable
 * indent of its own.
 */
function extractMcpServersBlock(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    // Top-level key only: an `mcp_servers:` nested under something else is not
    // the key Hermes reads (`config.get("mcp_servers")`).
    if (/^mcp_servers\s*:/.test(line)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  // `mcp_servers: {}` on one line — an explicit empty mapping.
  const head = (lines[start] ?? "").slice((lines[start] ?? "").indexOf(":") + 1).trim();
  if (head && head !== "|" && head !== ">") {
    return head === "{}" ? "" : head;
  }

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || /^\s*#/.test(line)) {
      body.push(line);
      continue;
    }
    if (!/^\s/.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

interface RawEntry {
  name: string;
  /**
   * Scalar fields by dotted path: `command`, `enabled`, `env.GITHUB_TOKEN`,
   * `tools.include`.
   *
   * Paths rather than a nested structure because the nesting is only ever two
   * deep and the consumers all know the path they want. A `Map` also preserves
   * insertion order, which is how `env` reports its names in file order.
   */
  fields: Map<string, string>;
  /** Block sequences by the same dotted path: `args`, `tools.include`. */
  lists: Map<string, string[]>;
}

/**
 * Parse the server block into raw name/field pairs.
 *
 * Returns `null` when the block is a shape this scanner does not handle — a
 * flow mapping on one line, an anchor, a merge key, or a top-level sequence.
 * `null` becomes `unparsed`, which Jarvis says out loud, rather than a confident
 * and wrong "0 servers".
 *
 * Structure comes from an indent stack, which is what makes `tools.include:`
 * followed by `- create_issue` readable. The earlier version tracked a single
 * sub-key and silently produced an empty list for that shape — a parser that
 * returns "no tools filtered" for a config that filters tools is worse than one
 * that admits defeat.
 */
function parseServerBlock(block: string): RawEntry[] | null {
  if (block.trim() === "") return [];
  if (block.trim().startsWith("{")) return null;

  const lines = block.split(/\r?\n/).filter((l) => l.trim() !== "" && !/^\s*#/.test(l));
  if (lines.length === 0) return [];

  const baseIndent = indentOf(lines[0] ?? "");
  const entries: RawEntry[] = [];
  let current: RawEntry | null = null;
  /** Open parent keys, innermost last. */
  let stack: Array<{ indent: number; key: string }> = [];

  for (const line of lines) {
    const indent = indentOf(line);
    const trimmed = line.trim();

    if (trimmed.includes("<<:") || trimmed.startsWith("&") || trimmed.startsWith("*")) {
      return null;
    }

    // A block sequence item. Legitimate under a field — `args:` followed by
    // `- '-c'` is what a hand-edited config writes, and it is the form the June
    // 2026 planted entries used, so refusing it would take the whole block dark
    // and leave the one entry that matters unscreened. Not legitimate at the
    // entry level, where it would mean `mcp_servers` is a list rather than the
    // mapping `config.get("mcp_servers")` reads.
    if (trimmed === "-" || trimmed.startsWith("- ")) {
      const owner = stack[stack.length - 1];
      if (current === null || owner === undefined || indent <= owner.indent) return null;
      const path = stack.map((s) => s.key).join(".");
      const list = current.lists.get(path) ?? [];
      list.push(unquote(trimmed.slice(1).trim()));
      current.lists.set(path, list);
      continue;
    }

    const colon = splitKey(trimmed);
    if (colon === null) return null;
    const [key, value] = colon;

    if (indent === baseIndent) {
      // `name: {command: x}` — a flow mapping this scanner will not guess at.
      if (value.startsWith("{")) return null;
      current = { name: key, fields: new Map(), lists: new Map() };
      entries.push(current);
      stack = [];
      continue;
    }

    if (current === null) return null;

    // Close every parent this line has dedented out of.
    while (stack.length > 0 && indent <= (stack[stack.length - 1]?.indent ?? -1)) {
      stack.pop();
    }

    const path = [...stack.map((s) => s.key), key].join(".");
    if (value === "") {
      // Either a nested mapping or a block sequence; the next line decides, and
      // both are reached through this same path.
      stack.push({ indent, key });
      continue;
    }
    current.fields.set(path, value);
  }

  return entries;
}

function indentOf(line: string): number {
  const m = /^\s*/.exec(line);
  return m ? m[0].length : 0;
}

/** Split `key: value`, tolerating quoted keys and values containing colons. */
function splitKey(trimmed: string): [string, string] | null {
  const idx = trimmed.indexOf(":");
  if (idx <= 0) return null;
  const key = unquote(trimmed.slice(0, idx).trim());
  if (key === "") return null;
  const rest = trimmed.slice(idx + 1);
  return [key, stripComment(rest).trim()];
}

/**
 * Drop a trailing `# comment`, but only outside quotes — a URL fragment or a
 * `#` inside an inline script is part of the value, not a comment.
 */
function stripComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
      return value.slice(0, i);
    }
  }
  return value;
}

function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Read a list that may have arrived either way: a flow sequence on the field
 * line (`args: [-y, pkg]`) or a block sequence under it. A bare scalar counts as
 * a one-item list, which is how `args: --port` reads.
 */
function parseList(value: string | undefined, block: readonly string[] | undefined): string[] {
  if (block && block.length > 0) return block.filter((s) => s !== "");
  const t = (value ?? "").trim();
  if (t === "") return [];
  if (!t.startsWith("[")) return [unquote(t)];
  const inner = t.slice(1, t.endsWith("]") ? -1 : undefined);
  return splitFlow(inner).map(unquote).filter((s) => s !== "");
}

/** Split on commas outside quotes, so an argument containing one survives. */
function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ",") {
      out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== "") out.push(buf.trim());
  return out;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  // `_parse_boolish` (`mcp_tool.py`) accepts these spellings.
  const t = unquote(value).toLowerCase();
  if (t === "false" || t === "0" || t === "no" || t === "off") return false;
  if (t === "true" || t === "1" || t === "yes" || t === "on") return true;
  return fallback;
}

/**
 * Reduce a URL to its origin before it is ever shown.
 *
 * A remote MCP endpoint can carry a session key in its path or query — that is
 * how several hosted servers authenticate — so the path is dropped here rather
 * than trusted to be boring (§53). An unparseable URL becomes `"(invalid url)"`
 * instead of being echoed.
 */
function originOnly(value: string): string {
  const t = unquote(value);
  if (t === "") return "";
  if (t.includes("${")) return "(from environment)";
  try {
    const u = new URL(t);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(invalid url)";
  }
}

function toServer(entry: RawEntry): McpServer {
  const command = unquote(entry.fields.get("command") ?? "");
  const url = entry.fields.get("url") ?? "";
  const argsRaw = parseList(entry.fields.get("args"), entry.lists.get("args"));

  const transport: McpTransport = url !== "" ? "http" : command !== "" ? "stdio" : "unknown";

  const args = argsRaw
    .slice(0, MAX_ARGS)
    .map((a) => sanitiseForDisplay(a, MAX_ARG_LEN));
  if (argsRaw.length > MAX_ARGS) args.push(`… ${argsRaw.length - MAX_ARGS} more`);

  // Env *names* only, never values (§53). They arrive as `env.NAME` paths, so
  // the prefix is stripped back off; a name containing a dot is not a thing an
  // environment variable can be.
  const envNames: string[] = [];
  for (const key of entry.fields.keys()) {
    if (key.startsWith("env.")) envNames.push(sanitiseForDisplay(unquote(key.slice(4)), 60));
  }

  return {
    name: sanitiseForDisplay(entry.name, 60),
    transport,
    command: sanitiseForDisplay(command, 120),
    args,
    url: sanitiseForDisplay(originOnly(url), 120),
    envNames,
    enabled: parseBool(entry.fields.get("enabled"), true),
    includeTools: toolNames(entry, "tools.include"),
    excludeTools: toolNames(entry, "tools.exclude"),
    suspicious: screenServer(entry.name, command, argsRaw),
  };
}

function toolNames(entry: RawEntry, path: string): string[] {
  return parseList(entry.fields.get(path), entry.lists.get(path)).map((t) =>
    sanitiseForDisplay(t, 80),
  );
}



/**
 * Mirror of `hermes_cli/mcp_security.py:validate_mcp_server_entry`.
 *
 * Deliberately a *mirror*, not an improvement. Hermes runs this check at save
 * time and again at spawn time, so anything it refuses will not run; Jarvis
 * reimplements it only so it can *say why* an entry it can see will never
 * connect, instead of listing it beside working servers and leaving the user to
 * wonder. Widening it here would produce the worse failure: Jarvis calling an
 * entry dangerous that Hermes happily spawns, which teaches people to ignore
 * the warning.
 *
 * The three shapes, in Hermes' order, from that module's own docstring: a
 * hardcoded `hermes-0day` IOC anywhere in the entry; a shell interpreter whose
 * inline script reaches the network; a shell interpreter whose inline script
 * writes to an OS persistence surface.
 *
 * One divergence, on purpose and stated rather than hidden: Hermes' `_entry_text`
 * also flattens **env values** into the IOC scan. Jarvis does not read env values
 * at all (§53), so an IOC hidden in one is invisible here. That is a gap in
 * Jarvis's *explanation*, never in the defence — Hermes still refuses the entry
 * at spawn time. Closing it would mean reading the user's credentials to check
 * whether they contain an attacker's SSH key, which is a worse trade than a
 * missing sentence.
 */
const SHELL_INTERPRETERS = new Set([
  "bash", "sh", "zsh", "dash", "fish",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
]);

const EGRESS =
  /(?<![\w.-])(?:curl|wget|nc|ncat|socat)(?![\w.-])|\/dev\/tcp\/|\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\bSystem\.Net\.WebClient\b/i;

const PERSISTENCE =
  /authorized_keys|\.ssh\/|\/etc\/ssh\b|\/etc\/pam\.d\b|pam_[\w-]+\.so|\/etc\/sudoers|\/etc\/cron|crontab\b|\/etc\/rc\.local|\/etc\/systemd|\.bashrc\b|\.bash_profile\b|\.profile\b|\.zshrc\b/i;

/**
 * The June 2026 campaign's own artifacts, copied verbatim from
 * `mcp_security.py:_IOC_SUBSTRINGS` so a pre-planted entry is named as such.
 */
const IOCS = [
  "AAAAC3NzaC1lZDI1NTE5AAAAICBoh1oDC4DnsO1m5mJ4yfEKrQebaFh",
  "hermes-0day",
  "60.165.167.",
  "118.182.244.156",
  "61.178.123.196",
];

/** `os.path.basename(shlex.split(command)[0]).lower()`, close enough for a name. */
function commandBasename(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const cut = first.replace(/^["']|["']$/g, "");
  const parts = cut.split(/[\/]/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

function screenServer(name: string, command: string, args: string[]): string[] {
  const safeName = sanitiseForDisplay(name, 60);
  const flat = [command, ...args].join(" ");

  for (const ioc of IOCS) {
    if (flat.includes(ioc)) {
      // One IOC is enough. Hermes returns early here too, so the full match
      // list is never assembled — there is nothing to leak into a log.
      return [
        `"${safeName}" carries a known hermes-0day indicator of compromise. Hermes refuses to start it, and so should you: this entry was planted, not configured.`,
      ];
    }
  }

  if (!SHELL_INTERPRETERS.has(commandBasename(command))) return [];
  const script = args.join(" ");
  if (script === "") return [];

  const issues: string[] = [];
  if (EGRESS.test(script)) {
    issues.push(
      `"${safeName}" runs a shell script that reaches the network. Hermes refuses to start it — this is the shape used to exfiltrate credentials.`,
    );
  }
  if (PERSISTENCE.test(script)) {
    issues.push(
      `"${safeName}" runs a shell script that writes to SSH keys, PAM, sudoers or cron. Hermes refuses to start it — that is a backdoor, not an MCP server.`,
    );
  }
  return issues;
}
