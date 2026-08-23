/**
 * The presentation rules of Mission Control, held to account.
 *
 * These are not cosmetic assertions. Each one pins a claim the window makes to a
 * fact the runtime sent: that only a verified step may look like success, that a
 * simulated capability cannot be drawn as a real one, that the progress bar counts
 * settled work rather than activity, and that a missing answer is said rather than
 * filled in. The components are a layout over this file, so this is where those
 * rules can be broken by a refactor and caught by a test.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_STREAM_LINES,
  applyEvent,
  awaitingStep,
  canStart,
  durationLabel,
  emptyMessage,
  emptyScreen,
  failed,
  focusMission,
  historyRows,
  planLanes,
  plannerLook,
  policyRows,
  progress,
  reportHeadline,
  startBlockedReason,
  startedSubmitting,
  stateLook,
  stepLook,
  toolRows,
  type MissionScreen,
} from "../src/ui/mission-model.js";
import type {
  MissionCountsView,
  MissionDetailView,
  MissionReportView,
  MissionStepView,
  MissionView,
  RuntimeStatus,
  ServerEvent,
  ToolPolicyEntry,
  ToolsView,
} from "../src/ipc/contract.js";

const counts = (over: Partial<MissionCountsView> = {}): MissionCountsView => ({
  total: 0,
  done: 0,
  unverified: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
  pending: 0,
  running: 0,
  awaitingApproval: 0,
  corrective: 0,
  simulated: 0,
  ...over,
});

const step = (over: Partial<MissionStepView> = {}): MissionStepView => ({
  id: "s1",
  title: "Check the build",
  tool: "terminal.run",
  status: "pending",
  attempt: 1,
  origin: "plan",
  priority: 1,
  optional: false,
  dependsOn: [],
  ...over,
});

const mission = (over: Partial<MissionView> = {}): MissionView => ({
  id: "m1",
  objective: "Get the project ready",
  state: "executing",
  terminal: false,
  createdAt: 1_000,
  planner: "deterministic",
  replans: 0,
  counts: counts(),
  steps: [],
  memory: [],
  ...over,
});

const report = (over: Partial<MissionReportView> = {}): MissionReportView => ({
  missionId: "m1",
  objective: "Get the project ready",
  state: "completed",
  headline: "Verified 2 of 2 steps.",
  durationMs: 1_500,
  counts: counts({ total: 2, done: 2 }),
  planner: "deterministic",
  replans: 0,
  recovered: [],
  verified: [],
  outstanding: [],
  simulated: [],
  tools: [],
  memory: [],
  ...over,
});

const detail = (over: Partial<MissionDetailView> = {}): MissionDetailView => ({
  mission: mission(),
  report: report(),
  ...over,
});

/** A screen already watching `m1`, which is what most of these rules are about. */
const watching = (m: MissionView = mission()): MissionScreen => ({
  ...emptyScreen,
  mission: m,
});

describe("applyEvent", () => {
  it("returns the screen untouched for everything that is not a mission event", () => {
    const screen = watching();
    const other: ServerEvent = { type: "state", state: "idle" } as ServerEvent;
    expect(applyEvent(screen, other)).toBe(screen);
  });

  it("ignores steps and notes belonging to a different mission", () => {
    // The runtime broadcasts to every client, so a foreign mission's events do
    // arrive here. Folding them in would caption one plan with another's work.
    const screen = watching();
    const foreignStep: ServerEvent = {
      type: "mission_step",
      missionId: "other",
      step: step({ id: "x1" }),
    };
    const foreignNote: ServerEvent = {
      type: "mission_event",
      missionId: "other",
      at: 2_000,
      transition: "step_ok",
      note: "did something",
    };
    expect(applyEvent(screen, foreignStep)).toBe(screen);
    expect(applyEvent(screen, foreignNote)).toBe(screen);
  });

  it("keeps the newest objective when an older mission broadcasts late", () => {
    const screen = watching(mission({ id: "new", createdAt: 5_000 }));
    const stale: ServerEvent = {
      type: "mission",
      mission: mission({ id: "old", createdAt: 1_000 }),
    };
    expect(applyEvent(screen, stale).mission?.id).toBe("new");
  });

  it("switches to a newer mission and drops the old stream and report", () => {
    const screen: MissionScreen = {
      ...watching(mission({ id: "old", createdAt: 1_000 })),
      report: report(),
      stream: [{ key: "k", time: "00:00:01", text: "old line", tone: "ordinary" }],
    };
    const next = applyEvent(screen, {
      type: "mission",
      mission: mission({ id: "new", createdAt: 9_000 }),
    });
    expect(next.mission?.id).toBe("new");
    expect(next.report).toBeNull();
    expect(next.stream).toEqual([]);
  });

  it("keeps the stream when the same mission is updated", () => {
    const screen: MissionScreen = {
      ...watching(),
      stream: [{ key: "k", time: "00:00:01", text: "a line", tone: "ordinary" }],
    };
    const next = applyEvent(screen, { type: "mission", mission: mission({ state: "verifying" }) });
    expect(next.stream).toHaveLength(1);
    expect(next.mission?.state).toBe("verifying");
  });

  it("replaces a known step and appends an unknown one", () => {
    const screen = watching(mission({ steps: [step({ id: "s1", status: "running" })] }));
    const replaced = applyEvent(screen, {
      type: "mission_step",
      missionId: "m1",
      step: step({ id: "s1", status: "done", outcome: "verified" }),
    });
    expect(replaced.mission?.steps).toHaveLength(1);
    expect(replaced.mission?.steps[0]?.status).toBe("done");

    // A corrective step can arrive before the rewritten plan does.
    const appended = applyEvent(replaced, {
      type: "mission_step",
      missionId: "m1",
      step: step({ id: "s2", origin: "replan" }),
    });
    expect(appended.mission?.steps.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("caps the stream and keeps the newest lines", () => {
    let screen = watching();
    for (let i = 0; i < MAX_STREAM_LINES + 25; i += 1) {
      screen = applyEvent(screen, {
        type: "mission_event",
        missionId: "m1",
        at: 1_000 + i,
        transition: "step_ok",
        note: `line ${i}`,
      });
    }
    expect(screen.stream).toHaveLength(MAX_STREAM_LINES);
    expect(screen.stream[screen.stream.length - 1]?.text).toBe(
      `line ${MAX_STREAM_LINES + 24}`,
    );
  });

  it("tones a note by the transition, and treats an unknown one as ordinary", () => {
    const note = (transition: string): string =>
      applyEvent(watching(), {
        type: "mission_event",
        missionId: "m1",
        at: 1_000,
        transition,
        note: "n",
      }).stream[0]!.tone;
    expect(note("step_bad")).toBe("problem");
    expect(note("need_approval")).toBe("approval");
    expect(note("finish")).toBe("good");
    // Unrecognised, not dropped: it still happened, and crying wolf is worse.
    expect(note("something_new")).toBe("ordinary");
  });
});

describe("submitting and failing", () => {
  it("clears submitting once the mission arrives", () => {
    const sent = startedSubmitting(emptyScreen);
    expect(sent.submitting).toBe(true);
    const arrived = applyEvent(sent, { type: "mission", mission: mission() });
    expect(arrived.submitting).toBe(false);
  });

  it("keeps the mission on screen when a request fails", () => {
    // A refused start says nothing about the mission that already ran.
    const screen = failed(watching(), "runtime refused");
    expect(screen.error).toBe("runtime refused");
    expect(screen.mission?.id).toBe("m1");
  });

  it("keeps a live stream when the same mission is re-read", () => {
    const screen: MissionScreen = {
      ...watching(),
      stream: [{ key: "k", time: "00:00:01", text: "a line", tone: "ordinary" }],
    };
    expect(focusMission(screen, detail()).stream).toHaveLength(1);
    expect(focusMission(screen, detail({ mission: mission({ id: "m2" }) })).stream).toEqual([]);
  });
});

describe("what a step is allowed to look like", () => {
  it("calls only a verified step a success", () => {
    expect(stepLook(step({ status: "done", outcome: "verified" }))).toMatchObject({
      tone: "verified",
      label: "Verified",
    });
  });

  it("gives an unverified step its own words rather than a paler green", () => {
    const look = stepLook(step({ status: "unverified", outcome: "unconfirmed" }));
    expect(look.tone).toBe("unverified");
    expect(look.label).toBe("Ran, but nothing confirmed it");
  });

  it("demotes a done step whose outcome does not support it", () => {
    // Upstream cannot produce this. If it ever does, the tick is not drawn.
    const look = stepLook(step({ status: "done", outcome: "unchecked" }));
    expect(look.tone).toBe("unverified");
    expect(look.label).toBe("Reported done, but nothing confirmed it");
  });

  it("puts simulated first among the badges and never omits it", () => {
    const look = stepLook(
      step({
        simulated: true,
        risk: { level: 3, category: "filesystem" },
        attempt: 2,
        origin: "replan",
        optional: true,
      }),
    );
    expect(look.badges[0]).toBe("simulated");
    expect(look.badges).toEqual([
      "simulated",
      "level 3 filesystem",
      "attempt 2",
      "added after a failure",
      "optional",
    ]);
  });

  it("shows no level until something has classified the call", () => {
    expect(stepLook(step()).badges).toEqual([]);
  });

  it("finds the step a mission is parked on, and nothing when it is not", () => {
    const parked = step({ id: "s2", status: "awaiting_approval" });
    expect(awaitingStep(mission({ steps: [step(), parked] }))?.id).toBe("s2");
    expect(awaitingStep(mission({ steps: [step()] }))).toBeNull();
    expect(awaitingStep(null)).toBeNull();
  });
});

describe("mission state", () => {
  it("reads terminal from the runtime rather than from the label", () => {
    expect(stateLook(mission({ state: "executing", terminal: false })).live).toBe(true);
    expect(stateLook(mission({ state: "completed", terminal: true })).live).toBe(false);
    // A state this build has no words for is still over if the runtime says so.
    expect(stateLook(mission({ state: "something_new", terminal: true }))).toMatchObject({
      tone: "muted",
      live: false,
    });
  });

  it("does not colour a blocked or waiting mission as progress", () => {
    expect(stateLook(mission({ state: "waiting_approval" })).tone).toBe("waiting");
    expect(stateLook(mission({ state: "blocked", terminal: true })).tone).toBe("bad");
  });
});

describe("the plan graph", () => {
  it("lanes steps by the longest chain behind them", () => {
    const lanes = planLanes([
      step({ id: "a" }),
      step({ id: "b", dependsOn: ["a"] }),
      step({ id: "c", dependsOn: ["a"] }),
      step({ id: "d", dependsOn: ["b", "c"] }),
    ]);
    expect(lanes.map((l) => [l.depth, l.steps.map((s) => s.id)])).toEqual([
      [0, ["a"]],
      [1, ["b", "c"]],
      [2, ["d"]],
    ]);
  });

  it("orders a lane by priority, then by the plan's own order", () => {
    const lanes = planLanes([
      step({ id: "late", priority: 9 }),
      step({ id: "first", priority: 1 }),
      step({ id: "also-first", priority: 1 }),
    ]);
    expect(lanes[0]?.steps.map((s) => s.id)).toEqual(["first", "also-first", "late"]);
  });

  it("survives a cycle and a dependency that is not in the plan", () => {
    // An always-on window must not go blank because a planner emitted a loop.
    const cyclic = planLanes([
      step({ id: "a", dependsOn: ["b"] }),
      step({ id: "b", dependsOn: ["a"] }),
    ]);
    expect(cyclic.flatMap((l) => l.steps.map((s) => s.id)).sort()).toEqual(["a", "b"]);
    const dangling = planLanes([step({ id: "a", dependsOn: ["ghost"] })]);
    expect(dangling).toEqual([{ depth: 0, steps: [expect.objectContaining({ id: "a" })] }]);
  });
});

describe("progress", () => {
  it("counts verified steps and nothing else", () => {
    const bar = progress(counts({ total: 5, done: 2, running: 1, unverified: 1, failed: 1 }));
    expect(bar).toEqual({ verified: 2, total: 5, percent: 40, unverified: 1, failed: 1 });
  });

  it("does not credit a mission that only looks busy", () => {
    // The number that would mislead at the moment a person decides to intervene.
    expect(progress(counts({ total: 4, running: 2, unverified: 2 })).percent).toBe(0);
  });

  it("stays sane on an empty or impossible count", () => {
    expect(progress(counts()).percent).toBe(0);
    expect(progress(counts({ total: 2, done: 9 })).verified).toBe(2);
  });
});

describe("durations", () => {
  it("keeps an unknown duration unknown", () => {
    expect(durationLabel(null)).toBe("—");
    expect(durationLabel(undefined)).toBe("—");
    expect(durationLabel(Number.NaN)).toBe("—");
  });

  it("scales the unit to the length", () => {
    expect(durationLabel(420)).toBe("420 ms");
    expect(durationLabel(1_500)).toBe("1.5 s");
    expect(durationLabel(125_000)).toBe("2 m 05 s");
  });
});

describe("the console", () => {
  const facts = { connected: true, busy: false, submitting: false };

  it("needs a connection, a free loop and an actual objective", () => {
    expect(canStart(facts, "ship it")).toBe(true);
    expect(canStart(facts, "   ")).toBe(false);
    expect(canStart({ ...facts, connected: false }, "ship it")).toBe(false);
    expect(canStart({ ...facts, busy: true }, "ship it")).toBe(false);
    expect(canStart({ ...facts, submitting: true }, "ship it")).toBe(false);
  });

  it("always says why it is closed", () => {
    expect(startBlockedReason(facts)).toBeNull();
    expect(startBlockedReason({ ...facts, connected: false })).toMatch(/not connected/i);
    expect(startBlockedReason({ ...facts, busy: true })).toMatch(/already running/i);
    expect(startBlockedReason({ ...facts, submitting: true })).toMatch(/sending/i);
  });

  it("separates nothing-yet from could-not-ask", () => {
    expect(emptyMessage(true)).toMatch(/no mission yet/i);
    expect(emptyMessage(false)).toMatch(/not connected/i);
  });
});

describe("lists", () => {
  it("takes live from the runtime's running ids, not from a state string", () => {
    // A runtime that restarted mid-mission leaves a row saying `executing`.
    const rows = historyRows(
      [mission({ id: "a", createdAt: 1 }), mission({ id: "b", createdAt: 2 })],
      ["b"],
      "en-US",
    );
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows.map((r) => r.live)).toEqual([true, false]);
  });

  it("sorts tools by category then name and keeps the simulated flag", () => {
    const rows = toolRows([
      { name: "git.status", summary: "s", typicalLevel: 0, category: "git", simulated: false, role: "coding" },
      { name: "web.search", summary: "s", typicalLevel: 1, category: "web", simulated: true, role: "research" },
      { name: "git.log", summary: "s", typicalLevel: 0, category: "git", simulated: false, role: "coding" },
    ]);
    expect(rows.map((r) => r.name)).toEqual(["git.log", "git.status", "web.search"]);
    expect(rows[2]?.simulated).toBe(true);
  });
});

/**
 * The policy panel's sentences, which are the only part of §42 a person reads.
 *
 * The buttons are a layout over `policyRows`, so every claim the panel makes about
 * what a mission may do is made here. Three of them are the ones worth breaking a
 * build over: `auto` must not be described as silence, `default` must not be
 * described as nothing, and a session override must say it is one.
 */
describe("the policy table", () => {
  const entry = (over: Partial<ToolPolicyEntry> = {}): ToolPolicyEntry => ({
    category: "network",
    effective: "default",
    source: "default",
    configured: null,
    ...over,
  });

  const view = (
    policy: readonly ToolPolicyEntry[],
    tools: ToolsView["tools"] = [],
  ): ToolsView => ({
    tools: [...tools],
    policy: [...policy],
    autoAllowUpTo: 1,
    autoCeiling: 3,
  });

  it("says nothing at all before the runtime has answered", () => {
    // Not an empty table with every class shown as permitted: a panel that drew
    // itself from no data would be describing an engine it has not heard from.
    expect(policyRows(null)).toEqual([]);
  });

  it("keeps the runtime's order and counts the tools of each class", () => {
    const rows = policyRows(
      view([entry({ category: "read" }), entry({ category: "delete" })], [
        { name: "read_file", summary: "s", typicalLevel: 0, category: "read", simulated: false, role: "computer" },
        { name: "find_project", summary: "s", typicalLevel: 0, category: "read", simulated: false, role: "coding" },
        { name: "send_email", summary: "s", typicalLevel: 3, category: "network", simulated: true, role: "computer" },
      ]),
    );
    expect(rows.map((r) => r.category)).toEqual(["read", "delete"]);
    expect(rows[0]?.tools).toBe(2);
    // Listed even though nothing here classifies as it. A class hidden until
    // something used it would be hidden exactly until it mattered.
    expect(rows[1]?.tools).toBe(0);
  });

  it("does not describe `auto` as silence, because level 4 still asks", () => {
    const row = policyRows(view([entry({ effective: "auto", source: "config", configured: "auto" })]))[0];
    expect(row?.selected).toBe("auto");
    expect(row?.explain).toContain("without asking");
    expect(row?.explain).toContain("level 4");
    expect(row?.explain).toContain("config.json");
    expect(row?.temporary).toBe(false);
  });

  it("names the level rule rather than calling the default nothing", () => {
    const row = policyRows(view([entry()]))[0];
    expect(row?.selected).toBe("default");
    expect(row?.explain).toContain("level 1 and below runs");
    expect(row?.explain).toContain("above that asks");
  });

  it("calls a denial an answer, not a fault", () => {
    // The distinction the orchestrator draws — `blocked`, not `failed` — has to
    // survive into the sentence, or the panel teaches the opposite of the code.
    const row = policyRows(view([entry({ effective: "deny", source: "config", configured: "deny" })]))[0];
    expect(row?.explain).toContain("blocked");
    expect(row?.explain).toContain("not a fault");
  });

  it("says that `approval` outranks an earlier always-allow", () => {
    const row = policyRows(view([entry({ effective: "approval", source: "config", configured: "approval" })]))[0];
    expect(row?.explain).toContain("asks first");
    expect(row?.explain).toContain("allowed before");
  });

  it("marks a session choice as temporary and says what it overrode", () => {
    const row = policyRows(
      view([entry({ effective: "auto", source: "session", configured: "deny" })]),
    )[0];
    expect(row?.temporary).toBe(true);
    expect(row?.explain).toContain("a restart forgets it");
    expect(row?.explain).toContain('config.json\'s "deny"');
  });

  it("flattens a class name rather than trusting it to be one word", () => {
    // The category comes from the wire. It is the engine's own vocabulary today,
    // and this layer still refuses to lay out something it has not sanitised.
    const row = policyRows(view([entry({ category: "net\nwork" })]))[0];
    expect(row?.category).toBe("net work");
  });
});

describe("the report", () => {
  it("says nothing rather than inventing a headline", () => {
    expect(reportHeadline(null)).toBeNull();
    expect(reportHeadline(report({ headline: "Verified 2 of 2 steps." }))).toBe(
      "Verified 2 of 2 steps.",
    );
  });
});

const llm = (over: Partial<RuntimeStatus["llm"]> = {}): { llm: RuntimeStatus["llm"] } => ({
  llm: {
    provider: "offline",
    model: "none",
    available: false,
    simulated: true,
    acceptsImages: false,
    note: "no model is configured",
    planning: false,
    ...over,
  },
});

describe("the planner badge", () => {
  it("says it does not know before the runtime has answered", () => {
    // Not "built-in": that would be a claim about a runtime we have not heard from.
    expect(plannerLook(null)).toMatchObject({ label: "Planner: unknown", tone: "muted" });
  });

  it("says built-in when there is no model, and carries the reason in the tooltip", () => {
    const look = plannerLook(llm({ note: "ANTHROPIC_API_KEY is not set" }));

    expect(look).toEqual({
      label: "Planner: built-in",
      detail: "ANTHROPIC_API_KEY is not set",
      tone: "muted",
    });
  });

  it("distinguishes a model that is absent from one that is switched off", () => {
    const off = plannerLook(
      llm({ provider: "anthropic", model: "claude-opus-5", available: true, simulated: false, note: "configured", planning: false }),
    );

    // §43 again, in the smallest possible place: the badge may not read like a live
    // model when nothing will call it, and may not read like an absent one either.
    expect(off.label).toBe("Planner: built-in (claude-opus-5 available)");
    expect(off.detail).toContain("llmPlanner is off");
    expect(off.tone).toBe("muted");
  });

  it("names the model only when the model will actually plan", () => {
    const live = plannerLook(
      llm({ provider: "anthropic", model: "claude-opus-5", available: true, simulated: false, note: "configured for the API", planning: true }),
    );

    expect(live).toEqual({
      label: "Planner: claude-opus-5",
      detail: "anthropic · configured for the API",
      tone: "live",
    });
  });

  it("cannot be made to render a control character or a note of any length", () => {
    const look = plannerLook(
      llm({ available: true, planning: true, model: `a\u0007b${"c".repeat(80)}`, note: "x".repeat(500) }),
    );

    // Both the model name and the note come from a server the user pointed Jarvis
    // at, so neither may carry an invisible character or set the badge's width.
    expect(look.label).not.toContain("\u0007");
    expect(look.label.length).toBeLessThanOrEqual("Planner: ".length + 40);
    expect(look.detail.length).toBeLessThanOrEqual("offline · ".length + 200);
  });
});
