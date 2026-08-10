import { describe, it, expect } from "vitest";
import {
  matchIntent,
  routeUtterance,
  normalise,
  LOCAL_THRESHOLD,
  type IntentContext,
  type LocalIntentId,
} from "../src/local-intents/intent-model.js";

/** A small, realistic catalog. Resolution is the only thing gating app.launch. */
const APPS: IntentContext = {
  apps: new Map<string, readonly string[]>([
    ["notepad", ["notepad", "note pad"]],
    ["chrome", ["chrome", "google chrome"]],
    ["spotify", ["spotify"]],
    ["vs code", ["vs code", "vscode", "visual studio code", "code"]],
  ]),
};

const id = (text: string, ctx: IntentContext = APPS): LocalIntentId | null => {
  const r = matchIntent(text, ctx);
  return r.kind === "match" ? r.id : null;
};

describe("normalise", () => {
  it("strips the wake word the transcript keeps", () => {
    expect(normalise("Jarvis, what time is it?")).toBe("what time is it");
    expect(normalise("Hey Jarvis lock the screen")).toBe("lock the screen");
  });

  it("strips spoken politeness, which never changes the request", () => {
    expect(normalise("Could you take a screenshot please?")).toBe("take a screenshot");
    expect(normalise("please lock my laptop")).toBe("lock my laptop");
    expect(normalise("Open Notepad for me.")).toBe("open notepad");
  });

  it("leaves the instruction itself alone", () => {
    expect(normalise("set the volume to 40%")).toBe("set the volume to 40%");
  });
});

describe("recognising local commands", () => {
  it("answers the clock without a language model", () => {
    for (const s of ["what time is it", "what's the time", "time", "tell me the time"]) {
      expect(id(s), s).toBe("time.now");
    }
    for (const s of ["what's the date", "what day is it", "what is today's date"]) {
      expect(id(s), s).toBe("date.today");
    }
  });

  it("reads a volume level, spoken or written", () => {
    const level = (s: string): number | undefined => {
      const r = matchIntent(s, APPS);
      return r.kind === "match" ? r.slots.level : undefined;
    };
    expect(level("set the volume to 40")).toBe(40);
    expect(level("volume to 65%")).toBe(65);
    expect(level("set volume to fifty")).toBe(50);
    expect(level("set the volume to max")).toBe(100);
    expect(level("set the volume to half")).toBe(50);
  });

  it("rejects a volume level that is not one", () => {
    // Better to let the agent puzzle over it than to set the volume to 900.
    expect(id("set the volume to 900")).toBeNull();
    expect(id("set the volume to whatever")).toBeNull();
  });

  it("handles relative volume, with and without a step", () => {
    expect(id("volume up")).toBe("volume.up");
    expect(id("turn it down")).toBe("volume.down");
    expect(id("louder")).toBe("volume.up");
    const r = matchIntent("volume up by 10", APPS);
    expect(r.kind === "match" && r.slots.step).toBe(10);
  });

  it("covers the rest of the listed commands", () => {
    expect(id("take a screenshot")).toBe("screenshot");
    expect(id("screenshot")).toBe("screenshot");
    expect(id("lock the computer")).toBe("lock");
    expect(id("lock my laptop")).toBe("lock");
    expect(id("battery")).toBe("battery");
    expect(id("how much battery do i have")).toBe("battery");
    expect(id("cpu usage")).toBe("resources");
    expect(id("how's my memory doing")).toBe("resources");
  });
});

describe("microphone versus speakers", () => {
  it("keeps the two mutes apart", () => {
    expect(id("mute the microphone")).toBe("mic.mute");
    expect(id("turn off my mic")).toBe("mic.mute");
    expect(id("stop listening")).toBe("mic.mute");
    expect(id("mute the volume")).toBe("volume.mute");
    expect(id("mute the speakers")).toBe("volume.mute");
    expect(id("be quiet")).toBe("volume.mute");
  });

  it("asks rather than guessing on a bare mute", () => {
    // Guessing speakers would leave a live microphone behind a user who
    // believes they just switched it off. That is a privacy failure, so ask.
    const r = matchIntent("mute", APPS);
    expect(r.kind).toBe("ambiguous");
    expect(r.kind === "ambiguous" && r.candidates).toEqual(["mic.mute", "volume.mute"]);
    expect(routeUtterance("mute", APPS).route).toBe("ask");
    expect(routeUtterance("unmute", APPS).route).toBe("ask");
  });
});

describe("app launch", () => {
  it("fires only for apps the catalog actually knows", () => {
    const r = matchIntent("open notepad", APPS);
    expect(r.kind === "match" && r.id).toBe("app.launch");
    expect(r.kind === "match" && r.slots.app).toBe("notepad");
  });

  it("resolves aliases to one canonical key", () => {
    for (const s of ["open vscode", "launch visual studio code", "start vs code"]) {
      const r = matchIntent(s, APPS);
      expect(r.kind === "match" && r.slots.app, s).toBe("vs code");
    }
  });

  it("sends an unknown name to the agent instead of failing locally", () => {
    // The agent may well know how to open it. A local "I can't" would be worse.
    expect(id("open the pod bay doors")).toBeNull();
    expect(routeUtterance("open the pod bay doors", APPS).route).toBe("agent");
  });

  it("never fires with no catalog, rather than guessing", () => {
    expect(id("open notepad", {})).toBeNull();
  });

  it("ignores filler around the name", () => {
    const r = matchIntent("open the spotify app", APPS);
    expect(r.kind === "match" && r.slots.app).toBe("spotify");
  });
});

describe("looking at the screen versus saving a picture of it", () => {
  it("recognises a request to look", () => {
    for (const s of [
      "look at my screen",
      "read my screen",
      "check the screen",
      "look at my screen and tell me what this error says",
      "what does my screen say",
      "tell me what the screen shows",
      "read this for me",
    ]) {
      expect(id(s), s).toBe("screen.read");
    }
  });

  it("leaves 'take a screenshot' meaning save me a file", () => {
    // The two intents are one word apart in English and worlds apart in effect:
    // one writes a PNG to Pictures, the other uploads the desktop to a model.
    for (const s of ["take a screenshot", "screenshot", "grab a screenshot"]) {
      expect(id(s), s).not.toBe("screen.read");
    }
  });

  it("does not fire on a sentence that merely mentions the screen", () => {
    for (const s of [
      "why does my screen keep flickering",
      "turn the screen brightness down",
      "share my screen with the team every ten minutes",
    ]) {
      expect(id(s), s).not.toBe("screen.read");
    }
  });
});

describe("not stealing the agent's work", () => {
  /**
   * The regression suite that matters most. Every one of these contains a
   * local-looking keyword and is unambiguously a request for Hermes.
   */
  const forHermes = [
    "open the quarterly report and summarise the third section",
    "what time should i schedule the standup",
    "take a screenshot and email it to my manager",
    "lock the screen after the build finishes",
    "why is my cpu usage so high lately",
    "how much battery life will i get if i dim the display",
    "set the volume to whatever it was yesterday",
    "mute the microphone when i join a meeting",
    "open notepad and write a poem about the sea",
    "can you explain what the volume mixer does",
    "write a script that takes a screenshot every hour",
    "remind me to lock my laptop when i leave",
    "what does it mean when the memory usage keeps climbing",
    "tell me the time in tokyo",
  ];

  it("routes every compound or conversational request to the agent", () => {
    for (const s of forHermes) {
      expect(routeUtterance(s, APPS).route, s).toBe("agent");
    }
  });

  it("matches nothing at all for those utterances", () => {
    // Not merely below threshold — anchoring means they cannot match a rule.
    for (const s of forHermes) {
      expect(matchIntent(s, APPS).kind, s).toBe("none");
    }
  });
});

describe("routing", () => {
  it("keeps a confident match local", () => {
    const r = routeUtterance("what time is it", APPS);
    expect(r.route).toBe("local");
    expect(r.route === "local" && r.match.confidence).toBeGreaterThanOrEqual(LOCAL_THRESHOLD);
  });

  it("explains why it chose the agent, for the audit log", () => {
    const r = routeUtterance("write me a haiku", APPS);
    expect(r.route === "agent" && r.reason).toMatch(/no local intent/);
  });

  it("treats an empty utterance as nothing to do", () => {
    expect(routeUtterance("", APPS).route).toBe("agent");
    expect(routeUtterance("   ", APPS).route).toBe("agent");
  });
});

describe("memory", () => {
  const said = (text: string): string | undefined => {
    const r = matchIntent(text, APPS);
    return r.kind === "match" ? r.slots.text : undefined;
  };

  it("recognises the ways a person asks for something to be written down", () => {
    expect(id("remember that the staging box is 10.0.0.7")).toBe("memory.remember");
    expect(id("note that the release ships friday")).toBe("memory.remember");
    expect(id("make a note that the dentist is on tuesday")).toBe("memory.remember");
    expect(id("keep in mind: the api rotates monthly")).toBe("memory.remember");
    expect(id("don't forget about the dentist on tuesday")).toBe("memory.remember");
  });

  it("captures the text as spoken, not as normalised", () => {
    // `normalise` lowercases and strips punctuation, so a memory taken from the
    // matched text would be stored as "sarah s flight is on the 14th".
    expect(said("Jarvis, remember that Sarah's flight is on the 14th.")).toBe(
      "Sarah's flight is on the 14th",
    );
    expect(said("note that version 3.5 ships Friday")).toBe("version 3.5 ships Friday");
  });

  it("keeps politeness out of the note", () => {
    expect(said("remember to call mum please")).toBe("to call mum");
  });

  it("leaves teaching Hermes to Hermes", () => {
    // Its own memory tool does that write, with its own lock and threat scan.
    expect(routeUtterance("tell hermes to remember that i deploy on fridays", APPS).route)
      .toBe("agent");
    expect(routeUtterance("ask hermes to remember my name", APPS).route).toBe("agent");
  });

  it("does not fire on the bare word", () => {
    expect(id("remember")).toBeNull();
    expect(id("forget it")).toBeNull();
  });

  it("separates recall about a subject from listing everything", () => {
    expect(id("what do you remember about the deploy")).toBe("memory.recall");
    expect(said("what do you remember about the deploy")).toBe("the deploy");
    // "about me" is the whole store, not a subject called "me".
    expect(id("what do you remember about me")).toBe("memory.list");
    expect(id("what do you know about me")).toBe("memory.list");
    expect(id("list my memories")).toBe("memory.list");
  });

  it("recognises forgetting a specific thing", () => {
    expect(id("forget about the dentist")).toBe("memory.forget");
    expect(said("forget what i told you about the Deploy Key")).toBe("the Deploy Key");
  });

  it("does not let remember swallow an app launch", () => {
    // `memory.remember` sits above `app.launch`; neither may take the other's
    // sentences.
    expect(id("open notepad")).toBe("app.launch");
    expect(id("remember that notepad is my editor")).toBe("memory.remember");
  });
});

describe("skills", () => {
  it("recognises asking what Jarvis can do", () => {
    expect(id("what can you do")).toBe("skills.list");
    expect(id("what are you capable of")).toBe("skills.list");
    expect(id("list your skills")).toBe("skills.list");
    expect(id("what skills do you have")).toBe("skills.list");
  });

  it("leaves a question about a particular ability to the agent", () => {
    expect(routeUtterance("can you write me a deployment script", APPS).route).toBe("agent");
    expect(routeUtterance("what can you do about the failing build", APPS).route).toBe("agent");
  });
});

describe("scheduled tasks", () => {
  it("recognises asking what is scheduled", () => {
    expect(id("what tasks do i have")).toBe("tasks.list");
    expect(id("what jobs do i have")).toBe("tasks.list");
    expect(id("what are my scheduled tasks")).toBe("tasks.list");
    expect(id("list my scheduled jobs")).toBe("tasks.list");
    expect(id("show me my tasks")).toBe("tasks.list");
    expect(id("list my cron jobs")).toBe("tasks.list");
    expect(id("do i have any reminders")).toBe("tasks.list");
    expect(id("what's coming up")).toBe("tasks.list");
  });

  it("recognises asking whether the scheduler is alive", () => {
    // The reason this rule is local at all. People ask this exactly when
    // something looks wrong, and the agent whose scheduler is the suspect is
    // the worst possible source of the answer — if the gateway is down, the
    // agent may not answer at all.
    expect(id("is the scheduler running")).toBe("tasks.list");
    expect(id("are my jobs going to run")).toBe("tasks.list");
    expect(id("will my tasks run")).toBe("tasks.list");
  });

  it("does not take a request to schedule something", () => {
    // There is deliberately no local create path: Hermes owns `cron/jobs.json`
    // and `lifecycle_guard.py` vets every new job. Stealing these utterances
    // would mean answering "what did you do with it?" with nothing.
    for (const s of [
      "schedule a task to email me every morning",
      "create a job that runs every friday",
      "remind me to call mum at 6",
      "set up an automation to back up my photos",
      "run my morning digest now",
    ]) {
      expect(routeUtterance(s, APPS).route, s).toBe("agent");
      expect(matchIntent(s, APPS).kind, s).toBe("none");
    }
  });

  it("does not take a request to change or explain one", () => {
    for (const s of [
      "cancel my 9am job",
      "delete the morning digest job",
      "pause my scheduled tasks until monday",
      "why did my backup job fail last night",
      "what tasks should i prioritise today",
    ]) {
      expect(routeUtterance(s, APPS).route, s).toBe("agent");
    }
  });
});

describe("mcp servers", () => {
  it("recognises asking what is configured", () => {
    expect(id("what mcp servers do i have")).toBe("mcp.list");
    expect(id("list my mcp servers")).toBe("mcp.list");
    expect(id("show me the mcp integrations")).toBe("mcp.list");
    expect(id("do i have any mcp servers configured")).toBe("mcp.list");
    expect(id("what's connected to hermes")).toBe("mcp.list");
  });

  it("hears the letters spoken separately, which is how people say it", () => {
    // Speech-to-text renders the acronym both ways depending on the speaker,
    // and a rule that only knows one spelling misses half the askers.
    expect(id("what m c p servers do i have")).toBe("mcp.list");
    expect(id("are my m c p servers connected")).toBe("mcp.list");
  });

  it("does not take a request to add, remove or enable one", () => {
    // Deliberate and load-bearing: an MCP entry is a command Hermes will spawn,
    // and `hermes_cli/mcp_security.py` exists because that has been attacked.
    // A local write path would be a second way to plant one, skipping the
    // validation `hermes mcp add` performs.
    for (const s of [
      "add an mcp server for github",
      "install the linear mcp server",
      "remove the mcp server called updater",
      "disable my github mcp server",
      "why is my mcp server not connecting",
      "set up an mcp server that runs bash",
    ]) {
      expect(routeUtterance(s, APPS).route, s).toBe("agent");
      expect(matchIntent(s, APPS).kind, s).toBe("none");
    }
  });
});
