/**
 * A mission, said out loud — and specifically, what the voice is not allowed to
 * leave out.
 *
 * The listener here is the hard case: they said a sentence, walked away, and the
 * only account they get is what Piper synthesises a minute later. There is no
 * screen to check it against. So the assertions are about the three ways that goes
 * wrong — a sentence that claims something the report does not say, two different
 * phrasings of one outcome, and a caveat dropped to make the report fit — and the
 * third gets the most tests, because a length budget is exactly the mechanism that
 * would quietly do it.
 */
import { describe, it, expect } from "vitest";
import { redactSecrets } from "../src/context/window-facts.js";
import type { MissionReport } from "../src/missions/mission-report.js";
import type { StepCounts } from "../src/missions/mission-model.js";
import {
  echoObjective,
  MAX_SPOKEN_ECHO,
  MAX_SPOKEN_REPORT,
  MISSION_NOT_STARTED,
  MISSION_STARTED,
  spokenProgress,
  spokenReport,
} from "../src/missions/mission-speech.js";

function counts(over: Partial<StepCounts> = {}): StepCounts {
  return {
    total: 3,
    done: 3,
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
  };
}

function report(over: Partial<MissionReport> = {}): MissionReport {
  return {
    missionId: "m1",
    objective: "get the portfolio site ready",
    state: "completed",
    headline: "Done in 42s — 3 of 3 steps verified",
    durationMs: 42_000,
    counts: counts(),
    planner: "deterministic",
    replans: 0,
    recovered: [],
    verified: [],
    outstanding: [],
    simulated: [],
    tools: [],
    memory: [],
    ...over,
  };
}

describe("the objective, said back", () => {
  it("names it when it is short enough to name", () => {
    expect(echoObjective("get the portfolio site ready")).toBe(
      "Objective: get the portfolio site ready",
    );
  });

  it("refers to it rather than reciting a dictated run-on sentence", () => {
    // Reciting sixty words before saying whether it worked buries the one fact the
    // listener is waiting for — and truncating mid-clause aloud sounds like the
    // process died.
    const long = "a".repeat(MAX_SPOKEN_ECHO + 1);
    expect(echoObjective(long)).toBe("The objective you gave me");
    expect(echoObjective("b".repeat(MAX_SPOKEN_ECHO))).toContain("Objective:");
  });

  it("has something to say about an objective that is empty", () => {
    expect(echoObjective("   ")).toBe("The objective you gave me");
  });
});

describe("a finished mission, spoken", () => {
  it("says the report's own headline, not a second phrasing of it", () => {
    // The window is showing this exact sentence. Two phrasings of one outcome is
    // how a listener and a reader come away with different accounts of the same
    // mission.
    const r = report();
    // Word for word, with one substitution: `speakable` turns the headline's em dash
    // into a comma, because espeak drops the dash without leaving a gap and "42s3 of 3"
    // is what a listener would hear.
    expect(spokenReport(r)).toBe(
      "Objective: get the portfolio site ready. Done in 42s, 3 of 3 steps verified.",
    );
  });

  it("claims nothing the report does not contain", () => {
    // Everything spoken traces to a field. The report says three of three verified
    // and nothing about what it means, so neither does the voice.
    const said = spokenReport(report({ objective: "tidy the downloads folder" }));
    expect(said).not.toMatch(/\bready\b|\bworking\b|\bfixed\b|\bsuccess\b/i);
  });

  it("says what went unverified, in the plural the count calls for", () => {
    const one = spokenReport(
      report({ counts: counts({ done: 2, unverified: 1 }), headline: "Finished — 1 step unverified" }),
    );
    expect(one).toContain("1 step ran without anything confirming it.");

    const two = spokenReport(
      report({ counts: counts({ done: 1, unverified: 2 }), headline: "Finished — 2 steps unverified" }),
    );
    expect(two).toContain("2 steps ran without anything confirming them.");
  });

  it("says when part of it was a demonstration", () => {
    const said = spokenReport(report({ counts: counts({ simulated: 1 }) }));
    expect(said).toContain("mocked capability");
    expect(said).toContain("demonstration rather than a result");
  });

  it("mentions a retry when there is room for it", () => {
    const said = spokenReport(report({ recovered: [{ id: "s2", title: "install deps", tool: "terminal", attempt: 2 }] }));
    expect(said).toContain("1 step only worked after a retry.");
  });

  it("ends on whose turn it is", () => {
    const said = spokenReport(report({ nextAction: "check the site in a browser" }));
    expect(said.endsWith("Next, check the site in a browser.")).toBe(true);
  });

  it("says nothing about a next action when the report had none to give", () => {
    // `nextActionFor` returns nothing rather than guessing at a fix, and this file
    // does not invent one to round the report off.
    expect(spokenReport(report())).not.toContain("Next,");
    expect(spokenReport(report({ nextAction: "   " }))).not.toContain("Next,");
  });
});

describe("the length budget, which may only ever drop good news", () => {
  it("keeps a spoken report listenable", () => {
    const said = spokenReport(
      report({
        objective: "get the portfolio site ready",
        nextAction: "n".repeat(400),
        recovered: [{ id: "s2", title: "t", tool: "terminal", attempt: 2 }],
      }),
    );
    expect(said.length).toBeLessThanOrEqual(MAX_SPOKEN_REPORT);
  });

  it("drops the optional sentence rather than the caveat", () => {
    // The failure this guards: a report that fitted inside its budget by omitting
    // "nothing confirmed this" is §43 with the volume turned up, because the
    // listener has no screen to check it against.
    const said = spokenReport(
      report({
        counts: counts({ done: 1, unverified: 2, simulated: 1 }),
        headline: "Finished — 1 of 3 steps verified",
        recovered: [{ id: "s2", title: "install deps", tool: "terminal", attempt: 2 }],
        nextAction: `${"x".repeat(300)} in a browser`,
      }),
    );
    expect(said).toContain("2 steps ran without anything confirming them");
    expect(said).toContain("mocked capability");
    expect(said).not.toContain("Next,");
  });

  it("says both caveats even when the two of them are the whole report", () => {
    const said = spokenReport(
      report({
        objective: "z".repeat(MAX_SPOKEN_ECHO + 1),
        headline: "h".repeat(320),
        counts: counts({ done: 0, unverified: 4, simulated: 3 }),
        recovered: [{ id: "s2", title: "t", tool: "terminal", attempt: 2 }],
        nextAction: "look at it yourself",
      }),
    );
    expect(said).toContain("4 steps ran without anything confirming them");
    expect(said).toContain("3 steps used a mocked capability");
    // Over budget, because required sentences are not negotiable — which is the
    // point. `speakable`'s own 1,000-character ceiling is the real backstop.
    expect(said.length).toBeGreaterThan(MAX_SPOKEN_REPORT);
    expect(said.length).toBeLessThanOrEqual(1_000);
  });
});

describe("what tool output does to a spoken sentence", () => {
  it("arrives already rewritten for a speech synthesiser", () => {
    // A report's details come from tool output, and a recorded error carries
    // backticks, asterisks and paths. espeak-ng reads those aloud as words.
    const said = spokenReport(
      report({
        headline: "Failed — `npm run build` exited 1 in E:\\jarvis\\portfolio-site",
        nextAction: "read **the log** at C:/tmp/build.log",
      }),
    );
    expect(said).not.toContain("`");
    expect(said).not.toContain("**");
    expect(said).not.toContain("—");
    // And the path is left exactly as recorded, deliberately: espeak reads a Windows
    // path acceptably, and rewriting it would be gaining words the report did not
    // contain — the one thing `speakable` is not allowed to do.
    expect(said).toContain("E:\\jarvis\\portfolio-site");
    expect(said).toContain("C:/tmp/build.log");
  });
});

describe("a mission still running", () => {
  it("says the state and the tally and stops", () => {
    // Not the report: a mission mid-flight has counts and no verdict, and
    // `buildReport`'s running headline is written for a pane that refreshes rather
    // than for a sentence somebody hears once.
    const said = spokenProgress(
      report({ state: "executing", counts: counts({ done: 1, pending: 2 }), durationMs: null }),
    );
    expect(said).toBe(
      "Objective: get the portfolio site ready. Still running: 1 of 3 steps are verified.",
    );
  });

  it("says when it is waiting on the user rather than on itself", () => {
    const said = spokenProgress(
      report({
        state: "waiting_approval",
        counts: counts({ done: 1, pending: 1, awaitingApproval: 1 }),
      }),
    );
    expect(said).toContain("1 step is waiting for you to allow it.");
  });

  it("does not claim a tally for a plan that has no steps yet", () => {
    const said = spokenProgress(report({ state: "planning", counts: counts({ total: 0, done: 0 }) }));
    expect(said).toContain("it has no steps yet");
  });
});

describe("the two fixed sentences", () => {
  it("acknowledges a start without describing an outcome", () => {
    // Said the moment an offer is accepted, so a mission never starts in silence —
    // and it promises only that something will be said later.
    expect(MISSION_STARTED).toBe("Starting on it. I will tell you when it is done.");
    expect(MISSION_STARTED).not.toMatch(/\bfinished\b|\bworked\b|\bis ready\b/i);
    expect(MISSION_STARTED).toContain("I will tell you");
  });

  it("says plainly when a mission did not start", () => {
    expect(MISSION_NOT_STARTED).toContain("could not start");
  });
});

describe("what a spoken report may not say out loud", () => {
  it("redacts before it rewrites for the synthesiser", () => {
    // The one place in this file where the order of two passes is itself the
    // defence. `nextActionFor` quotes a failed step's own recorded error, so a
    // build that printed a deploy key put it in the report — and `speakable`
    // strips underscores on the way to espeak, which would leave a redaction pass
    // running afterwards hunting for a `ghp_` prefix that no longer exists.
    const said = spokenReport(
      report({
        state: "failed",
        headline: "Not finished — 0 of 1 steps verified, 1 failed",
        counts: counts({ done: 0, failed: 1 }),
        nextAction:
          "look at run the build — exit code 1 · ghp_1234567890abcdefghijklmnopqrstuvwxyzAB",
      }),
    );
    expect(said).toContain("[redacted]");
    expect(redactSecrets(said).redacted, said).toBe(false);
    // And it is still a usable instruction: the listener is told which step to
    // look at, which is the whole reason the sentence is spoken at all.
    expect(said).toContain("look at run the build");
  });

  it("says a credential the wire would have redacted no differently", () => {
    // The voice is a second surface for the same material, and an easy one to
    // forget because nothing is drawn — the text goes to the Piper daemon over a
    // pipe and is synthesised to a file on disk.
    const said = spokenProgress(
      report({
        state: "executing",
        objective: "rotate AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        counts: counts({ done: 1, pending: 2 }),
      }),
    );
    expect(redactSecrets(said).redacted, said).toBe(false);
    expect(said).toContain("[redacted]");
  });
});
