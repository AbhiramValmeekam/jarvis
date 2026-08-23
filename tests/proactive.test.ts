import { describe, it, expect } from "vitest";
import { ageLabel, MAX_SUGGESTIONS, QUIET_MS, suggest } from "../src/world/proactive.js";
import {
  buildWorld,
  type MissionFact,
  type ProjectFact,
  type TaskFact,
  type WindowFact,
  type WorldInput,
} from "../src/world/world-model.js";
import { DeterministicPlanner } from "../src/missions/plan-builder.js";
import { aliasesForProject } from "../src/context/project-registry.js";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

const portal: ProjectFact = {
  key: "portfolio-site",
  name: "portfolio-site",
  dir: "C:\\dev\\portfolio-site",
  kind: "node",
};

/** A mission that ran a step inside the project, so the edge is not name-based. */
function ran(over: Partial<MissionFact> = {}): MissionFact {
  return {
    id: "m1",
    objective: "check whether portfolio-site builds",
    state: "failed",
    createdAt: T0 - HOUR,
    finishedAt: T0 - HOUR,
    steps: [{ tool: "terminal.run", args: { cwd: portal.dir } }],
    ...over,
  };
}

function job(over: Partial<TaskFact> = {}): TaskFact {
  return {
    id: "j1",
    name: "portfolio-site nightly",
    schedule: "0 2 * * *",
    enabled: true,
    lastRunAt: T0 - 2 * HOUR,
    lastStatus: "error",
    lastError: "npm run build exited 1",
    ...over,
  };
}

function editorOn(project: string): WindowFact {
  return {
    title: `index.ts — ${project}`,
    process: "Code.exe",
    kind: "editor",
    hasTitle: true,
    origin: "local",
  };
}

function world(input: Partial<WorldInput> = {}) {
  return buildWorld({ at: T0, ...input });
}

describe("ageLabel", () => {
  it("says just now, and then counts in the largest unit that fits", () => {
    expect(ageLabel(0)).toBe("just now");
    expect(ageLabel(60_000)).toBe("1 minute ago");
    expect(ageLabel(90 * 60_000)).toBe("2 hours ago");
    expect(ageLabel(3 * 24 * HOUR)).toBe("3 days ago");
  });
});

describe("a project left failing", () => {
  it("offers to check it again, and cites the mission that failed", () => {
    const [only, ...rest] = suggest(world({ projects: [portal], missions: [ran()] }));
    expect(rest).toEqual([]);
    expect(only?.rule).toBe("left-failing");
    expect(only?.objective).toBe(
      "check whether portfolio-site still builds and its tests pass",
    );
    expect(only?.because[0]).toContain("mission m1");
    expect(only?.because[0]).toContain("1 hour ago");
    expect(only?.entityId).toBe("project:portfolio-site");
  });

  it("quotes the mission's own reason when it recorded one", () => {
    const [only] = suggest(
      world({ projects: [portal], missions: [ran({ conclusion: "npm run build exited 1" })] }),
    );
    expect(only?.because.some((b) => b.includes("npm run build exited 1"))).toBe(true);
  });

  it("says nothing about a mission that completed", () => {
    expect(suggest(world({ projects: [portal], missions: [ran({ state: "completed" })] }))).toEqual(
      [],
    );
  });

  it("says nothing about a mission the user refused at a prompt", () => {
    // `blocked` is a decision the user already made. Raising it again would be
    // Jarvis asking a second time for something it was told no about.
    expect(suggest(world({ projects: [portal], missions: [ran({ state: "blocked" })] }))).toEqual(
      [],
    );
  });

  it("says nothing about a mission the user cancelled by hand", () => {
    expect(suggest(world({ projects: [portal], missions: [ran({ state: "cancelled" })] }))).toEqual(
      [],
    );
  });

  it("looks only at the newest mission on the project", () => {
    const w = world({
      projects: [portal],
      missions: [
        ran({ id: "new", state: "completed", finishedAt: T0 - 60_000 }),
        ran({ id: "old", state: "failed", finishedAt: T0 - 5 * HOUR }),
      ],
    });
    expect(suggest(w)).toEqual([]);
  });
});

describe("a scheduled job reporting an error", () => {
  it("needs a non-steerable record agreeing before it may act on a job name", () => {
    // The job's name is the only thing linking it to the project, and a job name is
    // written by an agent turn. On its own it draws an edge and decides nothing.
    const alone = world({ projects: [portal], tasks: [job()] });
    expect(suggest(alone)).toEqual([]);

    // A mission that actually ran in the directory is the corroboration.
    const corroborated = world({
      projects: [portal],
      tasks: [job()],
      missions: [ran({ state: "completed" })],
    });
    const [only] = suggest(corroborated);
    expect(only?.rule).toBe("job-failing");
    expect(only?.because.some((b) => b.includes("npm run build exited 1"))).toBe(true);
    expect(only?.because.some((b) => b.includes("missions here have worked on"))).toBe(true);
  });

  it("stays quiet about a job whose last run was fine", () => {
    const w = world({
      projects: [portal],
      tasks: [job({ lastStatus: "ok", lastError: null })],
      missions: [ran({ state: "completed" })],
    });
    expect(suggest(w)).toEqual([]);
  });

  it("does not double up when the same project already has a failing mission", () => {
    const w = world({ projects: [portal], tasks: [job()], missions: [ran()] });
    const out = suggest(w);
    expect(out).toHaveLength(1);
    expect(out[0]?.rule).toBe("left-failing");
  });
});

describe("a project the user is in that nothing has looked at", () => {
  it("offers to show what changed when no mission has ever touched it", () => {
    const w = world({ projects: [portal], window: editorOn("portfolio-site") });
    const [only] = suggest(w);
    expect(only?.rule).toBe("focused-untouched");
    expect(only?.objective).toBe("show what has changed in portfolio-site");
    expect(only?.because.some((b) => b.includes("no mission has ever looked at"))).toBe(true);
  });

  it("stays quiet while a mission has run against it recently", () => {
    const w = world({
      projects: [portal],
      window: editorOn("portfolio-site"),
      missions: [ran({ state: "completed", finishedAt: T0 - HOUR })],
    });
    expect(suggest(w)).toEqual([]);
  });

  it("speaks again once the project has been quiet long enough", () => {
    const w = world({
      projects: [portal],
      window: editorOn("portfolio-site"),
      missions: [
        ran({ state: "completed", createdAt: T0 - QUIET_MS - HOUR, finishedAt: T0 - QUIET_MS - HOUR }),
      ],
    });
    expect(suggest(w).map((s) => s.rule)).toEqual(["focused-untouched"]);
  });

  it("will not act on a project named only by a web page's title", () => {
    // The edge is still drawn — see `world-model.test.ts` — but a title chosen by
    // whatever a browser loaded may agree and may not decide (§52).
    const w = world({
      projects: [portal],
      window: {
        title: "portfolio-site build errors — Stack Overflow",
        process: "chrome.exe",
        kind: "browser",
        hasTitle: true,
        origin: "web",
      },
    });
    expect(w.focus?.projectId).toBe("project:portfolio-site");
    expect(suggest(w)).toEqual([]);
  });
});

describe("the shape of the list", () => {
  const ledger: ProjectFact = { key: "ledger", name: "ledger", dir: "C:\\dev\\ledger", kind: "node" };

  it("puts a broken build ahead of a project nobody has checked", () => {
    const w = world({
      projects: [portal, ledger],
      missions: [ran()],
      window: editorOn("ledger"),
    });
    expect(suggest(w).map((s) => s.rule)).toEqual(["left-failing", "focused-untouched"]);
  });

  it("caps the list, and is stable about which ones survive", () => {
    const many = Array.from({ length: MAX_SUGGESTIONS + 3 }, (_, i) => ({
      key: `p${i}`,
      name: `project-${i}`,
      dir: `C:\\dev\\project-${i}`,
      kind: "node",
    }));
    const w = world({
      projects: many,
      missions: many.map((p, i) =>
        ran({ id: `m${i}`, steps: [{ tool: "terminal.run", args: { cwd: p.dir } }] }),
      ),
    });
    const first = suggest(w);
    expect(first).toHaveLength(MAX_SUGGESTIONS);
    expect(suggest(w).map((s) => s.fingerprint)).toEqual(first.map((s) => s.fingerprint));
  });

  it("fingerprints by rule and entity, never by the wording", () => {
    const a = suggest(world({ projects: [portal], missions: [ran({ conclusion: "one reason" })] }));
    const b = suggest(
      world({ projects: [portal], missions: [ran({ conclusion: "quite another reason" })] }),
    );
    expect(a[0]?.because).not.toEqual(b[0]?.because);
    expect(a[0]?.fingerprint).toBe(b[0]?.fingerprint);
  });

  it("gives the same answer for the same world", () => {
    const input: Partial<WorldInput> = { projects: [portal], missions: [ran()] };
    expect(suggest(world(input))).toEqual(suggest(world(input)));
  });
});

describe("a suggestion is something the planner can actually plan", () => {
  // The point of wording objectives out of the planner's own vocabulary rather than
  // freely: an accepted suggestion that decomposed into nothing would be Jarvis
  // offering work it cannot do.
  const planner = new DeterministicPlanner();
  const registry = [
    // Aliases come from the registry's own generator rather than being hand-written:
    // `findProject` compares against the forms a disk scan actually produces, and a
    // fixture that invented its own would be testing the fixture.
    {
      key: portal.key,
      name: portal.name,
      dir: portal.dir,
      kind: "node" as const,
      aliases: aliasesForProject(portal.name),
      root: "C:\\dev",
    },
  ];
  const tools = ["find_project", "run_command", "git_status", "git_list_commits", "read_file"];

  it("plans every rule's objective into at least one step", async () => {
    const worlds = [
      world({ projects: [portal], missions: [ran()] }),
      world({ projects: [portal], tasks: [job()], missions: [ran({ state: "completed" })] }),
      world({ projects: [portal], window: editorOn("portfolio-site") }),
    ];
    const seen = new Set<string>();
    for (const w of worlds) {
      for (const s of suggest(w)) {
        seen.add(s.rule);
        const result = await planner.plan({ objective: s.objective, projects: registry, tools });
        expect(result.steps.length).toBeGreaterThan(0);
      }
    }
    expect([...seen].sort()).toEqual(["focused-untouched", "job-failing", "left-failing"]);
  });
});
