/**
 * The §42 policy, from a click in Settings to the engine that decides.
 *
 * `permission-engine.test.ts` proves what a policy *does* once it is handed to the
 * engine, and `config.test.ts` proves which ones survive being read off disk. The
 * question neither can answer is the one this file is about: when someone presses a
 * button in Mission Control, does the engine that judges the next mission step
 * actually change its mind — and does the panel get told the truth about where the
 * rule came from?
 *
 * So every check here goes over the real pipe and then looks at the real engine.
 * The last two are the ones worth having: a class name the renderer invented is
 * refused rather than defaulted, and a session choice never edits `config.json`,
 * because the runtime reads that file once at boot and a settings panel that wrote
 * to it would leave the file and the running engine disagreeing with no way to tell
 * which one you were reading.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isolatedStateDir } from "./helpers/isolate-state.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JarvisRuntime } from "../src/runtime/jarvis-runtime.js";
import { PipeClient } from "../src/ipc/pipe-client.js";
import { readToken } from "../src/ipc/token.js";
import { FakeAdapter } from "./helpers/fake-adapter.js";
import { RISK_CATEGORIES } from "../src/permissions/risk-model.js";
import type { ToolsView } from "../src/ipc/contract.js";

let counter = 0;
function uniquePipe(): string {
  counter++;
  const name = `jarvis-policy-${process.pid}-${counter}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `/tmp/${name}.sock`;
}

const CONFIG = join(isolatedStateDir, "Jarvis", "config.json");

/** Written before the runtime is built, because the file is a boot-time read. */
function writeConfig(config: Record<string, unknown> | null): void {
  mkdirSync(join(isolatedStateDir, "Jarvis"), { recursive: true });
  if (config === null) rmSync(CONFIG, { force: true });
  else writeFileSync(CONFIG, JSON.stringify(config), "utf8");
}

describe("the mission policy, over the wire", () => {
  let runtime: JarvisRuntime | null = null;
  const clients: PipeClient[] = [];
  /** Every consent question the mission engine tried to put to a person. */
  let asked: string[] = [];

  beforeEach(() => {
    FakeAdapter.reset();
    asked = [];
    writeConfig(null);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close();
    if (runtime) await runtime.stop();
    runtime = null;
    writeConfig(null);
  });

  async function start(): Promise<PipeClient> {
    const pipeName = uniquePipe();
    runtime = new JarvisRuntime({
      pipeName,
      lazyHermes: true,
      voice: { enabled: false },
      createAdapter: (o) => new FakeAdapter(o),
      // The consent path, recorded and then declined. `null` is what the broker
      // itself returns when it cannot ask, and the engine reads it as a refusal —
      // so a question asked here is both counted and answered in one line, which
      // keeps a test that expects an ask from waiting out the real two minutes.
      permissions: {
        ask: async (ctx) => {
          asked.push(`${ctx.classification.category}:${ctx.classification.level}`);
          return null;
        },
      },
    });
    await runtime.start();
    const client = new PipeClient({
      pipeName,
      token: readToken() ?? undefined,
      clientName: "policy-ui",
      autoReconnect: false,
      requestTimeoutMs: 5_000,
    });
    await client.connectAndAuthenticate();
    clients.push(client);
    return client;
  }

  const tools = (ui: PipeClient): Promise<ToolsView> =>
    ui.request({ type: "get_tools" }) as Promise<ToolsView>;

  /** What the mission engine would do with one action, right now. */
  async function verdictFor(tool: string, args: unknown): Promise<string> {
    if (!runtime) throw new Error("no runtime");
    const decision = await runtime.missionPermissions.evaluate({ tool, args });
    return decision.verdict;
  }

  it("lists every risk class, not only the ones a tool here uses", async () => {
    // A class that appeared only once something classified as it would appear
    // exactly when it was too late to have set it.
    const view = await tools(await start());
    expect(view.policy.map((p) => p.category)).toEqual([...RISK_CATEGORIES]);
    expect(view.tools.length).toBeGreaterThan(0);
    for (const entry of view.policy) {
      expect(entry, entry.category).toMatchObject({
        effective: "default",
        source: "default",
        configured: null,
      });
    }
  });

  it("sends the deciding engine's own limits, not the constants", async () => {
    const view = await tools(await start());
    // The level rule the panel quotes, and the ceiling above which `auto` still
    // asks. Both are engine options; a panel printing the module constant would be
    // describing a different engine than the one about to decide.
    expect(view.autoAllowUpTo).toBe(1);
    expect(view.autoCeiling).toBe(3);
  });

  it("changes what the engine does with the next step, not just what is drawn", async () => {
    const ui = await start();
    // `run_command` is level 3, three above what the level rule waves through, so
    // neither answer below could have come from the level rule. That is the point:
    // this asserts the policy decided, not that something decided.
    const command = { command: "npm", argv: ["run", "build"] };

    await ui.request({ type: "set_tool_policy", category: "execute", verdict: "deny" });
    expect(await verdictFor("run_command", command)).toBe("deny");
    expect(asked).toEqual([]);

    const after = (await ui.request({
      type: "set_tool_policy",
      category: "execute",
      verdict: "auto",
    })) as ToolsView;
    expect(after.policy.find((p) => p.category === "execute")).toMatchObject({
      effective: "auto",
      source: "session",
      configured: null,
    });
    expect(await verdictFor("run_command", command)).toBe("allow");
    // Neither verdict involved a person, which is what "auto" and "deny" mean.
    expect(asked).toEqual([]);
  });

  it("denies a class outright when told to, whatever the level would have said", async () => {
    const ui = await start();
    // `read` is level 0, which the level rule waves through. A policy that could not
    // reach below the level rule would be a policy in name only.
    expect(await verdictFor("read_file", { path: join(isolatedStateDir, "a.txt") })).toBe("allow");
    await ui.request({ type: "set_tool_policy", category: "read", verdict: "deny" });
    expect(await verdictFor("read_file", { path: join(isolatedStateDir, "a.txt") })).toBe("deny");
    expect(asked).toEqual([]);
  });

  it("cannot permit the top level, however loosely a class is set", async () => {
    const ui = await start();
    const view = (await ui.request({
      type: "set_tool_policy",
      category: "write",
      verdict: "auto",
    })) as ToolsView;
    expect(view.policy.find((p) => p.category === "write")?.effective).toBe("auto");
    // Writing into a protected Windows location is level 4. `auto` is a decision
    // made in advance, and this is the class of action nobody remembers deciding —
    // so it asks anyway, and an unanswered question is a refusal.
    expect(await verdictFor("write_file", { path: "C:\\Windows\\System32\\drivers\\etc\\hosts" })).toBe(
      "deny",
    );
    expect(asked).toEqual(["write:4"]);
  });

  it("asks every time under `approval`, even where the level rule would not have", async () => {
    const ui = await start();
    const file = { path: join(isolatedStateDir, "a.txt") };
    expect(await verdictFor("read_file", file)).toBe("allow");
    expect(asked).toEqual([]);

    await ui.request({ type: "set_tool_policy", category: "read", verdict: "approval" });
    // Twice, because "ask me about these" means every one — a stored always-allow
    // does not get to answer for the next call either.
    await verdictFor("read_file", file);
    await verdictFor("read_file", file);
    expect(asked).toEqual(["read:0", "read:0"]);
  });

  it("shows the file's rule as the file's, and a click on top of it as temporary", async () => {
    writeConfig({ missionPolicy: { execute: "deny", network: "approval" } });
    const ui = await start();

    const fromFile = await tools(ui);
    expect(fromFile.policy.find((p) => p.category === "execute")).toMatchObject({
      effective: "deny",
      source: "config",
      configured: "deny",
    });

    const overridden = (await ui.request({
      type: "set_tool_policy",
      category: "execute",
      verdict: "approval",
    })) as ToolsView;
    // Both facts survive: what is in force, and what the file still says — which is
    // what a restart will go back to.
    expect(overridden.policy.find((p) => p.category === "execute")).toMatchObject({
      effective: "approval",
      source: "session",
      configured: "deny",
    });
  });

  it("goes back to the file when the override is dropped, not to nothing", async () => {
    writeConfig({ missionPolicy: { read: "deny" } });
    const ui = await start();
    expect(await verdictFor("read_file", { path: join(isolatedStateDir, "a.txt") })).toBe("deny");

    await ui.request({ type: "set_tool_policy", category: "read", verdict: "auto" });
    expect(await verdictFor("read_file", { path: join(isolatedStateDir, "a.txt") })).toBe("allow");

    const back = (await ui.request({
      type: "set_tool_policy",
      category: "read",
      verdict: "default",
    })) as ToolsView;
    expect(back.policy.find((p) => p.category === "read")).toMatchObject({
      effective: "deny",
      source: "config",
      configured: "deny",
    });
    expect(await verdictFor("read_file", { path: join(isolatedStateDir, "a.txt") })).toBe("deny");
  });

  it("refuses a class it does not recognise rather than picking one", async () => {
    const ui = await start();
    await expect(
      ui.request({ type: "set_tool_policy", category: "everything", verdict: "auto" }),
    ).rejects.toThrow(/not a risk class/);
    // And nothing moved: a refused request that had quietly set something would be
    // worse than one that failed loudly.
    const view = await tools(ui);
    for (const entry of view.policy) expect(entry.source, entry.category).toBe("default");
  });

  it("does not write the choice into config.json", async () => {
    // The runtime reads that file once at boot. A panel that edited it would leave
    // the file and the running engine disagreeing until a restart — and the label on
    // the panel says "this session", which has to be true.
    writeConfig({ missionPolicy: { network: "deny" } });
    const ui = await start();
    await ui.request({ type: "set_tool_policy", category: "network", verdict: "auto" });
    expect(existsSync(CONFIG)).toBe(true);
    expect(JSON.parse(readFileSync(CONFIG, "utf8"))).toEqual({
      missionPolicy: { network: "deny" },
    });
  });

  it("keeps a policy change out of the Activity view, which is about tool calls", async () => {
    // An `ActivityEntry` is a tool, a level and a verdict. A policy change has none
    // of those, and inventing them would put a row in that view for an action
    // nobody took. It goes to the log instead.
    const ui = await start();
    const before = ((await ui.request({ type: "get_activity" })) as unknown[]).length;
    await ui.request({ type: "set_tool_policy", category: "network", verdict: "deny" });
    expect(((await ui.request({ type: "get_activity" })) as unknown[]).length).toBe(before);
  });
});
