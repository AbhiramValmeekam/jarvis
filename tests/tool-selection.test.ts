import { describe, it, expect } from "vitest";
import type { McpServer } from "../src/mcp/mcp-store.js";
import {
  DEFAULT_MAX_SERVERS,
  scoreServer,
  selectServers,
} from "../src/mcp/tool-selection.js";

function server(over: Partial<McpServer> = {}): McpServer {
  return {
    name: "github",
    transport: "stdio",
    command: "npx",
    args: [],
    url: "",
    envNames: [],
    enabled: true,
    includeTools: [],
    excludeTools: [],
    suspicious: [],
    ...over,
  };
}

describe("scoreServer", () => {
  it("scores a server the user named by name", () => {
    const s = scoreServer(server({ name: "linear" }), "check my linear issues");
    expect(s.score).toBeGreaterThan(0);
    expect(s.matched).toContain("linear");
  });

  it("weights the server name above a tool name", () => {
    // A tool called `list_issues` exists on several servers; the one the user
    // actually named has to win, or "check my linear issues" opens GitHub.
    const named = scoreServer(server({ name: "linear" }), "linear");
    const viaTool = scoreServer(
      server({ name: "github", includeTools: ["linear_sync"] }),
      "linear",
    );
    expect(named.score).toBeGreaterThan(viaTool.score);
  });

  it("ignores an exclude list, which names what the server cannot do", () => {
    // Scoring against `exclude` would rank a server highest for the one
    // capability it was deliberately stripped of.
    const s = scoreServer(
      server({ name: "fs", excludeTools: ["delete_file"] }),
      "delete a file",
    );
    expect(s.score).toBe(0);
  });

  it("scores zero on an utterance made entirely of stop words", () => {
    expect(scoreServer(server(), "what can you do for me").score).toBe(0);
  });

  it("reads camelCase tool names as words", () => {
    const s = scoreServer(server({ name: "x", includeTools: ["createIssue"] }), "create an issue");
    expect(s.matched).toContain("create");
  });

  it("does not double-count a word that appears in both name and tools", () => {
    const s = scoreServer(
      server({ name: "notion", includeTools: ["notion_search"] }),
      "notion",
    );
    expect(s.matched.filter((w) => w === "notion")).toHaveLength(1);
  });
});

describe("selectServers", () => {
  it("ranks the named server first", () => {
    const picked = selectServers(
      [server({ name: "github" }), server({ name: "linear" }), server({ name: "slack" })],
      "open my linear issues",
    );
    expect(picked[0]!.name).toBe("linear");
  });

  it("returns everything eligible when nothing scores, rather than guessing", () => {
    // The asymmetry that drives this: omitting a server the user meant costs a
    // wrong answer, including one they didn't costs a longer sentence.
    const all = [server({ name: "a" }), server({ name: "b" })];
    expect(selectServers(all, "hello there").map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("drops a suspicious server, which Hermes will refuse to spawn anyway", () => {
    const picked = selectServers(
      [
        server({ name: "updater", suspicious: ["that is a backdoor, not an MCP server."] }),
        server({ name: "github" }),
      ],
      "updater",
    );
    // Named directly and still not returned: pointing the user at an entry that
    // will never connect is worse than saying nothing.
    expect(picked.map((s) => s.name)).toEqual(["github"]);
  });

  it("drops a disabled server even when the user names it", () => {
    const picked = selectServers([server({ name: "slack", enabled: false })], "slack");
    expect(picked).toEqual([]);
  });

  it("caps the result, and honours an explicit max", () => {
    const many = Array.from({ length: 9 }, (_, i) => server({ name: `s${i}` }));
    expect(selectServers(many, "nothing matches")).toHaveLength(DEFAULT_MAX_SERVERS);
    expect(selectServers(many, "nothing matches", { max: 2 })).toHaveLength(2);
    // And with signal: two hits, capped to one.
    expect(
      selectServers([server({ name: "linear" }), server({ name: "slack" })], "linear slack", {
        max: 1,
      }),
    ).toHaveLength(1);
  });

  it("returns nothing when nothing is eligible", () => {
    expect(selectServers([], "linear")).toEqual([]);
    expect(selectServers([server({ enabled: false })], "github")).toEqual([]);
  });

  it("is a ranking and not a gate — every returned server is one already in the prompt", () => {
    // The load-bearing property, and the reason this module's header was
    // rewritten: ACP `mcpServers` is additive-only, so a caller must never read
    // this list as "the others are now off". Selecting a subset must therefore
    // never produce a server that was not in the input.
    const all = [server({ name: "a" }), server({ name: "b" }), server({ name: "c" })];
    const picked = selectServers(all, "a");
    for (const p of picked) expect(all).toContain(p);
    expect(picked.length).toBeLessThanOrEqual(all.length);
  });
});
