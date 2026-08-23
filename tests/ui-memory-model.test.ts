/**
 * The Memory page's judgement, tested without a DOM.
 *
 * Five rules are what these tests are for, and each one is a way the page could
 * quietly overstate what Jarvis has:
 *
 *  - a lexical word hash is never described as semantic search (§43);
 *  - "off" is shown as a switch with a count behind it, not as emptiness;
 *  - a suggestion is described as offered and not kept;
 *  - a refusal is a notice, not a broken link;
 *  - an episode with something removed from it says so on the row.
 */
import { describe, it, expect } from "vitest";
import type { MemoryView, MemoryWriteResult } from "../src/ipc/contract";
import {
  CONFIRM_PHRASE,
  applyResult,
  confirmsForgetEverything,
  dismissNotice,
  embedderLook,
  emptyMessage,
  emptyScreen,
  enabledLook,
  episodeLine,
  episodeTone,
  failedToLoad,
  forgetEverythingSummary,
  loaded,
  proposalLine,
  storeLine,
  toEntryRows,
  toEpisodeRows,
  toProfileRows,
  toProposalRows,
} from "../src/ui/memory-model";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function view(over: Partial<MemoryView> = {}): MemoryView {
  return {
    entries: [],
    maxEntries: 200,
    chars: 0,
    maxChars: 20_000,
    enabled: true,
    enabledIsSession: false,
    profile: [],
    episodes: [],
    episodeCount: 0,
    proposals: [],
    embedder: null,
    hermes: { present: false, memoryEntries: 0, userEntries: 0, bytes: 0 },
    ...over,
  };
}

describe("the screen's states", () => {
  it("starts out reading, and says so rather than showing an empty store", () => {
    expect(emptyScreen.status).toBe("loading");
    expect(emptyMessage(emptyScreen, true)).toBe("Reading…");
  });

  it("distinguishes an unattached UI from a failed read", () => {
    expect(emptyMessage(emptyScreen, false)).toMatch(/Not connected/);
    const failed = failedToLoad(emptyScreen, "EPIPE");
    expect(emptyMessage(failed, true)).toBe("EPIPE");
  });

  it("keeps the last view when the link breaks", () => {
    // A broken pipe says nothing about what was in the store a second ago, and
    // blanking the page would replace a true list with no list.
    const ready = loaded(emptyScreen, view({ entries: [{ id: "m1", text: "a note", at: NOW }] }));
    const broken = failedToLoad(ready, "the pipe closed");
    expect(broken.status).toBe("failed");
    expect(broken.view?.entries).toHaveLength(1);
    expect(emptyMessage(broken, true)).toBeNull();
  });

  it("clears a stale error once a read succeeds", () => {
    const broken = failedToLoad(emptyScreen, "EPIPE");
    const ready = loaded(broken, view());
    expect(ready.status).toBe("ready");
    expect(ready.error).toBeNull();
  });
});

describe("what a write says back", () => {
  const result = (over: Partial<MemoryWriteResult> = {}): MemoryWriteResult => ({
    saved: true,
    speech: "Saved.",
    memory: view(),
    ...over,
  });

  it("replaces the whole view rather than patching the list", () => {
    const before = loaded(emptyScreen, view({ entries: [{ id: "m1", text: "old", at: NOW }] }));
    const after = applyResult(
      before,
      result({ memory: view({ entries: [{ id: "m2", text: "new", at: NOW }] }) }),
    );
    // A page that edited its own list would disagree with the store the first time
    // a write was partly refused.
    expect(after.view?.entries.map((e) => e.id)).toEqual(["m2"]);
    expect(after.status).toBe("ready");
  });

  it("shows a refusal as a notice in the runtime's own words, not as an error", () => {
    const after = applyResult(
      loaded(emptyScreen, view()),
      result({ saved: false, speech: "that looks like it contains a password, key or token" }),
    );
    expect(after.notice?.tone).toBe("refused");
    expect(after.notice?.text).toMatch(/password, key or token/);
    // `screenMemory` declining is the subsystem working, so the link is left alone.
    expect(after.error).toBeNull();
    expect(after.status).toBe("ready");
  });

  it("reports a request main declined to send rather than doing nothing", () => {
    const after = applyResult(loaded(emptyScreen, view()), null);
    expect(after.notice?.tone).toBe("refused");
    // A button that silently does nothing is the worst of the three outcomes.
    expect(after.notice?.text).toMatch(/not accepted/);
  });

  it("flattens a speech line that arrived with newlines in it", () => {
    const after = applyResult(loaded(emptyScreen, view()), result({ speech: "Saved.\nAnd\nagain." }));
    expect(after.notice?.text).not.toContain("\n");
  });

  it("dismisses a notice, and dismissing nothing changes nothing", () => {
    const withNotice = applyResult(loaded(emptyScreen, view()), result());
    expect(dismissNotice(withNotice).notice).toBeNull();
    const clean = loaded(emptyScreen, view());
    expect(dismissNotice(clean)).toBe(clean);
  });
});

describe("the memory list", () => {
  it("is newest first, with an edit noted separately from when it was said", () => {
    const rows = toEntryRows(
      view({
        entries: [
          { id: "m1", text: "older", at: NOW - 3 * DAY },
          { id: "m2", text: "newer", at: NOW - MINUTE, editedAt: NOW - 30_000 },
        ],
      }),
      NOW,
      "en-GB",
    );
    expect(rows.map((r) => r.id)).toEqual(["m2", "m1"]);
    expect(rows[0]!.edited).toMatch(/^edited /);
    // `at` stays the moment it was first said, so a fixed typo does not jump a
    // three-month-old note to the top.
    expect(rows[1]!.edited).toBeUndefined();
  });

  it("flattens a memory that arrived with newlines in it", () => {
    const rows = toEntryRows(view({ entries: [{ id: "m1", text: "a\nb\nc", at: NOW }] }), NOW);
    expect(rows[0]!.text).not.toContain("\n");
  });

  it("states both caps, because characters bind before rows do", () => {
    const line = storeLine(view({ entries: [], maxEntries: 200, chars: 1234, maxChars: 20_000 }));
    expect(line).toMatch(/0 of 200 memories/);
    expect(line).toMatch(/of 20,000 characters/);
  });
});

describe("the off switch", () => {
  it("says how much is behind it, and that nothing was deleted", () => {
    const look = enabledLook(
      view({
        enabled: false,
        entries: [{ id: "m1", text: "a note", at: NOW }],
        profile: [{ key: "name", label: "What to call you", hint: "…", max: 60, value: "Tony" }],
        episodeCount: 4,
      }),
    );
    expect(look.on).toBe(false);
    expect(look.label).toMatch(/off/i);
    // "Off" and "empty" are different answers to "what do you know about me".
    expect(look.detail).toMatch(/6 things/);
    expect(look.detail).toMatch(/Nothing has been deleted/);
  });

  it("counts an empty profile field as nothing held", () => {
    const look = enabledLook(
      view({
        enabled: false,
        profile: [{ key: "name", label: "What to call you", hint: "…", max: 60 }],
      }),
    );
    expect(look.detail).toMatch(/0 things are still here/);
  });

  it("says 'thing is' rather than 'things are' when there is one", () => {
    const look = enabledLook(
      view({ enabled: false, entries: [{ id: "m1", text: "a note", at: NOW }] }),
    );
    expect(look.detail).toMatch(/1 thing is still here/);
  });

  it("says what being on means: fenced as data, cited rather than obeyed", () => {
    const look = enabledLook(view({ enabled: true }));
    expect(look.on).toBe(true);
    expect(look.detail).toMatch(/fenced as data/);
    expect(look.detail).toMatch(/rather than obeyed/);
  });

  it("warns when the switch is a session override that a restart undoes", () => {
    expect(enabledLook(view({ enabled: false, enabledIsSession: true })).detail).toMatch(
      /this session only/,
    );
    expect(enabledLook(view({ enabled: true, enabledIsSession: false })).detail).not.toMatch(
      /this session only/,
    );
  });
});

describe("the profile", () => {
  it("shows all eight slots, including the empty ones", () => {
    const rows = toProfileRows(
      view({
        profile: [
          { key: "name", label: "What to call you", hint: "the name", max: 60, value: "Tony", source: "stated", at: NOW - MINUTE },
          { key: "shell", label: "Shell", hint: "the shell", max: 40 },
        ],
      }),
      NOW,
    );
    expect(rows).toHaveLength(2);
    // The empty ones are half the answer to "what do you keep about me": without
    // them the user cannot see that the vocabulary is eight slots and not a dossier.
    expect(rows[1]!.filled).toBe(false);
    expect(rows[1]!.value).toBe("");
    expect(rows[1]!.provenance).toBeUndefined();
  });

  it("says how a filled field got there, in the two words that exist", () => {
    const rows = toProfileRows(
      view({
        profile: [
          { key: "name", label: "Name", hint: "…", max: 60, value: "Tony", source: "stated", at: NOW - MINUTE },
          { key: "shell", label: "Shell", hint: "…", max: 40, value: "bash", source: "confirmed", at: NOW - MINUTE },
        ],
      }),
      NOW,
    );
    expect(rows[0]!.provenance).toMatch(/^you told me — /);
    expect(rows[1]!.provenance).toMatch(/^you confirmed a suggestion — /);
  });

  it("treats an empty string as not filled in", () => {
    const rows = toProfileRows(
      view({ profile: [{ key: "focus", label: "Focus", hint: "…", max: 160, value: "" }] }),
      NOW,
    );
    expect(rows[0]!.filled).toBe(false);
  });
});

describe("episodes", () => {
  it("calls only `completed` good, and an unknown outcome neither", () => {
    expect(episodeTone("completed")).toBe("good");
    expect(episodeTone("failed")).toBe("bad");
    expect(episodeTone("blocked")).toBe("waiting");
    expect(episodeTone("cancelled")).toBe("muted");
    // An unknown word is not evidence of success, and guessing it was a failure
    // would put a red row under something that went fine.
    expect(episodeTone("something_new")).toBe("muted");
  });

  it("says on the row when something was removed on the way in", () => {
    const rows = toEpisodeRows(
      view({
        episodes: [
          {
            id: "e1",
            at: NOW - MINUTE,
            kind: "mission",
            title: "deploy",
            outcome: "completed",
            detail: "used a token",
            redacted: true,
          },
        ],
      }),
      NOW,
    );
    // A record with something removed from it is a different record, and the user
    // is the only one who can judge whether the hole matters.
    expect(rows[0]!.redacted).toMatch(/looked like a secret was removed/);
  });

  it("leaves the redaction line off a complete record", () => {
    const rows = toEpisodeRows(
      view({
        episodes: [{ id: "e1", at: NOW, kind: "mission", title: "deploy", outcome: "completed" }],
      }),
      NOW,
    );
    expect(rows[0]!.redacted).toBeUndefined();
  });

  it("joins the tools for display and formats the duration", () => {
    const rows = toEpisodeRows(
      view({
        episodes: [
          {
            id: "e1",
            at: NOW,
            kind: "mission",
            title: "deploy",
            outcome: "completed",
            tools: ["terminal.run", "git.status"],
            durationMs: 4200,
          },
          { id: "e2", at: NOW, kind: "mission", title: "quick", outcome: "completed", durationMs: 12 },
          { id: "e3", at: NOW, kind: "mission", title: "long", outcome: "completed", durationMs: 125_000 },
          { id: "e4", at: NOW, kind: "mission", title: "odd", outcome: "completed", durationMs: -1 },
        ],
      }),
      NOW,
    );
    expect(rows[0]!.tools).toBe("terminal.run, git.status");
    expect(rows[0]!.duration).toBe("4.2 s");
    expect(rows[1]!.duration).toBe("12 ms");
    expect(rows[2]!.duration).toBe("2 min 5 s");
    expect(rows[3]!.duration).toBe("—");
  });

  it("omits tools rather than showing an empty list", () => {
    const rows = toEpisodeRows(
      view({
        episodes: [
          { id: "e1", at: NOW, kind: "mission", title: "deploy", outcome: "completed", tools: [] },
        ],
      }),
      NOW,
    );
    expect(rows[0]!.tools).toBeUndefined();
  });

  it("says how much history there is against how much of it travelled", () => {
    expect(episodeLine(view({ episodeCount: 0 }))).toMatch(/Nothing recorded yet/);
    expect(episodeLine(view({ episodeCount: 2, episodes: [] as never }))).toMatch(/2 recorded/);
    const truncated = view({
      episodeCount: 90,
      episodes: Array.from({ length: 40 }, (_, n) => ({
        id: `e${n}`,
        at: NOW,
        kind: "mission",
        title: "a mission",
        outcome: "completed",
      })),
    });
    expect(episodeLine(truncated)).toBe("Showing the newest 40 of 90 recorded.");
  });
});

describe("suggestions", () => {
  it("says none of them has been saved", () => {
    const line = proposalLine(
      view({
        proposals: [
          { id: "p1", at: NOW, kind: "memory", text: "a fact", why: "mission m3" },
          { id: "p2", at: NOW, kind: "memory", text: "another", why: "mission m3" },
        ],
      }),
    );
    expect(line).toMatch(/2 things Jarvis is offering to remember/);
    expect(line).toMatch(/None of them has been saved/);
  });

  it("says plainly when nothing is being offered", () => {
    expect(proposalLine(view())).toMatch(/not offering to remember anything/);
  });

  it("names exactly what accepting one would do", () => {
    const rows = toProposalRows(
      view({
        proposals: [
          { id: "p1", at: NOW - MINUTE, kind: "profile", key: "shell", text: "bash", why: "mission m3" },
          { id: "p2", at: NOW - MINUTE, kind: "memory", text: "a durable fact", why: "mission m3" },
        ],
      }),
      NOW,
    );
    expect(rows[0]!.target).toBe("would fill in your shell");
    expect(rows[1]!.target).toBe("would be saved as a memory");
    // Provenance the runtime supplied, printed as given — never a model's account
    // of its own reasoning.
    expect(rows[0]!.why).toBe("mission m3");
  });

  it("falls back to the memory wording when a profile proposal names no field", () => {
    const rows = toProposalRows(
      view({ proposals: [{ id: "p1", at: NOW, kind: "profile", text: "bash", why: "m3" }] }),
      NOW,
    );
    expect(rows[0]!.target).toBe("would be saved as a memory");
  });
});

describe("similarity", () => {
  it("calls a word hash lexical, and says no embedding model is configured", () => {
    const look = embedderLook(
      view({
        embedder: {
          name: "lexical-hash-256",
          dims: 256,
          semantic: false,
          rows: 12,
          reason: "no embeddings endpoint configured",
        },
      }),
    );
    expect(look?.semantic).toBe(false);
    expect(look?.label).toBe("Lexical similarity");
    // Calling this semantic search would claim a capability the process does not
    // have. The words "matches wording, not meaning" are the whole point.
    expect(look?.detail).toMatch(/matches wording, not meaning/);
    expect(look?.detail).toMatch(/12 rows/);
    expect(look?.reason).toBe("no embeddings endpoint configured");
  });

  it("only says semantic when a real embedding model is behind it", () => {
    const look = embedderLook(
      view({
        embedder: {
          name: "text-embedding-3-small",
          dims: 1536,
          semantic: true,
          rows: 1,
          reason: "using the configured embeddings endpoint",
        },
      }),
    );
    expect(look?.label).toBe("Semantic search");
    expect(look?.detail).toMatch(/1 row indexed/);
    expect(look?.detail).toMatch(/match meaning rather than words/);
  });

  it("is null when no index was built at all", () => {
    expect(embedderLook(view({ embedder: null }))).toBeNull();
  });
});

describe("forgetting everything", () => {
  it("accepts the phrase after trimming and case-folding, and nothing looser", () => {
    expect(confirmsForgetEverything(`  ${CONFIRM_PHRASE.toUpperCase()}  `)).toBe(true);
    // A phrase is a deliberate act. Matching a word of it would defeat the reason
    // this is not a boolean.
    expect(confirmsForgetEverything("forget")).toBe(false);
    expect(confirmsForgetEverything("everything")).toBe(false);
    expect(confirmsForgetEverything("please forget everything")).toBe(false);
    expect(confirmsForgetEverything("")).toBe(false);
  });

  it("counts what would go, in each layer, before it happens", () => {
    const summary = forgetEverythingSummary(
      view({
        entries: [{ id: "m1", text: "a note", at: NOW }],
        episodeCount: 7,
        profile: [
          { key: "name", label: "Name", hint: "…", max: 60, value: "Tony" },
          { key: "shell", label: "Shell", hint: "…", max: 40 },
        ],
        proposals: [{ id: "p1", at: NOW, kind: "memory", text: "a fact", why: "m3" }],
      }),
    );
    expect(summary).toMatch(/1 memory/);
    expect(summary).toMatch(/7 episodes/);
    expect(summary).toMatch(/1 profile field/);
    expect(summary).toMatch(/1 pending suggestion/);
    expect(summary).toMatch(/cannot be undone/);
  });

  it("pluralises an empty store correctly", () => {
    const summary = forgetEverythingSummary(view());
    expect(summary).toMatch(/0 memories, 0 episodes, 0 profile fields, 0 pending suggestions/);
  });
});
