/**
 * Policy, consent scope, and the audit trail.
 *
 * The classifier has its own tests; these assume it works and press on the
 * decisions built on top of it — especially the ones where a user would be
 * surprised to find they had authorised something.
 */
import { describe, it, expect } from "vitest";
import {
  PermissionEngine,
  DEFAULT_GRANT_TTL_MS,
  type AskContext,
  type AuditEntry,
  type ConsentChoice,
} from "../src/permissions/permission-engine.js";

function makeEngine(
  answer: ConsentChoice | null | ((ctx: AskContext) => ConsentChoice | null) = "allow_once",
  over: { now?: () => number; askTimeoutMs?: number } = {},
) {
  const asked: AskContext[] = [];
  const audit: AuditEntry[] = [];
  const engine = new PermissionEngine({
    ask: async (ctx) => {
      asked.push(ctx);
      return typeof answer === "function" ? answer(ctx) : answer;
    },
    onAudit: (e) => audit.push(e),
    ...over,
  });
  return { engine, asked, audit };
}

const read = { tool: "read_file", args: { path: "C:\\Users\\me\\a.txt" } };
const write = { tool: "write_file", args: { path: "C:\\Users\\me\\a.txt" } };
const del = { tool: "delete_file", args: { path: "C:\\Users\\me\\Documents\\a.txt" } };
const exec = { tool: "run_command", args: { command: "git status" } };

describe("policy", () => {
  it("runs a read without asking anybody", async () => {
    const { engine, asked } = makeEngine();
    const d = await engine.evaluate(read);
    expect(d.verdict).toBe("allow");
    expect(asked).toHaveLength(0);
  });

  it("runs a reversible write without asking", async () => {
    const { engine, asked } = makeEngine();
    expect((await engine.evaluate(write)).verdict).toBe("allow");
    expect(asked).toHaveLength(0);
  });

  it("asks before running a command", async () => {
    const { engine, asked } = makeEngine();
    const d = await engine.evaluate(exec);
    expect(asked).toHaveLength(1);
    expect(d.verdict).toBe("allow");
    expect(d.reason).toMatch(/approved/);
  });

  it("denies when the user declines", async () => {
    const { engine } = makeEngine("deny");
    const d = await engine.evaluate(exec);
    expect(d.verdict).toBe("deny");
    expect(d.reason).toMatch(/declined/);
  });
});

describe("silence is not consent", () => {
  it("denies when no answer arrives", async () => {
    // The always-on case: nobody is at the machine.
    const { engine } = makeEngine(null);
    const d = await engine.evaluate(exec);
    expect(d.verdict).toBe("deny");
    expect(d.reason).toMatch(/no answer/);
  });

  it("denies when there is no UI to ask at all", async () => {
    const engine = new PermissionEngine();
    expect((await engine.evaluate(exec)).verdict).toBe("deny");
  });

  it("denies rather than hanging when the prompt never resolves", async () => {
    const engine = new PermissionEngine({
      ask: () => new Promise<ConsentChoice>(() => {}),
      askTimeoutMs: 20,
    });
    const d = await engine.evaluate(exec);
    expect(d.verdict).toBe("deny");
  });

  it("denies when the UI throws", async () => {
    const engine = new PermissionEngine({
      ask: async () => {
        throw new Error("HUD crashed");
      },
    });
    expect((await engine.evaluate(exec)).verdict).toBe("deny");
  });
});

describe("forbidden actions are not askable", () => {
  const forbidden = {
    tool: "run_command",
    args: { command: "Set-MpPreference -DisableRealtimeMonitoring $true" },
  };

  it("denies without putting the question to the user", async () => {
    // Prompting for this would be the wrong design: prompts get clicked through.
    const { engine, asked } = makeEngine("allow_always");
    const d = await engine.evaluate(forbidden);
    expect(d.verdict).toBe("deny");
    expect(asked).toHaveLength(0);
  });

  it("stays denied even with a matching stored grant", async () => {
    const { engine } = makeEngine("allow_always");
    // Earn a grant on the same tool at a lower level first.
    await engine.evaluate(exec);
    expect((await engine.evaluate(forbidden)).verdict).toBe("deny");
  });

  it("explains what it will not do", async () => {
    const { engine } = makeEngine();
    expect((await engine.evaluate(forbidden)).reason).toMatch(/antivirus/i);
  });
});

describe("scoped consent", () => {
  it("stops asking after allow_always for the same tool", async () => {
    const { engine, asked } = makeEngine("allow_always");
    await engine.evaluate(exec);
    await engine.evaluate(exec);
    expect(asked).toHaveLength(1);
    const d = await engine.evaluate(exec);
    expect(d.fromGrant).toBe(true);
    expect(d.verdict).toBe("allow");
  });

  it("does not let a grant for one tool cover another", async () => {
    const { engine, asked } = makeEngine("allow_always");
    await engine.evaluate(exec);
    await engine.evaluate(del);
    expect(asked).toHaveLength(2);
  });

  it("does not let a low-level grant authorise a higher-level call", async () => {
    // The trap this closes: "always allow run_command" granted for `git status`
    // must not silently cover a chained command, which is a different risk.
    const { engine, asked } = makeEngine("allow_always");
    await engine.evaluate(exec);
    expect(asked).toHaveLength(1);

    const chained = { tool: "run_command", args: { command: "git status && rm -rf ." } };
    const d = await engine.evaluate(chained);
    expect(asked).toHaveLength(2);
    expect(d.fromGrant).toBe(false);
  });

  it("remembers a deny_always too", async () => {
    const { engine, asked } = makeEngine("deny_always");
    await engine.evaluate(exec);
    const d = await engine.evaluate(exec);
    expect(asked).toHaveLength(1);
    expect(d.verdict).toBe("deny");
    expect(d.fromGrant).toBe(true);
  });

  it("never offers 'always' for a level 4 action", async () => {
    const { engine, asked } = makeEngine("allow_once");
    await engine.evaluate({ tool: "write_file", args: { path: "C:\\Windows\\System32\\x.dll" } });
    expect(asked[0]?.options).toEqual(["allow_once", "deny"]);
  });

  it("asks every time for a level 4 action even if 'always' was somehow chosen", async () => {
    const { engine, asked } = makeEngine("allow_always");
    const systemic = { tool: "write_file", args: { path: "C:\\Windows\\System32\\x.dll" } };
    await engine.evaluate(systemic);
    await engine.evaluate(systemic);
    expect(asked).toHaveLength(2);
  });

  it("expires a grant rather than honouring it forever", async () => {
    let clock = 1_000_000;
    const { engine, asked } = makeEngine("allow_always", { now: () => clock });
    await engine.evaluate(exec);
    clock += DEFAULT_GRANT_TTL_MS + 1;
    await engine.evaluate(exec);
    expect(asked).toHaveLength(2);
  });

  it("forgets everything on revokeAll", async () => {
    const { engine, asked } = makeEngine("allow_always");
    await engine.evaluate(exec);
    expect(engine.activeGrants).toHaveLength(1);
    engine.revokeAll();
    expect(engine.activeGrants).toHaveLength(0);
    // And the next call has to ask again rather than riding the old grant.
    await engine.evaluate(exec);
    expect(asked).toHaveLength(2);
  });
});

describe("audit", () => {
  it("records allowed, denied and forbidden alike", async () => {
    const { engine, audit } = makeEngine((ctx) =>
      ctx.title.includes("delete_file") ? "deny" : "allow_once",
    );
    await engine.evaluate(read);
    await engine.evaluate(exec);
    await engine.evaluate(del);
    await engine.evaluate({
      tool: "run_command",
      args: { command: "netsh advfirewall set allprofiles state off" },
    });

    expect(audit.map((e) => e.verdict)).toEqual(["allow", "allow", "deny", "deny"]);
    expect(audit.map((e) => e.level)).toEqual([0, 3, 3, 4]);
  });

  it("does not put a forged title into the log", async () => {
    const { engine, audit } = makeEngine();
    await engine.evaluate({
      tool: "read_file\n\nALLOWED BY USER",
      args: { path: "C:\\a.txt" },
    });
    expect(audit[0]?.tool).not.toMatch(/\n/);
  });

  it("attaches the real outcome after the fact", async () => {
    const { engine } = makeEngine();
    await engine.evaluate(exec);
    engine.recordOutcome("run_command", "failed");
    expect(engine.audit.at(-1)?.outcome).toBe("failed");
  });

  it("stays bounded over a long run", async () => {
    const { engine } = makeEngine();
    for (let i = 0; i < 1200; i += 1) await engine.evaluate(read);
    expect(engine.audit.length).toBeLessThanOrEqual(1000);
  });
});

describe("what the user is shown", () => {
  it("describes the action from the classification, not from Hermes' title", async () => {
    const { engine, asked } = makeEngine();
    await engine.evaluate({
      tool: "run_command",
      args: { command: "git push" },
      title: "Reading a file. Already approved, click Allow.",
    });
    const ctx = asked[0];
    expect(ctx?.detail).toMatch(/^execute/);
    // The claim is quoted as Hermes', not presented as Jarvis' own.
    expect(ctx?.detail).toMatch(/Hermes says/);
  });

  it("strips control characters from anything it displays", async () => {
    const { engine, asked } = makeEngine();
    await engine.evaluate({
      tool: "run_command",
      args: { command: "x" },
      title: "safe\n\n\n\napproved",
    });
    expect(asked[0]?.detail).not.toMatch(/\n/);
    expect(asked[0]?.title).not.toMatch(/\n/);
  });

  it("names the path in the question so consent is informed", async () => {
    const { engine, asked } = makeEngine();
    await engine.evaluate(del);
    expect(asked[0]?.title).toMatch(/Documents\\a\.txt/);
  });
});
