/**
 * The Activity view is where a user checks Jarvis's account of itself.
 *
 * So these tests are written from the position of someone who suspects the
 * assistant of overstating what it did. The interesting cases are all failures
 * of *honesty* rather than of layout: an unchecked action rendering as fine, a
 * refusal buried among routine reads, an empty list under a dead link implying a
 * quiet day.
 */
import { describe, it, expect } from "vitest";
import {
  toRow,
  toRows,
  outcomeLabel,
  isSerious,
  formatTime,
  appendEntry,
  mergeBacklog,
  emptyMessage,
  refusedCount,
  MAX_ROWS,
} from "../src/ui/activity-model.js";
import type { ActivityEntry } from "../src/ipc/contract.js";

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  at: 1_700_000_000_000,
  tool: "read_file",
  level: 0,
  category: "read",
  verdict: "allow",
  reason: "reads local data",
  ...over,
});

describe("silence never reads as success", () => {
  it("says an entry nobody checked was not checked", () => {
    // The common case by a wide margin: Jarvis approves a Hermes tool call and
    // Hermes runs it, so nothing on this side ever looked at the result. A blank
    // cell here would be read as "fine", which is a claim nobody made.
    expect(toRow(entry(), 0).outcome).toBe("not checked");
  });

  it("does not let 'no error' pass for 'done'", () => {
    // The distinction the whole of verified-action.ts exists to preserve. If it
    // dies anywhere it dies on screen, in a label like this one.
    expect(outcomeLabel("unconfirmed")).toMatch(/unconfirmed/);
    expect(outcomeLabel("unconfirmed")).not.toMatch(/^done/);
  });

  it("distinguishes all four outcomes from each other and from absence", () => {
    const labels = [
      outcomeLabel("verified"),
      outcomeLabel("unconfirmed"),
      outcomeLabel("failed"),
      outcomeLabel("unchecked"),
      outcomeLabel(undefined),
    ];
    expect(new Set(labels).size).toBe(5);
  });

  it("only the verified outcome is phrased as done", () => {
    expect(outcomeLabel("verified")).toMatch(/checked/);
    for (const o of ["unconfirmed", "failed", "unchecked"] as const) {
      expect(outcomeLabel(o), o).not.toMatch(/^done, checked$/);
    }
  });

  it("says the list may be stale rather than showing an empty day", () => {
    // An empty list under a dropped link is not evidence that nothing happened.
    expect(emptyMessage(false)).toMatch(/not connected/i);
    expect(emptyMessage(true)).not.toMatch(/not connected/i);
  });
});

describe("refusals are not buried", () => {
  it("marks a refusal notable even at a low level", () => {
    // "I was asked to do this and said no" is the single most important line in
    // the log — it is what an attempted attack looks like from the user's side.
    const row = toRow(entry({ verdict: "deny", level: 0 }), 0);
    expect(row.notable).toBe(true);
    expect(row.tone).toBe("refused");
    expect(row.verdict).toBe("Refused");
  });

  it("marks a serious level notable even when it was allowed", () => {
    const row = toRow(entry({ level: 4, verdict: "allow" }), 0);
    expect(row.notable).toBe(true);
    expect(row.tone).toBe("serious");
  });

  it("leaves an ordinary read quiet, so notable means something", () => {
    const row = toRow(entry(), 0);
    expect(row.notable).toBe(false);
    expect(row.tone).toBe("ordinary");
  });

  it("uses the same seriousness threshold as the consent dialog", () => {
    // If these drifted, an action could be presented as grave when asked about
    // and unremarkable in the record of what happened.
    expect(isSerious(2)).toBe(false);
    expect(isSerious(3)).toBe(true);
    expect(isSerious(4)).toBe(true);
  });

  it("treats a level it cannot make sense of as serious", () => {
    // Fails closed, like the classifier. A malformed level must not render as
    // routine.
    for (const bad of [Number.NaN, -1, 2.5, Infinity]) {
      expect(isSerious(bad), String(bad)).toBe(true);
    }
  });

  it("counts refusals for the summary", () => {
    const list = [entry(), entry({ verdict: "deny" }), entry({ verdict: "deny" })];
    expect(refusedCount(list)).toBe(2);
    expect(refusedCount([])).toBe(0);
  });
});

describe("ordering and bounds", () => {
  it("shows the newest first, because that is the question being asked", () => {
    const list = [entry({ tool: "first" }), entry({ tool: "second" })];
    expect(toRows(list).map((r) => r.tool)).toEqual(["second", "first"]);
  });

  it("keeps the most recent rows when the log is long", () => {
    const list = Array.from({ length: MAX_ROWS + 50 }, (_, i) => entry({ tool: `t${i}` }));
    const rows = toRows(list);
    expect(rows).toHaveLength(MAX_ROWS);
    // The newest entry, not the oldest, survives the cut.
    expect(rows[0]?.tool).toBe(`t${MAX_ROWS + 49}`);
  });

  it("bounds the list a long-lived window accumulates", () => {
    // The HUD can stay open for weeks. An append that only grows is a leak in
    // the process that lives longest.
    let list: ActivityEntry[] = [];
    for (let i = 0; i < MAX_ROWS + 25; i += 1) list = appendEntry(list, entry({ tool: `t${i}` }));
    expect(list).toHaveLength(MAX_ROWS);
    expect(list.at(-1)?.tool).toBe(`t${MAX_ROWS + 24}`);
  });

  it("gives entries from the same millisecond distinct keys", () => {
    // Several decisions can land in one tick. Duplicate keys make React drop
    // rows, which would silently shorten the record.
    const list = [entry(), entry(), entry()];
    const keys = toRows(list).map((r) => r.key);
    expect(new Set(keys).size).toBe(3);
  });
});

describe("reconnecting does not lose or double the record", () => {
  it("keeps a decision that arrived while the backlog was being fetched", () => {
    // The failure this exists to prevent: the runtime refuses something during a
    // reconnect, the fetch that was already in flight answers without it, and
    // replacing the list wholesale erases the one row worth reading.
    const local = [entry({ at: 500, tool: "live" })];
    const fetched = [entry({ at: 100, tool: "old" }), entry({ at: 200, tool: "older" })];
    expect(mergeBacklog(local, fetched).map((e) => e.tool)).toEqual(["old", "older", "live"]);
  });

  it("does not show the same decision twice", () => {
    // The other half: a live event the server has since included in its log.
    const shared = entry({ at: 300, tool: "both" });
    const merged = mergeBacklog([shared], [entry({ at: 100 }), shared]);
    expect(merged.filter((e) => e.tool === "both")).toHaveLength(1);
  });

  it("keeps what it has when the fetch comes back empty", () => {
    // An empty response is not evidence of an empty log — the request may have
    // gone to a runtime that just restarted. Discarding the local rows on that
    // basis would report a quiet day the same way a dead link does.
    const local = [entry({ tool: "kept" })];
    expect(mergeBacklog(local, []).map((e) => e.tool)).toEqual(["kept"]);
  });

  it("stays bounded across reconnects", () => {
    const fetched = Array.from({ length: MAX_ROWS }, (_, i) => entry({ at: i + 1 }));
    const local = Array.from({ length: 40 }, (_, i) => entry({ at: MAX_ROWS + i + 1 }));
    expect(mergeBacklog(local, fetched)).toHaveLength(MAX_ROWS);
  });
});

describe("the row itself", () => {
  it("carries the engine's reason through unchanged", () => {
    // The reason is why the decision went the way it did. Paraphrasing it in the
    // view would put a second, unreviewed account of events on screen.
    const row = toRow(entry({ reason: "previously allowed for this session" }), 0);
    expect(row.reason).toBe("previously allowed for this session");
  });

  it("strips characters that could forge the log's own layout", () => {
    // The tool name is a string a model produced (§52). Newlines and bidi marks
    // let a row draw what looks like a second row, so a refusal could be made to
    // read as an allow directly under it. Stripped here, where it is tested,
    // rather than trusting the runtime to have done it.
    const row = toRow(entry({ tool: "read_file‮gnp.exe", reason: "reads\nlocal data" }), 0);
    expect(row.tool).not.toMatch(/‮/);
    expect(row.reason).not.toMatch(/\n/);
  });

  it("does not let one long string push the rest of the row off screen", () => {
    const row = toRow(entry({ tool: "x".repeat(500) }), 0);
    expect(row.tool.length).toBeLessThanOrEqual(60);
  });

  it("shows a clock time, not a relative one", () => {
    // "3 hours ago" is not what a log is for; correlating with something else
    // that happened is.
    const time = formatTime(Date.UTC(2024, 0, 2, 15, 4, 5), "en-GB");
    expect(time).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("does not invent a time it does not have", () => {
    expect(formatTime(Number.NaN)).toBe("—");
  });
});
