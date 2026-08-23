/**
 * The Agent Trace, built from a mission's own log.
 *
 * The assertions that matter here are about the boundary between what Jarvis recorded
 * and what it is willing to say about it:
 *
 *  - **Every `because` traces to a field.** Either the line's own note or a sentence
 *    composed from that line's `event`, `state` or step. No test here can produce a
 *    reason that explains a *choice*, because no such branch exists.
 *  - **A model's sentence is marked as one.** `voice: "model"` survives from the log
 *    line to the entry. A trace that lost it would print a diagnosis in the same voice
 *    as a counted fact (§43).
 *  - **Trimming is visible and it keeps the opening.** A trace that silently showed 200
 *    of 900 lines would be the "no silent caps" failure in the one pane whose whole job
 *    is completeness; one that kept only the tail would be missing the plan it explains.
 *  - **An empty log is a statement, not a blank.** A mission whose log went missing is
 *    one Jarvis cannot account for, and it says so rather than having its account
 *    reconstructed from the state it ended in.
 *
 * No I/O: `trace.ts` reads two arrays and returns one object.
 */
import { describe, it, expect } from "vitest";
import {
  buildTrace,
  engagedRoles,
  traceGap,
  MAX_TRACE_ENTRIES,
  TRACE_HEAD,
} from "../src/missions/trace.js";
import type { LoggedStep, MissionLogLine } from "../src/missions/mission-store.js";
import type { Mission, MissionEvent, MissionState } from "../src/missions/mission-model.js";

const T0 = 1_700_000_000_000;

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: "m1",
    objective: "check whether portfolio-site builds",
    createdAt: T0,
    state: "completed",
    steps: [],
    memory: [],
    planner: "deterministic",
    replans: 0,
    ...over,
  };
}

function step(over: Partial<LoggedStep> = {}): LoggedStep {
  return {
    id: "s1",
    title: "run the build",
    tool: "run_command",
    status: "running",
    attempt: 1,
    origin: "plan",
    ...over,
  };
}

function line(over: Partial<MissionLogLine> = {}): MissionLogLine {
  return {
    at: T0,
    mission: "m1",
    state: "executing" as MissionState,
    ...over,
  };
}

describe("what one line becomes", () => {
  it("gives a known event a fixed sentence and the role that owns it", () => {
    const [entry] = buildTrace(mission(), [line({ event: "planned", state: "retrieving" })])
      .entries;
    expect(entry?.action).toBe("decomposed the objective into a plan");
    expect(entry?.role).toBe("planner");
    expect(entry?.seq).toBe(0);
  });

  it("prefers the line's own note over any sentence it could compose", () => {
    const [entry] = buildTrace(mission(), [
      line({ event: "step_bad", note: "npm run build exited 1", step: step() }),
    ]).entries;
    expect(entry?.because).toBe("npm run build exited 1");
  });

  it("composes a structural reason when the line carried no note", () => {
    const [entry] = buildTrace(mission(), [line({ event: "step_ok", step: step() })]).entries;
    expect(entry?.because).toBe("its check reported the world had changed");
  });

  it("falls back to the state rather than inventing a reason", () => {
    // `replanned` is deliberately absent from the reason table: a general sentence
    // about why a plan changed would read as an explanation and be nothing of the kind.
    const [entry] = buildTrace(mission(), [line({ event: "replanned", state: "replanning" })])
      .entries;
    expect(entry?.action).toBe("changed the plan");
    expect(entry?.because).toBe("the mission was replanning at this point");
  });

  it("records an event it has no name for instead of dropping the line", () => {
    // Dropping it would make a hand-edited log look shorter than it is, and the
    // sentence says only what it can stand behind.
    const [entry] = buildTrace(mission(), [
      line({ event: "reticulate_splines" as MissionEvent }),
    ]).entries;
    expect(entry?.action).toBe("recorded something this build does not have a name for");
  });

  it("names the tool the plan committed to on a step's own line", () => {
    const [entry] = buildTrace(mission(), [line({ step: step() })]).entries;
    expect(entry?.action).toBe("started run the build");
    expect(entry?.because).toBe("the plan named run_command for this");
    expect(entry?.role).toBe("computer");
    expect(entry?.tool).toBe("run_command");
  });

  it("says so when a replan is what added the step", () => {
    const [entry] = buildTrace(mission(), [line({ step: step({ origin: "replan" }) })]).entries;
    expect(entry?.because).toBe("a replan added this step, to be run with run_command");
  });

  it("carries the classification the step had at that moment, and no more", () => {
    // A retry can classify differently from the attempt before it, so the level shown
    // beside a line is the one that line recorded — never the step's final one.
    const first = buildTrace(mission(), [
      line({ event: "need_approval", step: step({ risk: { level: 3, category: "execute" } }) }),
    ]).entries[0];
    expect(first?.risk).toEqual({ level: 3, category: "execute" });
    // A step's opening line is written before anything classifies it, so no risk there
    // is the truth about that moment rather than a missing field.
    expect(buildTrace(mission(), [line({ step: step() })]).entries[0]?.risk).toBeUndefined();
  });

  it("keeps the outcome, the attempt and the simulated flag from the step", () => {
    const [entry] = buildTrace(mission(), [
      line({
        event: "step_ok",
        step: step({ status: "done", outcome: "verified", attempt: 2, simulated: true }),
      }),
    ]).entries;
    expect(entry?.outcome).toBe("verified");
    expect(entry?.attempt).toBe(2);
    expect(entry?.simulated).toBe(true);
  });

  it("lets an event outrank the step it is about", () => {
    const [entry] = buildTrace(mission(), [
      line({ event: "step_ok", step: step({ tool: "web_search" }) }),
    ]).entries;
    // The fact worth recording is that something checked it, not that the web was read.
    expect(entry?.role).toBe("verify");
    expect(entry?.tool).toBe("web_search");
  });

  it("calls a line with neither an event nor a step the opening", () => {
    const [entry] = buildTrace(mission(), [line({ state: "planning" })]).entries;
    expect(entry?.action).toBe("opened the mission");
    expect(entry?.role).toBe("planner");
  });
});

describe("whose words the reason is", () => {
  it("carries `model` from the line to the entry", () => {
    const [entry] = buildTrace(mission(), [
      line({
        event: "replanned",
        state: "replanning",
        note: "the build needs its dependencies installed first",
        voice: "model",
      }),
    ]).entries;
    expect(entry?.because).toBe("the build needs its dependencies installed first");
    expect(entry?.voice).toBe("model");
  });

  it("leaves the flag off a line this repository composed", () => {
    // Absence is the claim that costs nothing to make; a `false` here would be a field
    // some later reader has to know to distrust.
    const [entry] = buildTrace(mission(), [line({ event: "step_ok", step: step() })]).entries;
    expect(entry?.voice).toBeUndefined();
    expect("voice" in (entry ?? {})).toBe(false);
  });
});

describe("the whole trace", () => {
  it("reports the mission's identity and the log's length", () => {
    const trace = buildTrace(mission({ state: "failed" }), [
      line({ state: "planning" }),
      line({ event: "planned", state: "retrieving" }),
    ]);
    expect(trace.missionId).toBe("m1");
    expect(trace.objective).toBe("check whether portfolio-site builds");
    expect(trace.state).toBe("failed");
    expect(trace.lines).toBe(2);
    expect(trace.omitted).toBe(0);
  });

  it("drops a line belonging to another mission", () => {
    // `history()` reads one file, so this only fires on a file edited or renamed by
    // hand — in which case the id in the line is the one that knows.
    const trace = buildTrace(mission(), [
      line({ event: "planned" }),
      line({ mission: "somebody-else", event: "finish" }),
    ]);
    expect(trace.lines).toBe(1);
    expect(trace.entries).toHaveLength(1);
  });

  it("numbers entries by their place in the log", () => {
    const trace = buildTrace(mission(), [line({}), line({ event: "planned" }), line({})]);
    expect(trace.entries.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("counts every role, over the whole log", () => {
    const trace = buildTrace(mission(), [
      line({ state: "planning" }),
      line({ event: "planned", state: "retrieving" }),
      line({ event: "retrieved" }),
      line({ step: step() }),
      line({ event: "step_ok", step: step({ status: "done", outcome: "verified" }) }),
      line({ event: "finish", state: "completed" }),
    ]);
    const byRole = new Map(trace.roles.map((r) => [r.role, r.actions]));
    expect(byRole.get("planner")).toBe(2);
    expect(byRole.get("memory")).toBe(1);
    expect(byRole.get("computer")).toBe(1);
    expect(byRole.get("verify")).toBe(2);
    // Every role is present, with a zero for the ones that did nothing here.
    expect(trace.roles).toHaveLength(7);
    expect(byRole.get("research")).toBe(0);
  });

  it("engages only the roles that acted", () => {
    const trace = buildTrace(mission(), [line({ event: "planned" }), line({ event: "finish" })]);
    expect(engagedRoles(trace).map((r) => r.role)).toEqual(["planner", "verify"]);
  });
});

describe("a trace longer than the ceiling", () => {
  const many = Array.from({ length: MAX_TRACE_ENTRIES + 60 }, (_, i) =>
    line({ at: T0 + i, event: i === 0 ? "planned" : "step_ok", step: step() }),
  );

  it("keeps the opening, keeps the end, and says how much went", () => {
    const trace = buildTrace(mission(), many);
    expect(trace.entries).toHaveLength(MAX_TRACE_ENTRIES);
    expect(trace.lines).toBe(many.length);
    expect(trace.omitted).toBe(60);
    // The beginning of a mission is where the plan is: a trace that opened in the
    // middle of a retry loop would be missing the thing it explains.
    expect(trace.entries[0]?.seq).toBe(0);
    expect(trace.entries[TRACE_HEAD - 1]?.seq).toBe(TRACE_HEAD - 1);
    expect(trace.entries[TRACE_HEAD]?.seq).toBe(TRACE_HEAD + 60);
    expect(trace.entries[trace.entries.length - 1]?.seq).toBe(many.length - 1);
  });

  it("counts engagement over the lines it dropped as well", () => {
    // A truncated trace must not understate what a role did, or the roster would
    // shrink exactly on the missions with the most to account for.
    const trace = buildTrace(mission(), many);
    const total = trace.roles.reduce((sum, r) => sum + r.actions, 0);
    expect(total).toBe(many.length);
  });

  it("trims nothing at the boundary", () => {
    const exact = Array.from({ length: MAX_TRACE_ENTRIES }, () => line({ event: "step_ok" }));
    const trace = buildTrace(mission(), exact);
    expect(trace.entries).toHaveLength(MAX_TRACE_ENTRIES);
    expect(trace.omitted).toBe(0);
  });
});

describe("a mission with no log", () => {
  it("produces no entries rather than an account built from the snapshot", () => {
    const trace = buildTrace(mission({ state: "completed" }), []);
    expect(trace.entries).toEqual([]);
    expect(trace.lines).toBe(0);
    // The state is still reported: it is the mission's own field, not a claim about
    // what happened along the way.
    expect(trace.state).toBe("completed");
  });

  it("says a snapshot with steps is a mission it cannot account for", () => {
    const gap = traceGap(
      mission({
        steps: [
          {
            id: "s1",
            title: "run the build",
            tool: "run_command",
            args: {},
            status: "done",
            attempt: 1,
            origin: "plan",
            optional: false,
            dependsOn: [],
            priority: 1,
          },
        ],
      }),
      [],
    );
    expect(gap?.reason).toContain("log is empty");
    expect(gap?.reason).toContain("1 step(s)");
  });

  it("says a mission that wrote nothing has nothing to account for", () => {
    expect(traceGap(mission(), [])?.reason).toBe(
      "this mission wrote no log, so there is nothing to account for",
    );
  });

  it("reports no gap when there are lines", () => {
    expect(traceGap(mission(), [line({ event: "planned" })])).toBeNull();
  });
});
