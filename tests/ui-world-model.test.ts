/**
 * Presentation rules for what Jarvis can see, and for what it is offering to do.
 *
 * The three tests that carry weight here are the ones that would let the page lie:
 * an edge drawn without the reason Jarvis claims it, a project inferred from a web
 * page's title shown the same way as one the user is actually working in, and a
 * suggestion whose evidence was trimmed to fit the card. Everything else is bookkeeping.
 */
import { describe, it, expect } from "vitest";
import {
  applyWorldEvent,
  dismissWorldError,
  edgeRows,
  emptyWorld,
  entityGroups,
  focusLine,
  KIND_ORDER,
  offered,
  suggestionCards,
  suggestionsNote,
  worldAnswered,
  worldFailed,
  worldSummary,
  type WorldScreen,
} from "../src/ui/world-model";
import type {
  ProactiveProposalView,
  ServerEvent,
  WorldEdgeView,
  WorldEntityView,
  WorldView,
} from "../src/ipc/contract";

const T0 = 1_700_000_000_000;

function entity(over: Partial<WorldEntityView> = {}): WorldEntityView {
  return {
    id: "project:portfolio-site",
    kind: "project",
    key: "portfolio-site",
    label: "portfolio-site",
    at: null,
    source: "project registry",
    ...over,
  };
}

function edge(over: Partial<WorldEdgeView> = {}): WorldEdgeView {
  return {
    kind: "worked_on",
    from: "mission:m1",
    to: "project:portfolio-site",
    at: T0,
    basis: "ran in C:\\dev\\portfolio-site",
    ...over,
  };
}

function proposal(over: Partial<ProactiveProposalView> = {}): ProactiveProposalView {
  return {
    id: "w1",
    at: T0,
    rule: "left-failing",
    objective: "check whether portfolio-site still builds and its tests pass",
    because: ["mission m1 ended failing 1 hour ago", "it reported: npm run build exited 1"],
    entityId: "project:portfolio-site",
    ...over,
  };
}

function view(over: Partial<WorldView> = {}): WorldView {
  return {
    at: T0,
    entities: [entity()],
    edges: [],
    focus: null,
    truncated: false,
    proposals: [],
    proactive: { enabled: true, reason: "suggestions are on" },
    summary: "1 project(s), 0 app(s), 0 task(s), 0 mission(s), 0 connection(s)",
    ...over,
  };
}

function answered(over: Partial<WorldView> = {}): WorldScreen {
  return worldAnswered(emptyWorld, view(over));
}

describe("folding events in", () => {
  it("adds a pushed suggestion without asking for the graph again", () => {
    // A suggestion arrives as a mission finishes. Re-assembling the graph on the push
    // would mean every mission ended with the page doing work nobody asked for.
    const e: ServerEvent = { type: "proactive", proposal: proposal() };
    const screen = applyWorldEvent(emptyWorld, e);
    expect(screen.pushed.map((p) => p.id)).toEqual(["w1"]);
    expect(screen.view).toBeNull();
    expect(screen.asked).toBe(false);
  });

  it("puts the newest push first", () => {
    let screen = applyWorldEvent(emptyWorld, { type: "proactive", proposal: proposal() });
    screen = applyWorldEvent(screen, {
      type: "proactive",
      proposal: proposal({ id: "w2", entityId: "project:ledger" }),
    });
    expect(screen.pushed.map((p) => p.id)).toEqual(["w2", "w1"]);
  });

  it("does not add a push it already has", () => {
    const e: ServerEvent = { type: "proactive", proposal: proposal() };
    const once = applyWorldEvent(emptyWorld, e);
    expect(applyWorldEvent(once, e)).toBe(once);
  });

  it("does not re-add a push that is already in the stored queue", () => {
    const screen = answered({ proposals: [proposal()] });
    const same = applyWorldEvent(screen, { type: "proactive", proposal: proposal() });
    expect(same.pushed).toEqual([]);
    expect(offered(same).map((p) => p.id)).toEqual(["w1"]);
  });

  it("ignores every other event", () => {
    const screen = answered();
    expect(applyWorldEvent(screen, { type: "log", line: "anything" })).toBe(screen);
  });

  it("clears the pushes when a full view arrives, because the view carries the queue", () => {
    const pushed = applyWorldEvent(emptyWorld, { type: "proactive", proposal: proposal() });
    const next = worldAnswered(pushed, view({ proposals: [proposal()] }));
    expect(next.pushed).toEqual([]);
    expect(next.error).toBeNull();
    expect(next.asked).toBe(true);
    // Exactly once, from the one source that is now authoritative.
    expect(offered(next).map((p) => p.id)).toEqual(["w1"]);
  });

  it("keeps a refusal verbatim, and lets it be dismissed", () => {
    const failed = worldFailed(answered(), "mission m4 is still running");
    expect(failed.error).toBe("mission m4 is still running");
    // The graph it already had is still on screen: a failed resolve did not unsee it.
    expect(failed.view).not.toBeNull();
    expect(dismissWorldError(failed).error).toBeNull();
  });

  it("flattens a refusal onto one line", () => {
    const failed = worldFailed(emptyWorld, "no\nsecond line");
    expect(failed.error).not.toContain("\n");
    expect(failed.asked).toBe(true);
  });
});

describe("what is on offer", () => {
  it("shows pushes ahead of the stored queue and never twice", () => {
    const screen = applyWorldEvent(answered({ proposals: [proposal({ id: "old" })] }), {
      type: "proactive",
      proposal: proposal({ id: "new" }),
    });
    expect(offered(screen).map((p) => p.id)).toEqual(["new", "old"]);
  });

  it("keeps every line of evidence on the card", () => {
    // A proposal whose evidence is trimmed to fit is one the user accepts on trust.
    const [card] = suggestionCards([proposal()]);
    expect(card?.because).toHaveLength(2);
    expect(card?.because[1]).toContain("npm run build exited 1");
    expect(card?.objective).toBe("check whether portfolio-site still builds and its tests pass");
    expect(card?.entityId).toBe("project:portfolio-site");
  });

  it("says which rule produced it in words a person can hold Jarvis to", () => {
    expect(suggestionCards([proposal()])[0]?.rule).toBe("a mission here ended failing");
    expect(suggestionCards([proposal({ rule: "job-failing" })])[0]?.rule).toBe(
      "a scheduled job is reporting an error",
    );
    expect(suggestionCards([proposal({ rule: "focused-untouched" })])[0]?.rule).toBe(
      "you appear to be in a project nothing has run against",
    );
  });

  it("falls back to the rule's own name rather than inventing a description", () => {
    expect(suggestionCards([proposal({ rule: "something-new" })])[0]?.rule).toBe("something-new");
  });
});

describe("the note under the heading", () => {
  it("distinguishes not asked from nothing to say", () => {
    expect(suggestionsNote(emptyWorld)).toBe("Not asked yet.");
    expect(suggestionsNote(answered())).toContain("Nothing to suggest");
    // The arrangement, stated: the count is visible, this is the part taken on faith.
    expect(suggestionsNote(answered())).toContain("never on a timer");
  });

  it("says nothing has run, and will not until it is accepted", () => {
    expect(suggestionsNote(answered({ proposals: [proposal()] }))).toBe(
      "One suggestion. It has not run, and it will not until you accept it.",
    );
    const two = answered({ proposals: [proposal(), proposal({ id: "w2" })] });
    expect(suggestionsNote(two)).toContain("2 suggestions");
    expect(suggestionsNote(two)).toContain("None of them has run");
  });

  it("says switched off in the runtime's own words rather than looking quiet", () => {
    // An empty list either way would make a disabled feature indistinguishable from
    // a working one with nothing to say.
    const off = answered({
      proactive: { enabled: false, reason: "suggestions are off in settings" },
    });
    expect(suggestionsNote(off)).toBe("suggestions are off in settings");
  });

  it("still says off even while something is queued from before", () => {
    const off = answered({
      proposals: [proposal()],
      proactive: { enabled: false, reason: "suggestions are off in settings" },
    });
    expect(suggestionsNote(off)).toBe("suggestions are off in settings");
  });
});

describe("the graph as rows", () => {
  it("groups by kind in a fixed order and keeps the runtime's own order inside", () => {
    const v = view({
      entities: [
        entity({ id: "mission:m1", kind: "mission", key: "m1", label: "check the build" }),
        entity({ id: "project:b", key: "b", label: "b" }),
        entity({ id: "project:a", key: "a", label: "a" }),
        entity({ id: "task:j1", kind: "task", key: "j1", label: "nightly build" }),
      ],
    });
    const groups = entityGroups(v);
    expect(groups.map((g) => g.kind)).toEqual(["project", "task", "mission"]);
    expect(groups[0]?.heading).toBe("Projects");
    // Not sorted by recency: that would move a project every time the page opened.
    expect(groups[0]?.rows.map((r) => r.label)).toEqual(["b", "a"]);
  });

  it("keeps the source's own word for a status and never re-words it", () => {
    const v = view({
      entities: [entity({ id: "task:j1", kind: "task", key: "j1", label: "nightly", status: "error", detail: "last ran 2 hours ago", source: "scheduled jobs" })],
    });
    const [row] = entityGroups(v)[0]?.rows ?? [];
    expect(row?.status).toBe("error");
    expect(row?.detail).toBe("last ran 2 hours ago");
    expect(row?.source).toBe("scheduled jobs");
  });

  it("reports a missing detail as null rather than an empty string", () => {
    const [row] = entityGroups(view())[0]?.rows ?? [];
    expect(row?.detail).toBeNull();
    expect(row?.status).toBeNull();
  });

  it("marks the focused project, and marks it steerable only when the reason was", () => {
    const focus = { windowId: "window:current", projectId: "project:portfolio-site", steerable: true };
    const v = view({ entities: [entity(), entity({ id: "project:ledger", key: "ledger", label: "ledger" })], focus });
    const rows = entityGroups(v)[0]?.rows ?? [];
    expect(rows[0]?.focused).toBe(true);
    expect(rows[0]?.steerable).toBe(true);
    // The mark belongs to the focused row, not to every project on the page.
    expect(rows[1]?.focused).toBe(false);
    expect(rows[1]?.steerable).toBe(false);

    const local = entityGroups(view({ entities: [entity()], focus: { ...focus, steerable: false } }));
    expect(local[0]?.rows[0]?.focused).toBe(true);
    expect(local[0]?.rows[0]?.steerable).toBe(false);
  });

  it("has nothing to group before an answer arrives", () => {
    expect(entityGroups(null)).toEqual([]);
    expect(edgeRows(null)).toEqual([]);
  });

  it("groups every kind the runtime can emit", () => {
    // A kind with no heading here would render its identifier at a user, so the two
    // lists are checked against each other rather than trusted to stay in step.
    const v = view({
      entities: KIND_ORDER.map((kind) => entity({ id: `${kind}:x`, kind, key: "x", label: kind })),
    });
    const groups = entityGroups(v);
    expect(groups).toHaveLength(KIND_ORDER.length);
    for (const g of groups) expect(g.heading).not.toBe(g.kind);
  });
});

describe("the edges", () => {
  it("reads as a sentence, with the reason attached to the row", () => {
    const v = view({
      entities: [entity(), entity({ id: "mission:m1", kind: "mission", key: "m1", label: "check the build" })],
      edges: [edge()],
    });
    const [row] = edgeRows(v);
    expect(row?.from).toBe("check the build");
    expect(row?.verb).toBe("worked on");
    expect(row?.to).toBe("portfolio-site");
    expect(row?.basis).toBe("ran in C:\\dev\\portfolio-site");
    expect(row?.steerable).toBe(false);
  });

  it("gives every edge kind a verb rather than showing the identifier", () => {
    const kinds = ["worked_on", "focused", "window_of", "scheduled_in"];
    const v = view({
      entities: [entity({ id: "a", key: "a", label: "A" }), entity({ id: "b", key: "b", label: "B" })],
      edges: kinds.map((kind) => edge({ kind, from: "a", to: "b" })),
    });
    const rows = edgeRows(v);
    expect(rows).toHaveLength(kinds.length);
    for (const [i, row] of rows.entries()) expect(row.verb).not.toBe(kinds[i]);
  });

  it("carries the steerable mark through from the wire", () => {
    const v = view({
      entities: [entity(), entity({ id: "task:j1", kind: "task", key: "j1", label: "nightly" })],
      edges: [edge({ kind: "scheduled_in", from: "task:j1", steerable: true })],
    });
    expect(edgeRows(v)[0]?.steerable).toBe(true);
  });

  it("drops an edge whose ends are not both on the page", () => {
    // `mission:m3 worked on project:xyz` tells a user nothing and looks like a bug.
    const v = view({ entities: [entity()], edges: [edge(), edge({ to: "project:gone" })] });
    expect(edgeRows(v)).toEqual([]);
  });

  it("gives two edges between the same pair distinct keys", () => {
    const v = view({
      entities: [entity(), entity({ id: "mission:m1", kind: "mission", key: "m1", label: "m" })],
      edges: [edge(), edge({ basis: 'the objective said "portfolio-site"' })],
    });
    const keys = edgeRows(v).map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("the focus line", () => {
  it("says what it is looking at and what the user is working in", () => {
    const v = view({
      entities: [entity(), entity({ id: "window:current", kind: "window", key: "current", label: "index.ts — portfolio-site" })],
      focus: { windowId: "window:current", projectId: "project:portfolio-site", steerable: false },
    });
    expect(focusLine(v)).toBe("index.ts — portfolio-site, working in portfolio-site.");
  });

  it("spells out that a title decides nothing, rather than marking it", () => {
    // This is the line a user reads before accepting a suggestion about the project
    // it names, so the qualification is a sentence and not an icon (§52).
    const v = view({
      entities: [entity(), entity({ id: "window:current", kind: "window", key: "current", label: "portfolio-site build errors — Stack Overflow" })],
      focus: { windowId: "window:current", projectId: "project:portfolio-site", steerable: true },
    });
    const line = focusLine(v);
    expect(line).toContain("Its title mentions portfolio-site");
    expect(line).toContain("will not act on that alone");
    expect(line).not.toContain("working in");
  });

  it("says it cannot tie the window to a project rather than guessing one", () => {
    const v = view({
      entities: [entity({ id: "window:current", kind: "window", key: "current", label: "Untitled - Notepad" })],
      focus: { windowId: "window:current", steerable: false },
    });
    expect(focusLine(v)).toBe("Untitled - Notepad, which Jarvis cannot tie to a known project.");
  });

  it("says the window could not be read, which is not the same as no project", () => {
    expect(focusLine(view({ focus: null }))).toBe(
      "Jarvis could not read the foreground window.",
    );
    expect(focusLine(null)).toBe("Not asked yet.");
  });

  it("does not invent a name for a window it has no entity for", () => {
    const v = view({ focus: { windowId: "window:missing", steerable: false } });
    expect(focusLine(v)).toContain("an unnamed window");
  });
});

describe("the summary line", () => {
  it("counts, and says when a cap was hit rather than implying it showed everything", () => {
    expect(worldSummary(view(), true)).toBe(
      "1 project(s), 0 app(s), 0 task(s), 0 mission(s), 0 connection(s)",
    );
    expect(worldSummary(view({ truncated: true }), true)).toContain("— and more than fitted.");
  });

  it("distinguishes nothing yet from could not ask", () => {
    expect(worldSummary(null, true)).toBe("Nothing yet.");
    expect(worldSummary(null, false)).toContain("runtime is not connected");
  });
});
