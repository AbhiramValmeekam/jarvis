import { describe, it, expect } from "vitest";
import {
  LocalIntentEngine,
  CLARIFY_TIMEOUT_MS,
  type EngineDeps,
  type LocalDecision,
} from "../src/local-intents/engine.js";
import type { CatalogEntry } from "../src/system/app-catalog.js";
import type { WindowFacts } from "../src/context/window-facts.js";
import { REFERENT_TTL_MS } from "../src/context/conversation-context.js";
import {
  aliasesForProject,
  type ProjectEntry,
} from "../src/context/project-registry.js";

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

/**
 * "What am I looking at" through the whole local path.
 *
 * The value here is not the plumbing — that is one dispatch entry. It is that
 * each of the four things the reader can report comes out of Jarvis's mouth as a
 * different sentence. A reader that distinguishes "nothing focused" from "I could
 * not look" is worth nothing if the executor flattens both into one reply.
 */
describe("the active window intent", () => {
  // Annotated, not inferred. Written without the annotation first, the object
  // was missing `pid` and every test still passed — vitest does not typecheck,
  // so the fixture drifted from the type it claims to be until `tsc` said so.
  const window: WindowFacts = {
    process: "chrome",
    pid: 4820,
    title: "Inbox (3)",
    hasTitle: true,
    kind: "browser",
    origin: "web",
    redacted: false,
  };

  it("answers locally, without waking Hermes", async () => {
    const { engine } = makeEngine({ readActiveWindow: async () => ({ ok: true, window }) });
    const d = await engine.handle("what am i looking at");
    expect(d.route).toBe("local");
    expect(d.intent).toBe("window.active");
    expect(d.outcome?.speech).toContain("chrome");
  });

  it("distinguishes an empty foreground from a failed read", async () => {
    const empty = makeEngine({ readActiveWindow: async () => ({ ok: true, window: null }) });
    const broken = makeEngine({
      readActiveWindow: async () => ({ ok: false, reason: "powershell missing" }),
    });

    const a = await empty.engine.handle("what window is in front");
    const b = await broken.engine.handle("what window is in front");

    expect(a.outcome?.ok).toBe(true);
    expect(b.outcome?.ok).toBe(false);
    expect(a.outcome?.speech).not.toBe(b.outcome?.speech);
  });

  it("says so when it has no reader at all, rather than inventing a desktop", async () => {
    // `readActiveWindow` is optional on the deps, so this is the shape a caller
    // that predates the field gets. It must not read as "nothing is focused".
    const { engine } = makeEngine();
    const d = await engine.handle("what am i looking at");
    expect(d.outcome?.ok).toBe(false);
    expect(d.outcome?.speech).toMatch(/can't see/i);
  });

  it("keeps the window title out of the audit detail", async () => {
    // §53. The spoken reply needs the title; the log does not, and a log is the
    // one place a document name or a subject line persists on disk.
    const seen: LocalDecision[] = [];
    const { engine } = makeEngine({ readActiveWindow: async () => ({ ok: true, window }) }, (d) =>
      seen.push(d),
    );
    await engine.handle("what am i looking at");
    expect(seen[0]?.outcome?.detail).not.toContain("Inbox");
    expect(seen[0]?.outcome?.detail).toContain("process=chrome");
  });

  it("flags a redacted title so the user knows something was withheld", async () => {
    const { engine } = makeEngine({
      readActiveWindow: async () => ({
        ok: true,
        window: { ...window, title: "token=[redacted]", redacted: true },
      }),
    });
    const d = await engine.handle("what am i looking at");
    expect(d.outcome?.speech).toMatch(/looked like a secret/i);
  });
});

/**
 * Opening a project by name.
 *
 * The security property under test is narrow and worth naming: the directory
 * handed to the shell comes from the registry, never from the utterance. Nothing
 * a person says near the microphone becomes a path.
 */
describe("the project intents", () => {
  // Aliases come from the real generator, never hand-written. A fixture that
  // invents its own alias list tests a registry that does not exist — and this
  // one did: it gave `jarvis-ui` no `jarvis` alias, so the collision the
  // ambiguity test exists to prove could not occur.
  const project = (
    name: string,
    dir: string,
    kind: ProjectEntry["kind"],
    root: string,
  ): ProjectEntry => ({
    key: name.toLowerCase(),
    name,
    dir,
    kind,
    aliases: aliasesForProject(name),
    root,
  });

  const PROJECTS: readonly ProjectEntry[] = [
    project("jarvis", "E:\\jarvis", "node", "E:\\"),
    project("hermes-agent", "E:\\code\\hermes-agent", "python", "E:\\code"),
  ];

  it("opens a project the registry knows, using the registry's own path", async () => {
    const { engine, launches } = makeEngine({ projects: () => PROJECTS });
    const d = await engine.handle("open my jarvis project");
    expect(d.route).toBe("local");
    expect(d.intent).toBe("project.open");
    expect(launches[0]?.args).toContain("E:\\jarvis");
  });

  it("sends an unknown project name to the agent rather than guessing a path", async () => {
    const { engine, launches } = makeEngine({ projects: () => PROJECTS });
    const d = await engine.handle("open my accounting project");
    expect(d.route).toBe("agent");
    expect(launches).toHaveLength(0);
  });

  it("never lets the utterance become the path", async () => {
    // The whole reason `project.open` resolves through the registry.
    const { engine, launches } = makeEngine({ projects: () => PROJECTS });
    await engine.handle("open my ..\\..\\Windows\\System32 project");
    await engine.handle("open my C:\\Users project");
    expect(launches).toHaveLength(0);
  });

  it("asks when a name fits more than one project", async () => {
    const two: readonly ProjectEntry[] = [
      ...PROJECTS,
      project("jarvis-ui", "E:\\code\\jarvis-ui", "node", "E:\\code"),
    ];
    const { engine, launches } = makeEngine({ projects: () => two });
    const d = await engine.handle("open my jarvis project");
    expect(d.route).toBe("ask");
    expect(d.question).toMatch(/jarvis/i);
    expect(launches).toHaveLength(0);
  });

  it("opens the one the user names in answer", async () => {
    // The other half of asking. A question that cannot be answered is worse
    // than a guess, because the user has spoken twice and nothing has happened.
    const two: readonly ProjectEntry[] = [
      ...PROJECTS,
      project("jarvis-ui", "E:\\code\\jarvis-ui", "node", "E:\\code"),
    ];
    const { engine, launches } = makeEngine({ projects: () => two });
    expect((await engine.handle("open my jarvis project")).route).toBe("ask");

    const d = await engine.handle("jarvis ui");
    expect(d.route).toBe("local");
    expect(d.intent).toBe("project.open");
    expect(launches[0]?.args).toContain("E:\\code\\jarvis-ui");
    expect(engine.awaitingAnswer).toBe(false);
  });

  it("opens neither when the answer names both", async () => {
    const two: readonly ProjectEntry[] = [
      ...PROJECTS,
      project("jarvis-ui", "E:\\code\\jarvis-ui", "node", "E:\\code"),
    ];
    const { engine, launches } = makeEngine({ projects: () => two });
    await engine.handle("open my jarvis project");
    const d = await engine.handle("jarvis and jarvis ui");
    expect(d.route).toBe("agent");
    expect(launches).toHaveLength(0);
  });

  it("lists what it found", async () => {
    const { engine } = makeEngine({ projects: () => PROJECTS });
    const d = await engine.handle("what projects do i have");
    expect(d.route).toBe("local");
    expect(d.outcome?.speech).toContain("jarvis");
  });

  it("distinguishes an empty scan from never having been told where to look", async () => {
    const unconfigured = makeEngine({ projects: () => [], projectRoots: () => [] });
    const empty = makeEngine({ projects: () => [], projectRoots: () => ["E:\\code"] });

    const a = await unconfigured.engine.handle("list my projects");
    const b = await empty.engine.handle("list my projects");

    expect(a.outcome?.speech).toMatch(/don't know where/i);
    expect(b.outcome?.speech).toMatch(/didn't find/i);
    expect(a.outcome?.speech).not.toBe(b.outcome?.speech);
  });

  it("does not claim a registry it was never given", async () => {
    // `projects` is optional on the deps, so this is what a caller predating
    // the field gets. It must not read as "you have no projects".
    const { engine } = makeEngine();
    const d = await engine.handle("list my projects");
    expect(d.outcome?.speech).toMatch(/don't know where/i);
  });
});

/**
 * "Open it" — the pronoun, through the engine.
 *
 * The interesting tests here are the negative ones. A referent that resolves too
 * eagerly is a worse assistant than one that has none at all: it acts on a
 * subject nobody named, and the user finds out afterwards. So these pin the
 * boundary as hard as the happy path.
 */
describe("referring back to the last thing", () => {
  const project = (name: string, dir: string): ProjectEntry => ({
    key: name.toLowerCase(),
    name,
    dir,
    kind: "node",
    aliases: aliasesForProject(name),
    root: "E:\\code",
  });

  const PROJECTS: readonly ProjectEntry[] = [project("hermes-agent", "E:\\code\\hermes-agent")];

  it("opens the project named a moment ago", async () => {
    const { engine, launches } = makeEngine({ projects: () => PROJECTS });
    await engine.handle("open my hermes project");
    const d = await engine.handle("open it again");
    expect(d.route).toBe("local");
    expect(d.intent).toBe("project.open");
    // Both launches used the registry's path, not the pronoun.
    expect(launches).toHaveLength(2);
    expect(launches[1]?.args).toContain("E:\\code\\hermes-agent");
  });

  it("sends the pronoun to the agent when nothing has been mentioned", async () => {
    const { engine, launches } = makeEngine({ projects: () => PROJECTS });
    const d = await engine.handle("open it");
    expect(d.route).toBe("agent");
    expect(launches).toHaveLength(0);
  });

  it("does not let a pronoun steal an utterance a real pattern claims", async () => {
    // "what time is it" contains "it". A referent tried before the rules — or
    // instead of them — would answer this with a directory.
    const { engine, launches } = makeEngine({ projects: () => PROJECTS });
    await engine.handle("open my hermes project");
    const d = await engine.handle("what time is it");
    expect(d.intent).toBe("time.now");
    expect(launches).toHaveLength(1);
  });

  it("refuses to act referentially on anything but opening", async () => {
    // The guardrail that matters. "Delete it" must never resolve to a remembered
    // directory, however confidently the engine knows which one is meant.
    const { engine, launches, runs } = makeEngine({ projects: () => PROJECTS });
    await engine.handle("open my hermes project");
    const d = await engine.handle("delete it");
    expect(d.route).toBe("agent");
    expect(launches).toHaveLength(1);
    expect(runs).toHaveLength(0);
  });

  it("forgets the subject once the window has passed", async () => {
    const { engine, advance, launches } = makeEngine({ projects: () => PROJECTS });
    await engine.handle("open my hermes project");
    advance(REFERENT_TTL_MS + 1);
    const d = await engine.handle("open it");
    expect(d.route).toBe("agent");
    expect(launches).toHaveLength(1);
  });

  it("forgets the subject on reset, like the question", async () => {
    // Barge-in means the user abandoned the thread. Reopening what they were
    // last on would be acting on a conversation that has already ended.
    const { engine, launches } = makeEngine({ projects: () => PROJECTS });
    await engine.handle("open my hermes project");
    engine.reset();
    const d = await engine.handle("open it");
    expect(d.route).toBe("agent");
    expect(launches).toHaveLength(1);
  });
});
