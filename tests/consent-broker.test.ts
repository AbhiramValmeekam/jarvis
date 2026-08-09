/**
 * The broker's only real job is to always resolve.
 *
 * Correctness of the *decision* is the engine's problem. These tests are about
 * the ways a question can be left hanging, because a permission check that
 * hangs is one that gets switched off.
 */
import { describe, it, expect, vi } from "vitest";
import { ConsentBroker } from "../src/permissions/consent-broker.js";
import type { AskContext } from "../src/permissions/permission-engine.js";

const ctx = (requestId = "perm-1"): AskContext => ({
  requestId,
  title: "Allow run_command?",
  detail: "execute (level 3)",
  options: ["allow_once", "allow_always", "deny", "deny_always"],
  classification: {
    level: 3,
    category: "execute",
    reason: "runs a program on this machine",
    forbidden: false,
    paths: [],
  },
});

describe("asking", () => {
  it("returns the answer the user gave", async () => {
    const broker = new ConsentBroker({ send: () => true });
    const answer = broker.ask(ctx());
    expect(broker.pending).toHaveLength(1);
    expect(broker.resolve("perm-1", "allow_once")).toBe(true);
    expect(await answer).toBe("allow_once");
    expect(broker.pending).toHaveLength(0);
  });

  it("denies immediately when there is no UI attached", async () => {
    const broker = new ConsentBroker({ send: () => false });
    expect(await broker.ask(ctx())).toBeNull();
    expect(broker.pending).toHaveLength(0);
  });

  it("shows the user the title, detail and options", async () => {
    const send = vi.fn(() => true);
    const broker = new ConsentBroker({ send });
    void broker.ask(ctx());
    expect(send).toHaveBeenCalledWith({
      requestId: "perm-1",
      title: "Allow run_command?",
      detail: "execute (level 3)",
      options: ["allow_once", "allow_always", "deny", "deny_always"],
      classification: {
        level: 3,
        category: "execute",
        reason: "runs a program on this machine",
        forbidden: false,
        paths: [],
      },
    });
    broker.cancelAll("test");
  });

  it("passes the classification through, not just the sentence", async () => {
    // The dialog weights itself on level and category. If the broker dropped
    // them, every request would render at the same severity and the levels
    // would stop meaning anything on screen.
    const send = vi.fn(() => true);
    const broker = new ConsentBroker({ send });
    void broker.ask({
      ...ctx(),
      classification: {
        level: 4,
        category: "delete",
        reason: "deletes files that may not be replaceable",
        forbidden: false,
        paths: ["C:\\Users\\me\\taxes.pdf"],
      },
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: expect.objectContaining({
          level: 4,
          category: "delete",
          paths: ["C:\\Users\\me\\taxes.pdf"],
        }),
      }),
    );
    broker.cancelAll("test");
  });
});

describe("nothing is left hanging", () => {
  it("times out an unanswered question", async () => {
    const broker = new ConsentBroker({ send: () => true, timeoutMs: 15 });
    expect(await broker.ask(ctx())).toBeNull();
    expect(broker.pending).toHaveLength(0);
  });

  it("resolves everything open when the UI goes away", async () => {
    const broker = new ConsentBroker({ send: () => true });
    const a = broker.ask(ctx("perm-1"));
    const b = broker.ask(ctx("perm-2"));
    expect(broker.cancelAll("ui detached")).toBe(2);
    expect(await a).toBeNull();
    expect(await b).toBeNull();
  });

  it("refuses a flood rather than queueing it", async () => {
    const broker = new ConsentBroker({ send: () => true, maxPending: 2 });
    void broker.ask(ctx("perm-1"));
    void broker.ask(ctx("perm-2"));
    // Queueing this would train the user to click through a backlog.
    expect(await broker.ask(ctx("perm-3"))).toBeNull();
    broker.cancelAll("test");
  });
});

describe("answers that should not count", () => {
  it("rejects a decision for an id it never asked about", () => {
    const broker = new ConsentBroker({ send: () => true });
    expect(broker.resolve("perm-forged", "allow_always")).toBe(false);
  });

  it("rejects a second answer to the same question", async () => {
    const broker = new ConsentBroker({ send: () => true });
    const answer = broker.ask(ctx());
    expect(broker.resolve("perm-1", "deny")).toBe(true);
    // A stale click must not overturn a settled decision.
    expect(broker.resolve("perm-1", "allow_always")).toBe(false);
    expect(await answer).toBe("deny");
  });

  it("rejects an answer that arrives after the timeout", async () => {
    const broker = new ConsentBroker({ send: () => true, timeoutMs: 10 });
    const answer = broker.ask(ctx());
    expect(await answer).toBeNull();
    expect(broker.resolve("perm-1", "allow_always")).toBe(false);
  });
});
