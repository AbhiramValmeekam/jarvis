import { describe, it, expect } from "vitest";
import {
  LocalIntentEngine,
  CLARIFY_TIMEOUT_MS,
  type EngineDeps,
  type LocalDecision,
} from "../src/local-intents/engine.js";
import type { CatalogEntry } from "../src/system/app-catalog.js";

const ENTRIES: readonly CatalogEntry[] = [
  {
    key: "notepad",
    name: "Notepad",
    launch: { kind: "exec", file: "notepad.exe" },
    aliases: ["notepad"],
    source: "builtin",
  },
];

function makeEngine(
  over: Partial<EngineDeps> & { reply?: () => string } = {},
  audit?: (d: LocalDecision) => void,
) {
  const runs: { file: string; args: readonly string[] }[] = [];
  const launches: { file: string; args: readonly string[] }[] = [];
  let micMuted = false;
  let clock = new Date(2026, 7, 9, 14, 0, 0);

  const deps: EngineDeps = {
    run: async (file, args) => {
      runs.push({ file, args });
      return over.reply ? over.reply() : "50|false";
    },
    launch: async (file, args) => {
      launches.push({ file, args });
    },
    screenshotRoots: ["C:\\Users\\me\\Pictures"],
    now: () => clock,
    setMicMuted: (m) => {
      micMuted = m;
      return true;
    },
    isMicMuted: () => micMuted,
    ...over,
  };

  const engine = new LocalIntentEngine(deps, {
    entries: ENTRIES,
    ...(audit ? { onAudit: audit } : {}),
  });
  return {
    engine,
    runs,
    launches,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    isMicMuted: () => micMuted,
  };
}

describe("routing", () => {
  it("handles a local command without consulting anything else", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle("what time is it");
    expect(d.route).toBe("local");
    expect(d.intent).toBe("time.now");
    expect(d.outcome?.ok).toBe(true);
  });

  it("declines anything agent-shaped, with a reason", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle("summarise my unread email");
    expect(d.route).toBe("agent");
    expect(d.reason).toBeTruthy();
    expect(d.outcome).toBeUndefined();
  });

  it("performs no action at all on the agent path", async () => {
    // The local layer must be inert for utterances it does not claim.
    const { engine, runs, launches } = makeEngine();
    await engine.handle("take a screenshot and email it to my manager");
    expect(runs).toHaveLength(0);
    expect(launches).toHaveLength(0);
  });

  it("launches only apps the catalog holds", async () => {
    const { engine, launches } = makeEngine();
    expect((await engine.handle("open notepad")).route).toBe("local");
    expect(launches[0]?.file).toBe("notepad.exe");

    // Not in the catalog: the agent can ask permission, the local layer cannot.
    expect((await engine.handle("open photoshop")).route).toBe("agent");
    expect(launches).toHaveLength(1);
  });
});

describe("clarifying an ambiguous command", () => {
  it("asks instead of guessing which thing to mute", async () => {
    const { engine, runs, isMicMuted } = makeEngine();
    const d = await engine.handle("mute");
    expect(d.route).toBe("ask");
    expect(d.question).toMatch(/microphone.*speakers/i);
    // Crucially, nothing has happened yet.
    expect(runs).toHaveLength(0);
    expect(isMicMuted()).toBe(false);
    expect(engine.awaitingAnswer).toBe(true);
  });

  it("acts on the answer", async () => {
    const { engine, isMicMuted } = makeEngine();
    await engine.handle("mute");
    const d = await engine.handle("the mic");
    expect(d.route).toBe("local");
    expect(d.intent).toBe("mic.mute");
    expect(isMicMuted()).toBe(true);
    expect(engine.awaitingAnswer).toBe(false);
  });

  it("takes the other answer just as readily", async () => {
    const { engine, runs, isMicMuted } = makeEngine({ reply: () => "50|true" });
    await engine.handle("mute");
    const d = await engine.handle("speakers");
    expect(d.intent).toBe("volume.mute");
    expect(isMicMuted()).toBe(false);
    expect(runs.length).toBeGreaterThan(0);
  });

  it("resolves an unmute question to the unmute side", async () => {
    const { engine, isMicMuted } = makeEngine();
    await engine.handle("mute the microphone");
    expect(isMicMuted()).toBe(true);
    await engine.handle("unmute");
    await engine.handle("microphone");
    expect(isMicMuted()).toBe(false);
  });

  it("drops the question when the user says something else entirely", async () => {
    // They moved on. Insisting on an answer to an abandoned question would be
    // worse than letting the new request through.
    const { engine } = makeEngine();
    await engine.handle("mute");
    const d = await engine.handle("what time is it");
    expect(d.route).toBe("local");
    expect(d.intent).toBe("time.now");
    expect(engine.awaitingAnswer).toBe(false);
  });

  it("treats an answer naming both sides as no answer", async () => {
    const { engine, isMicMuted, runs } = makeEngine();
    await engine.handle("mute");
    const d = await engine.handle("the mic and the speakers");
    expect(d.route).toBe("agent");
    expect(isMicMuted()).toBe(false);
    expect(runs).toHaveLength(0);
  });

  it("expires the question rather than answering it much later", async () => {
    const { engine, advance, isMicMuted } = makeEngine();
    await engine.handle("mute");
    advance(CLARIFY_TIMEOUT_MS + 1);
    expect(engine.awaitingAnswer).toBe(false);

    // "the mic" long afterwards is not an answer to a forgotten question.
    const d = await engine.handle("the mic");
    expect(d.route).toBe("agent");
    expect(isMicMuted()).toBe(false);
  });

  it("still answers just inside the window", async () => {
    const { engine, advance, isMicMuted } = makeEngine();
    await engine.handle("mute");
    advance(CLARIFY_TIMEOUT_MS - 1000);
    await engine.handle("mic");
    expect(isMicMuted()).toBe(true);
  });

  it("forgets the question on reset", async () => {
    const { engine, isMicMuted } = makeEngine();
    await engine.handle("mute");
    engine.reset();
    expect(engine.awaitingAnswer).toBe(false);
    await engine.handle("the mic");
    expect(isMicMuted()).toBe(false);
  });
});

describe("audit", () => {
  it("records every decision, including the ones it declined", async () => {
    // "Why did it send that to Hermes" is the question worth answering later.
    const seen: LocalDecision[] = [];
    const { engine } = makeEngine({}, (d) => seen.push(d));
    await engine.handle("what time is it");
    await engine.handle("write me a haiku");
    await engine.handle("mute");

    expect(seen.map((d) => d.route)).toEqual(["local", "agent", "ask"]);
    expect(seen[0]?.intent).toBe("time.now");
    expect(seen[1]?.reason).toBeTruthy();
  });

  it("records a failed action as failed", async () => {
    const seen: LocalDecision[] = [];
    const { engine } = makeEngine(
      {
        run: async () => {
          throw new Error("device unavailable");
        },
      },
      (d) => seen.push(d),
    );
    await engine.handle("set the volume to 40");
    expect(seen[0]?.route).toBe("local");
    expect(seen[0]?.outcome?.ok).toBe(false);
  });
});

describe("catalog", () => {
  it("exposes what it can open, for the UI and for diagnostics", () => {
    const { engine } = makeEngine();
    expect(engine.catalog.map((e) => e.key)).toEqual(["notepad"]);
  });

  it("performs no discovery I/O when handed a catalog", () => {
    // Tests, and a cached catalog loaded from disk, both rely on this.
    expect(() => makeEngine()).not.toThrow();
  });
});
