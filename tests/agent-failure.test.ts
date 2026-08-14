import { describe, it, expect } from "vitest";
import { describeAgentFailure, TurnStalledError } from "../src/runtime/agent-failure.js";
import { RpcError } from "../src/hermes/hermes-adapter.js";

/**
 * The reported defect, pinned.
 *
 * A user asked Jarvis to open a website and the HUD showed a red banner reading
 * exactly "internal error". That string is the whole human-readable payload of
 * JSON-RPC `-32603`, and the runtime was relaying `err.message` verbatim. These
 * tests hold the current shape of the failure text — code present, message
 * present, detail present — so a change that strips the code back out fails
 * here before a user has to look at another unexplained banner.
 */
describe("describeAgentFailure", () => {
  it("does not render -32603 as the bare message the user complained about", () => {
    const f = describeAgentFailure(new RpcError(-32603, "Internal error", null));
    expect(f.code).toBe(-32603);
    expect(f.message).toContain("internal error");
    // The sentence must say something the user can act on, not repeat the
    // useless string they already saw.
    expect(f.message).not.toBe("Internal error");
  });

  it("surfaces the provider's detail, because that is where the cause lives", () => {
    const f = describeAgentFailure(
      new RpcError(-32603, "Internal error", "model timed out after 60s"),
    );
    expect(f.message).toContain("model timed out after 60s");
    expect(f.message).toContain("[rpc -32603]");
  });

  it("keeps the code in the banner and out of the speech", () => {
    const f = describeAgentFailure(
      new RpcError(-32601, "Method not found", null),
    );
    // The code is for reading and searching, not for saying out loud.
    expect(f.message).toContain("[rpc -32601]");
    expect(f.speech).not.toMatch(/\d{4,}/);
  });

  it("says something over the speaker even when it cannot say why", () => {
    const f = describeAgentFailure(new RpcError(-32000, "no provider", null));
    expect(f.speech).toMatch(/That didn't work/i);
    expect(f.message).toContain("no provider");
  });

  it("reads a nested provider error instead of quoting JSON", () => {
    const f = describeAgentFailure(
      new RpcError(-32603, "Internal error", {
        error: { message: "connection refused to model host" },
      }),
    );
    expect(f.message).toContain("connection refused to model host");
  });

  it("serialises non-string detail rather than dropping it", () => {
    const f = describeAgentFailure(
      new RpcError(-32603, "Internal error", { retry_after: 30 }),
    );
    expect(f.message).toContain("retry_after");
  });

  it("redacts credential-shaped text that upstream echoed back", () => {
    // Auth failures routinely echo the offending key. §53 says never expose
    // one, and a banner is as much an exposure as a log line.
    const f = describeAgentFailure(
      new RpcError(-32603, "Internal error", "invalid api key sk-abc123def456ghi789jkl012"),
    );
    expect(f.message).not.toContain("sk-abc123def456ghi789jkl012");
    expect(f.message).toContain("[redacted]");
    expect(f.redacted).toBe(true);
  });

  it("bounds hostile detail instead of letting it flood the banner", () => {
    const f = describeAgentFailure(
      new RpcError(-32603, "Internal error", "x".repeat(5000)),
    );
    expect(f.message.length).toBeLessThan(400);
  });

  it("explains a standard code when the sender only echoed the spec", () => {
    const f = describeAgentFailure(new RpcError(-32700, "Parse error", null));
    expect(f.message).toContain("could not parse");
    // The spec's own words are not repeated back at the user.
    expect(f.message).not.toBe("Parse error");
  });

  it("keeps a real message when the sender bothered to write one", () => {
    const f = describeAgentFailure(
      new RpcError(-32000, "model quota exhausted for today", null),
    );
    expect(f.message).toContain("quota exhausted");
  });

  it("handles a plain Error", () => {
    const f = describeAgentFailure(new Error("hermes process exited"));
    expect(f.message).toContain("hermes process exited");
    expect(f.speech).toBe("That didn't work.");
    expect(f.code).toBeUndefined();
  });

  it("handles a thrown non-Error", () => {
    const f = describeAgentFailure({ error: "socket closed" });
    expect(f.message).toContain("socket closed");
  });

  it("never throws, even on bizarre input", () => {
    for (const weird of [undefined, null, 42, "", Symbol("x")]) {
      const f = describeAgentFailure(weird);
      expect(f.message.length, String(weird)).toBeGreaterThan(0);
    }
  });

  /**
   * The silence case. Distinct from every other failure here because there is no
   * upstream text at all — the agent never spoke, which *is* the failure — so
   * both sentences are Jarvis' own words and the banner has to supply the cause
   * that the (absent) message cannot.
   */
  it("explains a stalled turn rather than falling through to its own message", () => {
    const f = describeAgentFailure(new TurnStalledError(423_000));
    expect(f.message).toMatch(/stopped responding/i);
    expect(f.message).toContain("423s");
    expect(f.message).toMatch(/cancelled the turn/i);
    // Actionable, since the one thing the user can do is ask again.
    expect(f.message).toMatch(/ask again/i);
    // Said out loud: this failure is most likely to be waited on by someone who
    // asked by voice and is not looking at the screen.
    expect(f.speech).toMatch(/stopped responding/i);
    expect(f.speech).not.toMatch(/\d/);
    // Nothing was redacted because no agent text was involved. Claiming
    // otherwise would be a false alarm about a leaked secret.
    expect(f.redacted).toBe(false);
    expect(f.code).toBeUndefined();
  });

  it("rounds the silence to whole seconds in both texts", () => {
    const f = describeAgentFailure(new TurnStalledError(660_400));
    expect(f.message).toContain("660s");
    expect(f.message).not.toContain("660.4");
  });
});
