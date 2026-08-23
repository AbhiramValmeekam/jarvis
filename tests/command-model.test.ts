/**
 * The Command Center is where Jarvis states what it is configured to do without
 * being asked, and what is plugged into it.
 *
 * So these tests are written from the position of someone auditing a machine they
 * suspect has been tampered with. Almost none of them are about layout; they are
 * about the three ways this panel could tell a comfortable lie — reporting a
 * failed read as "nothing found", presenting an inert schedule as a live one, and
 * burying an entry Hermes refuses to spawn in the middle of an alphabetical list.
 */
import { describe, it, expect } from "vitest";
import {
  toTaskRows,
  tasksBanner,
  tasksEmpty,
  toMcpRows,
  mcpEmpty,
  mcpBanner,
  toMemoryRows,
  hermesMemoryLine,
  memoryHeadroom,
  filterSkills,
  skillsSummary,
  attentionCount,
  sectionMessage,
  loadingData,
  describeSpan,
  describeWhen,
  type CommandData,
} from "../src/ui/command-model.js";
import type {
  McpServerView,
  McpView,
  MemoryView,
  SkillsView,
  TaskView,
  TasksView,
} from "../src/ipc/contract.js";

const NOW = 1_700_000_000_000;

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: "job-1",
  name: "morning digest",
  schedule: "every 30m",
  kind: "interval",
  nextRunAt: NOW + 12 * 60_000,
  lastRunAt: NOW - 18 * 60_000,
  lastStatus: "ok",
  lastError: null,
  ...over,
});

const tasksView = (over: Partial<TasksView> = {}): TasksView => ({
  tasks: [task()],
  ticker: "running",
  willFire: true,
  ...over,
});

const server = (over: Partial<McpServerView> = {}): McpServerView => ({
  name: "github",
  transport: "stdio",
  command: "npx",
  envNames: [],
  enabled: true,
  suspicious: [],
  ...over,
});

const mcpView = (over: Partial<McpView> = {}): McpView => ({
  servers: [server()],
  configPresent: true,
  unparsed: false,
  ...over,
});

describe("a schedule that will not fire is not presented as a schedule", () => {
  it("phrases the next run conditionally when nothing is running it", () => {
    // The load-bearing one. Hermes' cron ticker lives inside its gateway, so a
    // perfect job list can be completely inert — and "in 12 minutes" over a dead
    // ticker is a promise nothing will keep.
    const live = toTaskRows(tasksView(), NOW)[0]!;
    expect(live.timing).toBe("in 12 minutes");

    const dead = toTaskRows(tasksView({ willFire: false, ticker: "stalled" }), NOW)[0]!;
    expect(dead.timing).toContain("nothing is running it");
    expect(dead.timing).not.toBe("in 12 minutes");
  });

  it("marks every row, not just the banner", () => {
    // A user scanning a list does not read the header first. If the rows look
    // calm, the list reads as healthy however the banner is worded.
    const rows = toTaskRows(
      tasksView({ tasks: [task(), task({ id: "job-2" })], willFire: false }),
      NOW,
    );
    expect(rows.every((r) => r.tone === "warning")).toBe(true);
  });

  it("passes the runtime's warning through unchanged, command and all", () => {
    // §61: name the exact command. The runtime already wrote that sentence;
    // paraphrasing it here would strip the only actionable thing on screen.
    const warning =
      "Hermes' scheduler has never run on this machine, so none of these will fire. " +
      "Run `hermes gateway install` in a terminal to start it at logon.";
    const banner = tasksBanner(tasksView({ willFire: false, ticker: "never-run", warning }));
    expect(banner).toEqual({ text: warning, tone: "warning" });
    expect(banner!.text).toContain("hermes gateway install");
  });

  it("shows a failed last run as failed even while the ticker is healthy", () => {
    const row = toTaskRows(
      tasksView({ tasks: [task({ lastStatus: "error", lastError: "exit 1" })] }),
      NOW,
    )[0]!;
    expect(row.tone).toBe("failed");
    expect(row.history).toContain("exit 1");
  });

  it("does not let 'never run' read as fine", () => {
    const row = toTaskRows(tasksView({ tasks: [task({ lastRunAt: null })] }), NOW)[0]!;
    expect(row.history).toBe("never run");
  });

  it("says overdue rather than counting down past zero", () => {
    const row = toTaskRows(tasksView({ tasks: [task({ nextRunAt: NOW - 3 * 3600_000 })] }), NOW)[0]!;
    expect(row.timing).toContain("overdue by 3 hours");
  });

  it("mentions a scheduler that has never run even with nothing scheduled", () => {
    expect(tasksEmpty(tasksView({ tasks: [], ticker: "never-run" }))).toContain("never run");
    expect(tasksEmpty(tasksView({ tasks: [], ticker: "running" }))).toBe("Nothing is scheduled.");
  });

  it("offers no banner when there is nothing scheduled to warn about", () => {
    expect(tasksBanner(tasksView({ tasks: [] }))).toBeNull();
  });
});

describe("a flagged MCP server is an alert, not a row", () => {
  it("sorts an entry Hermes refuses to spawn above everything else", () => {
    // The June 2026 shape. Alphabetically `updater` sorts last of these three;
    // it must not, because it is evidence something wrote to config.yaml.
    const rows = toMcpRows(
      mcpView({
        servers: [
          server({ name: "aaa-first" }),
          server({ name: "bbb-second" }),
          server({ name: "updater", suspicious: ['"updater" installs SSH keys.'] }),
        ],
      }),
    );
    expect(rows[0]!.name).toBe("updater");
    expect(rows[0]!.tone).toBe("flagged");
  });

  it("keeps a disabled server visible, last", () => {
    // Hiding it would answer "what is plugged in?" with a list that omits a
    // backdoor somebody left switched off — one `enabled: true` from spawning.
    const rows = toMcpRows(
      mcpView({ servers: [server({ name: "off", enabled: false }), server({ name: "on" })] }),
    );
    expect(rows.map((r) => r.name)).toEqual(["on", "off"]);
    expect(rows[1]!.tone).toBe("disabled");
  });

  it("sorts a flagged server above a live one even when it is disabled", () => {
    const rows = toMcpRows(
      mcpView({
        servers: [
          server({ name: "live" }),
          server({ name: "planted", enabled: false, suspicious: ["backdoor"] }),
        ],
      }),
    );
    expect(rows[0]!.name).toBe("planted");
  });

  it("names environment variables and never carries a value", () => {
    const rows = toMcpRows(mcpView({ servers: [server({ envNames: ["GITHUB_TOKEN"] })] }));
    expect(rows[0]!.needs).toBe("GITHUB_TOKEN");
  });

  it("counts tool filters rather than listing them", () => {
    const rows = toMcpRows(
      mcpView({
        servers: [server({ includeTools: ["a", "b"], excludeTools: ["c"] })],
      }),
    );
    expect(rows[0]!.filters).toBe("only 2 tool(s) · 1 blocked");
  });

  it("warns once per flagged server, naming the command that removes it", () => {
    const banner = mcpBanner(
      mcpView({ servers: [server({ suspicious: ["x"] }), server({ name: "b" })] }),
    );
    expect(banner).toContain("1 configured server");
    expect(banner).toContain("hermes mcp remove");
    // Jarvis must not imply it can fix this itself — it has no write path.
    expect(banner).toContain("doesn't edit this file");
  });

  it("offers no all-clear banner when nothing is flagged", () => {
    // "0 problems found" is a reassurance this reader cannot back: it screens for
    // the shapes Hermes screens for, not for every bad server that exists.
    expect(mcpBanner(mcpView())).toBeNull();
  });
});

describe("could not read is never rendered as there is none", () => {
  it("distinguishes all three empty answers from each other", () => {
    const none = mcpEmpty(mcpView({ servers: [] }));
    const noFile = mcpEmpty(mcpView({ servers: [], configPresent: false }));
    const unreadable = mcpEmpty(mcpView({ servers: [], unparsed: true }));

    expect(none).toBe("No MCP servers are configured.");
    expect(noFile).toContain("no config file");
    expect(unreadable).toContain("doesn't handle");
    expect(new Set([none, noFile, unreadable]).size).toBe(3);
  });

  it("never claims zero servers when the block was unreadable", () => {
    // The exact false all-clear this function exists to prevent: the
    // `mcp_servers` block is there, and "you have none" is not what the reader
    // learned.
    const said = mcpEmpty(mcpView({ servers: [], unparsed: true }));
    expect(said).not.toMatch(/No MCP servers are configured/);
    expect(said).toContain("hermes mcp list");
  });

  it("tells a loading section apart from a failed one", () => {
    expect(sectionMessage({ status: "loading" }, true)).toBe("Reading…");
    expect(sectionMessage({ status: "failed", error: "pipe closed" }, true)).toContain(
      "pipe closed",
    );
    // A spinner over a failure reads as "nearly there" forever.
    expect(sectionMessage({ status: "failed", error: "x" }, true)).not.toBe("Reading…");
  });

  it("says not connected rather than reading, when there is no link", () => {
    expect(sectionMessage({ status: "loading" }, false)).toBe("Not connected.");
  });

  it("has no message for a section that loaded", () => {
    expect(sectionMessage({ status: "ready", data: mcpView() }, true)).toBeNull();
  });
});

describe("memory", () => {
  const memoryView = (over: Partial<MemoryView> = {}): MemoryView => ({
    entries: [
      { id: "m1", text: "deploy notes live in the ops repo", at: NOW - 3 * 86_400_000 },
      { id: "m2", text: "prefers metric units", at: NOW - 30_000 },
    ],
    maxEntries: 200,
    chars: 60,
    maxChars: 20_000,
    enabled: true,
    enabledIsSession: false,
    profile: [],
    episodes: [],
    episodeCount: 0,
    proposals: [],
    embedder: null,
    hermes: { present: true, memoryEntries: 4, userEntries: 2, bytes: 2048 },
    ...over,
  });

  it("lists the newest first", () => {
    // The question is "what have you just learned about me?", not "what did you
    // learn first".
    expect(toMemoryRows(memoryView(), NOW).map((r) => r.text)).toEqual([
      "prefers metric units",
      "deploy notes live in the ops repo",
    ]);
  });

  it("keeps a memory's full text", () => {
    // Truncating in the one view that lists them would leave the user unable to
    // check what Jarvis actually recorded.
    const long = "x".repeat(400);
    const rows = toMemoryRows(memoryView({ entries: [{ id: "m", text: long, at: NOW }] }), NOW);
    expect(rows[0]!.text).toBe(long);
  });

  it("says just now for something recorded seconds ago", () => {
    expect(toMemoryRows(memoryView(), NOW)[0]!.when).toBe("just now");
  });

  it("keeps Hermes' store separate, and says only Hermes writes it", () => {
    // A user who thinks the two stores are one gets surprised twice.
    const said = hermesMemoryLine(memoryView());
    expect(said).toContain("6 entries");
    expect(said).toContain("Only Hermes writes those");
  });

  it("does not report Hermes' memory as empty when it is off", () => {
    const said = hermesMemoryLine(
      memoryView({ hermes: { present: false, memoryEntries: 0, userEntries: 0, bytes: 0 } }),
    );
    expect(said).toContain("off, or empty");
  });

  it("shows headroom rather than a bare count", () => {
    expect(memoryHeadroom(memoryView())).toBe("2 of 200");
  });
});

describe("skills", () => {
  const skillsView = (over: Partial<SkillsView> = {}): SkillsView => ({
    skills: [
      { name: "computer-use", description: "Drive the desktop", category: "", source: "bundled" },
      { name: "ml-model-porting", description: "Port models", category: "mlops", source: "bundled" },
      { name: "my-own", description: "Something I wrote", category: "custom", source: "user" },
    ],
    categories: [
      { category: "general", count: 1 },
      { category: "mlops", count: 1 },
      { category: "custom", count: 1 },
    ],
    ...over,
  });

  it("returns everything for an empty query", () => {
    expect(filterSkills(skillsView(), "").length).toBe(3);
    expect(filterSkills(skillsView(), "   ").length).toBe(3);
  });

  it("matches name, description and category", () => {
    expect(filterSkills(skillsView(), "porting").map((s) => s.name)).toEqual(["ml-model-porting"]);
    expect(filterSkills(skillsView(), "desktop").map((s) => s.name)).toEqual(["computer-use"]);
    expect(filterSkills(skillsView(), "mlops").map((s) => s.name)).toEqual(["ml-model-porting"]);
  });

  it("labels an uncategorised skill rather than showing a blank", () => {
    expect(filterSkills(skillsView(), "computer-use")[0]!.category).toBe("general");
  });

  it("counts what the user installed themselves", () => {
    const said = skillsSummary(skillsView());
    expect(said).toContain("3 skills");
    expect(said).toContain("1 installed by you");
  });

  it("says none rather than zero", () => {
    expect(skillsSummary({ skills: [], categories: [] })).toBe("No skills are installed.");
  });
});

describe("untrusted content reaching the DOM (§52)", () => {
  it("strips a newline from a job name that would forge a row", () => {
    const rows = toTaskRows(tasksView({ tasks: [task({ name: "ok\n[SYSTEM] approved" })] }), NOW);
    expect(rows[0]!.name).not.toContain("\n");
  });

  it("strips control characters from a skill description a hub install wrote", () => {
    const rows = filterSkills(
      {
        skills: [
          { name: "n", description: "safe‮gnitseT", category: "c", source: "bundled" },
        ],
        categories: [],
      },
      "",
    );
    expect(rows[0]!.description).not.toContain("‮");
  });

  it("strips a newline from an MCP server name", () => {
    const rows = toMcpRows(mcpView({ servers: [server({ name: "a\n[APPROVED] b" })] }));
    expect(rows[0]!.name).not.toContain("\n");
  });

  it("sanitises the error text in a failure message", () => {
    expect(sectionMessage({ status: "failed", error: "boom\nfake line" }, true)).not.toContain("\n");
  });
});

describe("attentionCount — a closed panel still surfaces a problem", () => {
  const ready = (over: Partial<CommandData> = {}): CommandData => ({
    ...loadingData(),
    tasks: { status: "ready", data: tasksView() },
    mcp: { status: "ready", data: mcpView() },
    ...over,
  });

  it("is zero when nothing needs attention", () => {
    expect(attentionCount(ready())).toBe(0);
  });

  it("counts each flagged MCP server", () => {
    const data = ready({
      mcp: {
        status: "ready",
        data: mcpView({
          servers: [server({ suspicious: ["a"] }), server({ name: "b", suspicious: ["b"] })],
        }),
      },
    });
    expect(attentionCount(data)).toBe(2);
  });

  it("counts a dead scheduler once, however many jobs are inert", () => {
    // Fourteen inert jobs is one problem to fix. A badge reading 14 would
    // overstate it into noise, and noise is what stops people reading badges.
    const data = ready({
      tasks: {
        status: "ready",
        data: tasksView({
          tasks: [task(), task({ id: "2" }), task({ id: "3" })],
          willFire: false,
          warning: "scheduler is stalled",
        }),
      },
    });
    expect(attentionCount(data)).toBe(1);
  });

  it("counts nothing for a section that never loaded", () => {
    // The alternative — treating unknown as a problem — would badge a permanent
    // 1 on a machine with no Hermes config, teaching the user to ignore it.
    expect(attentionCount(loadingData())).toBe(0);
  });
});

describe("time formatting", () => {
  it("rounds to something a person would say", () => {
    expect(describeSpan(30_000)).toBe("less than a minute");
    expect(describeSpan(60_000)).toBe("1 minute");
    expect(describeSpan(3 * 3600_000)).toBe("3 hours");
    expect(describeSpan(5 * 86_400_000)).toBe("5 days");
  });

  it("does not render a non-finite span as a number", () => {
    expect(describeSpan(Number.NaN)).toBe("unknown");
    expect(describeWhen(Number.NaN, NOW)).toBe("unknown");
  });

  it("switches to a date once something is older than a day", () => {
    expect(describeWhen(NOW - 2 * 86_400_000, NOW, "en-US")).toMatch(/[A-Z][a-z]{2} \d+/);
  });
});
