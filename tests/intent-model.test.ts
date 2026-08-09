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
