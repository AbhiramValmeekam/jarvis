/**
 * What a window may say about a proposal read off the screen.
 *
 * The card is the one place in this build where a model's sentence about the user's
 * own desktop is drawn next to a button that starts an autonomous loop, so the tests
 * that matter are the ones that would let it overstate itself: a refusal rendered as
 * an offer, an objective shown without what it was based on, or a proposal drawn as
 * though the mission already existed.
 */
import { describe, it, expect } from "vitest";
import {
  applyVisionEvent,
  dismissVision,
  emptyVision,
  visionAnswered,
  visionCard,
  visionFailed,
  visionLooking,
} from "../src/ui/vision-model";
import type { ServerEvent, VisionProposalView } from "../src/ipc/contract";

const READY = { connected: true, busy: false };

function proposed(over: Partial<Extract<VisionProposalView, { kind: "proposed" }>> = {}): VisionProposalView {
  return {
    kind: "proposed",
    at: 1_000,
    source: "window",
    observed: "A terminal showing a failed npm build in portfolio-site.",
    objective: "make the portfolio-site build pass again",
    model: "gpt-4o-mini",
    ms: 1_400,
    bytes: 240_000,
    ...over,
  };
}

const REFUSED: VisionProposalView = {
  kind: "refused",
  at: 1_000,
  source: "window",
  refusal: "no-capture",
  speech: "You did not allow the screenshot, so I have not looked.",
};

describe("nothing to show", () => {
  it("has no card before anything was asked", () => {
    expect(visionCard(emptyVision, READY)).toBeNull();
  });

  it("has no card after the last one was dismissed", () => {
    const seen = visionAnswered(proposed());
    expect(visionCard(seen, READY)).not.toBeNull();
    expect(visionCard(dismissVision(), READY)).toBeNull();
  });
});

describe("a proposal", () => {
  it("shows what it saw beside what it proposes, and offers to start it", () => {
    const card = visionCard(visionAnswered(proposed()), READY);
    expect(card?.tone).toBe("proposal");
    expect(card?.observed).toContain("failed npm build");
    expect(card?.objective).toBe("make the portfolio-site build pass again");
    expect(card?.startable).toBe(true);
  });

  it("says nothing has started", () => {
    // The card sits above a pane that draws running missions. A user who read it as
    // a mission would be watching for steps that are never coming.
    const card = visionCard(visionAnswered(proposed()), READY);
    expect(card?.body).toContain("Nothing has started");
    expect(card?.title.toLowerCase()).not.toMatch(/\bstarted\b|\brunning\b|\bfixed\b/);
  });

  it("names the model, the time and the bytes it sent", () => {
    // §43: a plausible objective needs no model at all, so the card carries the
    // evidence that one answered. Absent these, nothing looked.
    const card = visionCard(visionAnswered(proposed()), READY);
    expect(card?.cost).toContain("gpt-4o-mini");
    expect(card?.cost).toContain("1400 ms");
    expect(card?.cost).toContain("234 KB");
  });

  it("says when it was a spoken request rather than this window's button", () => {
    const card = visionCard(visionAnswered(proposed({ source: "voice" })), READY);
    expect(card?.title).toContain("out loud");
  });

  it("will not offer to start one while a mission is running", () => {
    // The runtime refuses a second mission, and a button that produced that error
    // is a worse way to say so than a button that is not offered.
    const card = visionCard(visionAnswered(proposed()), { connected: true, busy: true });
    expect(card?.objective).toBe("make the portfolio-site build pass again");
    expect(card?.startable).toBe(false);
  });

  it("will not offer to start one with no runtime behind the window", () => {
    const card = visionCard(visionAnswered(proposed()), { connected: false, busy: false });
    expect(card?.startable).toBe(false);
  });
});

describe("an answer that is not a proposal", () => {
  it("draws a refusal as a refusal, with no way to start anything", () => {
    const card = visionCard(visionAnswered(REFUSED), READY);
    expect(card?.tone).toBe("refusal");
    expect(card?.body).toContain("did not allow the screenshot");
    expect(card?.objective).toBeUndefined();
    expect(card?.startable).toBe(false);
  });

  it("keeps a failed ask apart from a refusal", () => {
    // "I looked and there is nothing to do" is Jarvis answering. This is Jarvis not
    // having been reached, and merging the two reports silence as an answer.
    const card = visionCard(visionFailed("mission m1 is still running"), READY);
    expect(card?.tone).toBe("problem");
    expect(card?.body).toContain("still running");
    expect(card?.startable).toBe(false);
  });

  it("says what the wait is for while it looks", () => {
    const card = visionCard(visionLooking(), READY);
    expect(card?.tone).toBe("looking");
    expect(card?.body).toContain("allowed");
    expect(card?.startable).toBe(false);
  });
});
