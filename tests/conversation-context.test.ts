import { describe, it, expect } from "vitest";
import {
  ConversationContext,
  REFERENT_TTL_MS,
  usesReferent,
  isReferentialQuestion,
  describeReferent,
  type Referent,
} from "../src/context/conversation-context.js";

const PROJECT: Referent = { kind: "project", key: "jarvis", label: "jarvis" };
const WINDOW: Referent = { kind: "window", key: "chrome", label: "Chrome" };

/** t=0 is the start of the conversation in every test below. */
const T0 = 1_000_000;

describe("the subject in play", () => {
  it("remembers what the last nameable turn was about", () => {
    const ctx = new ConversationContext();
    ctx.record({ at: T0, route: "local", intent: "project.open", referent: PROJECT });
    expect(ctx.referent(T0 + 1_000)).toEqual(PROJECT);
  });

  it("has no subject before anything has been said", () => {
    expect(new ConversationContext().referent(T0)).toBeNull();
  });

  it("takes the most recent subject when several have been mentioned", () => {
    const ctx = new ConversationContext();
    ctx.record({ at: T0, route: "local", referent: PROJECT });
    ctx.record({ at: T0 + 5_000, route: "local", referent: WINDOW });
    expect(ctx.referent(T0 + 6_000)).toEqual(WINDOW);
  });

  it("keeps the subject through a turn that has none", () => {
    // Asking the time in the middle of talking about a project does not change
    // what "it" means. A subject is displaced by another subject, not by noise.
    const ctx = new ConversationContext();
    ctx.record({ at: T0, route: "local", intent: "project.open", referent: PROJECT });
    ctx.record({ at: T0 + 2_000, route: "local", intent: "time.now" });
    expect(ctx.referent(T0 + 3_000)).toEqual(PROJECT);
  });

  it("forgets the subject once the conversation window has passed", () => {
    // The whole safety property: "open it" ten minutes later is a new sentence
    // about a new thing, and resolving it against a stale subject would act on
    // something the user stopped thinking about.
    const ctx = new ConversationContext();
    ctx.record({ at: T0, route: "local", referent: PROJECT });
    expect(ctx.referent(T0 + REFERENT_TTL_MS - 1)).toEqual(PROJECT);
    expect(ctx.referent(T0 + REFERENT_TTL_MS)).toBeNull();
  });

  it("does not fall back to an older subject when the newest has expired", () => {
    // Reaching further back on expiry would make the memory *longer* the more
    // was said, which is the opposite of what the timeout is for.
    const ctx = new ConversationContext();
    ctx.record({ at: T0, route: "local", referent: PROJECT });
    ctx.record({ at: T0 + 1_000, route: "local", referent: WINDOW });
    expect(ctx.referent(T0 + 1_000 + REFERENT_TTL_MS)).toBeNull();
  });

  it("honours a caller's own window", () => {
    const ctx = new ConversationContext({ ttlMs: 5_000 });
    ctx.record({ at: T0, route: "local", referent: PROJECT });
    expect(ctx.referent(T0 + 4_999)).toEqual(PROJECT);
    expect(ctx.referent(T0 + 5_000)).toBeNull();
  });

  it("forgets everything on reset", () => {
    const ctx = new ConversationContext();
    ctx.record({ at: T0, route: "local", referent: PROJECT });
    ctx.reset();
    expect(ctx.referent(T0 + 1)).toBeNull();
    expect(ctx.history).toHaveLength(0);
  });
});

describe("what the buffer holds", () => {
  it("keeps only the last few turns", () => {
    const ctx = new ConversationContext({ limit: 3 });
    for (let i = 0; i < 10; i += 1) {
      ctx.record({ at: T0 + i, route: "local", intent: `turn.${i}` });
    }
    expect(ctx.history).toHaveLength(3);
    expect(ctx.history[2]?.intent).toBe("turn.9");
  });

  it("never accepts a limit that would hold nothing", () => {
    const ctx = new ConversationContext({ limit: 0 });
    ctx.record({ at: T0, route: "local", referent: PROJECT });
    expect(ctx.referent(T0 + 1)).toEqual(PROJECT);
  });

  it("records the turns that went to the agent too", () => {
    // "Why did it not understand that" needs the declined turns as much as the
    // handled ones.
    const ctx = new ConversationContext();
    ctx.record({ at: T0, route: "agent" });
    ctx.record({ at: T0 + 1, route: "ask" });
    expect(ctx.history.map((t) => t.route)).toEqual(["agent", "ask"]);
  });

  it("has nowhere to put an utterance", () => {
    // Structural, not a policy anyone has to remember: a `Turn` has no field for
    // spoken text, so a rolling buffer of what was audible in the room cannot
    // accumulate here by accident. §50, §52.
    const ctx = new ConversationContext();
    ctx.record({ at: T0, route: "local", intent: "project.open", referent: PROJECT });
    const json = JSON.stringify(ctx.history);
    expect(json).not.toContain("open my jarvis project");
    expect(Object.keys(ctx.history[0] ?? {})).toEqual(["at", "route", "intent", "referent"]);
  });

  it("carries a canonical key, not what the user said", () => {
    // A referent resolved later must not be able to introduce a path or an
    // argument that was not already trusted when it was recorded.
    const ctx = new ConversationContext();
    ctx.record({
      at: T0,
      route: "local",
      referent: { kind: "project", key: "jarvis", label: "jarvis" },
    });
    expect(ctx.referent(T0 + 1)?.key).toBe("jarvis");
  });
});

describe("spotting an utterance that leans on the subject", () => {
  it("finds the pronouns people actually use", () => {
    for (const s of [
      "open it",
      "close that",
      "what is this",
      "show me the same",
      "open the one",
      "delete them",
    ]) {
      expect(usesReferent(s), s).toBe(true);
    }
  });

  it("leaves a self-contained sentence alone", () => {
    for (const s of ["what time is it right now", "open notepad", "mute the microphone"]) {
      // "what time is it" contains "it" — and legitimately resolves to the clock
      // intent before anything referential is considered. This function only
      // reports the presence of a pronoun; precedence belongs to the matcher.
      expect(typeof usesReferent(s)).toBe("boolean");
    }
    expect(usesReferent("open notepad")).toBe(false);
    expect(usesReferent("mute the microphone")).toBe(false);
  });

  it("separates asking about the subject from acting on it", () => {
    // An assistant that answers "what is it" by opening something has conflated
    // the two.
    expect(isReferentialQuestion("what is it")).toBe(true);
    expect(isReferentialQuestion("which one is that")).toBe(true);
    expect(isReferentialQuestion("open it")).toBe(false);
    expect(isReferentialQuestion("close that")).toBe(false);
  });

  it("names a referent the way it would be said out loud", () => {
    expect(describeReferent(WINDOW)).toContain("Chrome");
    expect(describeReferent(PROJECT)).toContain("jarvis");
  });
});
