/**
 * Saying what MCP is doing for you, in the order that matters.
 *
 * Same rule as `speak-tasks.ts`: the warning leads. If one of the configured
 * entries matches a shape Hermes refuses to spawn, that sentence comes before
 * the inventory, because "you have four servers" followed by a caveat is a
 * sentence people stop listening to after the number.
 *
 * The other rule is the honest zero. There are no MCP servers configured on
 * this machine, and the reply for that is "none", not a list of servers Jarvis
 * imagines would be useful. `configPresent: false` and `unparsed: true` are also
 * distinct answers and get distinct sentences — "I could not read it" is not
 * "there are none".
 */
import type { McpServer, McpSnapshot } from "./mcp-store.js";

/** One server, in a phrase. Everything here is already sanitised by the store. */
export function describeServer(s: McpServer): string {
  const where =
    s.transport === "http" ? s.url || "a remote endpoint" : s.command || "an unknown command";
  const bits: string[] = [`${s.name} (${where})`];
  if (!s.enabled) bits.push("disabled");
  if (s.includeTools.length > 0) bits.push(`${s.includeTools.length} of its tools allowed`);
  else if (s.excludeTools.length > 0) bits.push(`${s.excludeTools.length} of its tools blocked`);
  return bits.join(", ");
}

/**
 * The spoken answer to "what MCP servers do I have?".
 *
 * Kept to a few sentences on purpose: this is read aloud. A long inventory is a
 * thing to render, not to speak, so beyond a handful it gives the count and the
 * first few names.
 */
export function speakMcp(snap: McpSnapshot): string {
  const parts: string[] = [];

  const flagged = snap.servers.filter((s) => s.suspicious.length > 0);
  for (const s of flagged) {
    // Every reason is already a full sentence naming the server.
    parts.push(s.suspicious[0] ?? "");
  }

  if (!snap.configPresent) {
    parts.push("Hermes has no config file here, so no MCP servers are set up.");
    return parts.join(" ");
  }

  if (snap.unparsed) {
    parts.push(
      "Hermes' config file has an MCP section I couldn't read, so I can't tell you what's configured. `hermes mcp list` will show it.",
    );
    return parts.join(" ");
  }

  const usable = snap.servers.filter((s) => s.suspicious.length === 0);
  if (usable.length === 0 && flagged.length === 0) {
    parts.push(
      "No MCP servers are configured. Hermes' own tools still work — MCP is for connecting extra ones.",
    );
    return parts.join(" ");
  }

  const enabled = usable.filter((s) => s.enabled);
  const disabled = usable.filter((s) => !s.enabled);

  if (enabled.length === 0) {
    parts.push(
      disabled.length === 1
        ? `One MCP server is configured but disabled: ${disabled[0]?.name ?? ""}.`
        : `${disabled.length} MCP servers are configured, all of them disabled.`,
    );
  } else if (enabled.length <= 4) {
    parts.push(
      `${enabled.length === 1 ? "One MCP server" : `${enabled.length} MCP servers`}: ${enabled
        .map(describeServer)
        .join("; ")}.`,
    );
  } else {
    const first = enabled.slice(0, 3).map((s) => s.name).join(", ");
    parts.push(`${enabled.length} MCP servers, including ${first}.`);
  }

  if (enabled.length > 0 && disabled.length > 0) {
    parts.push(
      disabled.length === 1
        ? `${disabled[0]?.name ?? "One more"} is configured but disabled.`
        : `${disabled.length} more are configured but disabled.`,
    );
  }

  return parts.join(" ");
}
