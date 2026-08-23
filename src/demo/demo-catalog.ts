/**
 * The four demo scenarios (§28), written down as descriptors rather than as a script.
 *
 * §28 asks for "predefined scenarios that execute through the real agent architecture",
 * and the second half of that sentence is what this file is shaped by. A demo mode can
 * be built two ways: a recording that replays convincing output, or a list of objectives
 * that go in the front door. This is the second, and the difference is structural —
 * there is no `runScenario` here and nothing in this module can start anything. What a
 * scenario *is* is an objective string, and a Run button sends it as `start_mission`,
 * which is the identical path a typed objective takes, through the same planner, the
 * same classification, the same consent and the same report (§43, §52).
 *
 * That leaves one honest question a demo has to answer before a judge clicks anything:
 * will this scenario actually run on this machine, right now? Two of the four need a
 * model to plan — the deterministic planner has recipes for a project's readiness, not
 * for an itinerary — and some of the capabilities they name are mocked. So the catalog
 * carries what each scenario *needs*, and `assessDemo` compares that against facts the
 * runtime reads from the tool registry and the provider it actually built. Nothing here
 * asserts that a capability is real; the registry says, and this reports.
 *
 * The distinction between `mocked` and `missing` is the §43 line in one pair of fields.
 * A mocked tool does not block a scenario: `send_email` writes a real record to a real
 * local outbox and every result it produces carries `simulated`, which is a mock adapter
 * doing what §43 asks. A missing tool does block it, because the alternative is a demo
 * that starts a mission whose plan cannot contain the step the scenario is about.
 */

/** The fixtures `demo-workspace.ts` writes. A scenario names what it needs on disk. */
export type DemoFixture = "hackathon-site" | "broken-cli" | "inbox";

/** §28's four, in §28's order. */
export type DemoScenarioId = "hackathon" | "broken-project" | "trip" | "workspace";

/** What a scenario cannot run without. Compared against the runtime's own facts. */
export interface DemoNeeds {
  /** Fixtures that must exist on disk. Empty for a scenario that works anywhere. */
  readonly fixtures: readonly DemoFixture[];
  /**
   * Which planner can plan it.
   *
   * `any` means the deterministic table has a recipe, so the scenario runs with no model
   * configured at all — which is the only kind of demo that survives a judging table
   * with no internet. `llm` means it does not, and saying so is the alternative to a
   * scenario that plans nothing and reports `plan_empty` while a judge watches.
   */
  readonly planner: "any" | "llm";
  /** Tool names the scenario is about. Absent ones block it; mocked ones do not. */
  readonly tools: readonly string[];
}

export interface DemoScenario {
  readonly id: DemoScenarioId;
  /** §28's own numbering, so the window and the specification can be read side by side. */
  readonly ordinal: number;
  /** §28's own name for it. */
  readonly title: string;
  /**
   * The exact string a Run button sends as `start_mission`.
   *
   * Worded to be a *outcome* and never a plan, for the same reason `vision-objective.ts`
   * asks a model for an outcome: the steps belong to the planner, which knows what is
   * registered on this machine. A scenario that named its own steps would be a script
   * with a mission-shaped wrapper.
   */
  readonly objective: string;
  /** Which sections of the specification this scenario is the demonstration of. */
  readonly sections: readonly string[];
  /** What a judge should watch for, in one line. Never a claim about the outcome. */
  readonly watch: string;
  /** §28's own stage list, in order. Display only: the planner decides the steps. */
  readonly stages: readonly string[];
  readonly needs: DemoNeeds;
  /**
   * What this build cannot do inside the scenario, stated up front.
   *
   * §28 scenario 3 ends in "ask approval before booking" and there is no booking tool
   * here; a demo that quietly stopped one step early would be claiming a capability by
   * omission. Optional because two of the four have nothing to declare.
   */
  readonly caveat?: string;
}

/** One tool as the registry reports it. `simulated` is the tool's own flag, never a guess. */
export interface DemoToolFact {
  readonly name: string;
  readonly simulated: boolean;
}

/** What the runtime knows when it is asked whether a scenario can run. */
export interface DemoFacts {
  /** Fixtures found on disk this moment, from `inspectDemoWorkspace`. */
  readonly fixtures: readonly DemoFixture[];
  /** The registry's list. A tool absent from it is absent from this build. */
  readonly tools: readonly DemoToolFact[];
  /** Whether a model will really do the planning — `available` and allowed to plan. */
  readonly llmPlanner: boolean;
  /** One mission at a time, so a running one blocks every scenario. */
  readonly missionRunning: boolean;
}

export type DemoBlockerKind =
  /** The fixtures are not on disk yet. One click away. */
  | "workspace"
  /** No model will plan this one. A configuration change away. */
  | "planner"
  /** A capability this build does not have. Nothing the user can do from here. */
  | "tool"
  /** A mission is running. Transient, and the only blocker that clears itself. */
  | "busy";

export interface DemoBlocker {
  readonly kind: DemoBlockerKind;
  /** One line, in the second person where there is something to do about it. */
  readonly detail: string;
}

/** A scenario plus everything true about it here. Built, never stored. */
export interface DemoAssessment {
  readonly scenario: DemoScenario;
  /** True only when nothing blocks it. A demo that lies about this is worse than none. */
  readonly runnable: boolean;
  /** Cheapest fix first; `busy` last, because waiting is not a fix. */
  readonly blockers: readonly DemoBlocker[];
  /** Registered, and standing in for a capability that is mocked or absent (§43). */
  readonly mocked: readonly string[];
  /** Named by the scenario and not in this build at all. Each is also a blocker. */
  readonly missing: readonly string[];
}

/**
 * §28's four scenarios.
 *
 * The two project scenarios come first because they are the two that run with nothing
 * configured: the deterministic planner has a readiness recipe, the fixture's build
 * really fails for an ordinary reason, and `npm ci` really fixes it — so the failure,
 * the diagnosis, the corrective step and the second attempt in §46's arc are all real
 * on a machine with no model and no network. The other two are the honest opposite:
 * they need a planner that can decompose an objective the table has no recipe for, and
 * the window says so before a judge clicks.
 */
const SCENARIOS: readonly DemoScenario[] = [
  {
    id: "hackathon",
    ordinal: 1,
    title: "Prepare My Hackathon",
    objective:
      "get the hackathon-site project ready for tomorrow: check that it builds and that its tests pass",
    sections: ["§28.1", "§46", "§47"],
    watch:
      "the build fails on a real missing dependency, and the replan installs exactly what the lockfile names",
    stages: [
      "Read calendar",
      "Retrieve user preferences",
      "Locate project",
      "Inspect environment",
      "Run project",
      "Detect errors",
      "Fix safe issues",
      "Run tests",
      "Prepare presentation summary",
      "Generate readiness report",
    ],
    needs: {
      fixtures: ["hackathon-site"],
      planner: "any",
      tools: ["find_project", "run_command", "git_status", "search_memory", "list_calendar_events"],
    },
    caveat:
      "There is no calendar account behind list_calendar_events: it reads a local record and every result it returns is labelled simulated.",
  },
  {
    id: "broken-project",
    ordinal: 2,
    title: "Fix My Project",
    objective: "find out why the broken-cli project fails to build and get its tests passing",
    sections: ["§28.2", "§27", "§18"],
    watch:
      "the diagnosis comes from the build's own recorded output, and a step is verified by a second command rather than by the first one returning",
    stages: ["Inspect", "Diagnose", "Search", "Fix", "Test", "Verify"],
    needs: {
      fixtures: ["broken-cli"],
      planner: "any",
      tools: ["find_project", "run_command"],
    },
  },
  {
    id: "trip",
    ordinal: 3,
    title: "Plan My Trip",
    objective:
      "plan a two-day trip to Bangalore next month on a 12000 rupee budget, using what you already know about how I travel",
    sections: ["§28.3", "§13", "§40"],
    watch:
      "what it retrieves from memory is shown as the rows it actually matched, and every web result carries the source it came from",
    stages: [
      "Search travel options",
      "Remember preferences",
      "Compare alternatives",
      "Calculate budget",
      "Build itinerary",
      "Ask approval before booking",
    ],
    needs: {
      fixtures: [],
      planner: "llm",
      tools: ["web_search", "fetch_web_page", "search_memory", "write_file"],
    },
    caveat:
      "Nothing in this build can book anything, so the last stage is where the mission stops: there is no booking tool to ask approval for, and inventing one would be the failure §43 names.",
  },
  {
    id: "workspace",
    ordinal: 4,
    title: "Organize My Digital Workspace",
    objective:
      "tidy up the demo inbox folder: group the files by what they are and remove the duplicates",
    sections: ["§28.4", "§17", "§33"],
    watch:
      "a delete is level 3, so it stops and asks — and what it deletes goes to the Recycle Bin, which is what makes the undo real",
    stages: [
      "Analyze files",
      "Identify duplicates",
      "Categorize documents",
      "Propose changes",
      "Execute approved organization",
      "Verify result",
    ],
    needs: {
      fixtures: ["inbox"],
      planner: "llm",
      tools: ["list_directory", "read_file", "write_file", "delete_file"],
    },
    caveat:
      "delete_file exists only where a reversible filesystem was wired, because a delete Jarvis cannot take back is not the tool a plan thinks it is.",
  },
];

/** The catalog, in §28's order. */
export function demoScenarios(): readonly DemoScenario[] {
  return SCENARIOS;
}

/** One scenario by id, or null. An unknown id is a bad request, never a default. */
export function findDemoScenario(id: string): DemoScenario | null {
  return SCENARIOS.find((s) => s.id === id) ?? null;
}

/**
 * Everything true about one scenario on this machine, right now.
 *
 * Blockers are ordered by what the person reading them can do about it, cheapest first:
 * prepare the workspace, configure a model, and then the two nobody can act on from a
 * demo panel — a capability this build does not have, and a mission already running.
 *
 * A mocked tool is deliberately not a blocker. `send_email` writes a real record to a
 * real outbox and labels every result `simulated`, which is the mock adapter §43 asks
 * for rather than the pretend success it forbids; blocking on it would hide a capability
 * that genuinely does something checkable. The label travels instead, all the way to the
 * report's own `simulated` count.
 */
export function assessDemo(scenario: DemoScenario, facts: DemoFacts): DemoAssessment {
  const registered = new Map(facts.tools.map((t) => [t.name, t.simulated] as const));
  const missing = scenario.needs.tools.filter((name) => !registered.has(name));
  const mocked = scenario.needs.tools.filter((name) => registered.get(name) === true);

  const blockers: DemoBlocker[] = [];
  const absent = scenario.needs.fixtures.filter((f) => !facts.fixtures.includes(f));
  if (absent.length > 0) {
    blockers.push({
      kind: "workspace",
      detail:
        absent.length === scenario.needs.fixtures.length
          ? "the demo workspace has not been prepared yet"
          : `part of the demo workspace is missing: ${absent.join(", ")}`,
    });
  }
  if (scenario.needs.planner === "llm" && !facts.llmPlanner) {
    blockers.push({
      kind: "planner",
      detail:
        "no model is planning here, and the deterministic planner has no recipe for this objective",
    });
  }
  for (const name of missing) {
    blockers.push({ kind: "tool", detail: `${name} is not registered in this build` });
  }
  if (facts.missionRunning) {
    blockers.push({ kind: "busy", detail: "a mission is already running, and Jarvis runs one at a time" });
  }

  return { scenario, runnable: blockers.length === 0, blockers, mocked, missing };
}

/** The whole catalog, assessed against one set of facts. */
export function assessDemos(facts: DemoFacts): readonly DemoAssessment[] {
  return SCENARIOS.map((s) => assessDemo(s, facts));
}
