import { describe, it, expect } from "vitest";
import {
  matchIntent,
  routeUtterance,
  normalise,
  LOCAL_THRESHOLD,
  WEB_SITES,
  YOUTUBE_SEARCH_PREFIX,
  youtubeSearchUrl,
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

describe("opening a website", () => {
  const url = (text: string, ctx: IntentContext = APPS): string | undefined => {
    const r = matchIntent(text, ctx);
    return r.kind === "match" ? r.slots.url : undefined;
  };

  it("answers §63's example locally instead of asking Hermes", () => {
    // The bug this exists for: "open youtube" reached the agent and came back
    // as a red "internal error" banner. §74 — the agent is for what the machine
    // cannot do itself, and one call to the shell is not that.
    expect(id("open youtube")).toBe("web.open");
    expect(url("open youtube")).toBe("https://www.youtube.com/");
    expect(routeUtterance("open youtube", APPS).route).toBe("local");
  });

  it("only ever produces an https url from the fixed table", () => {
    // Checked over every row rather than a sample: the executor hands this
    // straight to the shell, so one bad row is one bad destination.
    //
    // Empty catalog on purpose — an installed app of the same name is *meant*
    // to win (see below), and `APPS` has a Spotify, so reaching every row means
    // taking the installed-app rule out of the way first.
    for (const [name, target] of WEB_SITES) {
      expect(target.startsWith("https://"), name).toBe(true);
      expect(url(`open ${name}`, {}), name).toBe(target);
    }
  });

  it("loses to an installed app of the same name", () => {
    // The precedence claim in the rule's comment. `APPS` has a Spotify desktop
    // app, so "open spotify" must start it rather than open the web player —
    // even though `spotify` is also a row in the site table.
    expect(id("open spotify")).toBe("app.launch");
    expect(matchIntent("open spotify", APPS)).toMatchObject({ slots: { app: "spotify" } });
    // …and with nothing installed, the same words reach the website.
    expect(id("open spotify", {})).toBe("web.open");
    expect(url("open spotify", {})).toBe("https://open.spotify.com/");
  });

  it("beats a project that happens to share the name", () => {
    // A directory called `youtube` must not take over a word that means a
    // website to everyone who says it.
    const ctx: IntentContext = {
      projects: new Map<string, readonly string[]>([["youtube", ["youtube"]]]),
    };
    expect(id("open youtube", ctx)).toBe("web.open");
    // The escape hatch is the qualified form, which runs before either rule.
    const r = matchIntent("open the youtube project", ctx);
    expect(r.kind === "match" && r.id).toBe("project.open");
  });

  it("survives the ways a person actually says a domain", () => {
    // `normalise` strips punctuation, so a spoken or dictated "youtube.com"
    // arrives as "youtube com" — the noise pattern has to match spoken TLDs or
    // saying the domain aloud is the one phrasing that fails.
    for (const s of [
      "open youtube.com",
      "open youtube com",
      "go to the youtube website",
      "pull up youtube",
      "bring up the youtube page",
      "open up youtube",
      "open the youtube dot com website",
      "show me youtube in the browser",
    ]) {
      expect(url(s), s).toBe("https://www.youtube.com/");
    }
    expect(url("open gmail")).toBe("https://mail.google.com/");
    expect(url("go to stack overflow")).toBe("https://stackoverflow.com/");
  });

  it("sends a name it does not know to the agent, not to a guessed url", () => {
    // "Open the Netflix show I started last night" is web-shaped, matches no
    // row, and is actually answerable by Hermes. A guessed URL would be worse
    // than not firing.
    expect(id("open hacker news", {})).toBeNull();
    expect(routeUtterance("open hacker news", {}).route).toBe("agent");
    expect(url("open the netflix show i started last night", {})).toBeUndefined();
  });

  it("never lets the utterance choose the destination", () => {
    // The slot is built from the table, so nothing web-shaped in the words can
    // become a url. Anything else reaching the executor is refused there too.
    for (const s of [
      "open evil.example.com",
      "go to http://example.com",
      "open file:///c:/windows",
      "open youtube.evil.com",
    ]) {
      expect(url(s, {}), s).toBeUndefined();
    }
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
      // §66's own sentence, which named no screen at all and so used to fall
      // through to the agent with no pixels attached.
      "look at this and tell me what's wrong",
    ]) {
      expect(id(s), s).toBe("screen.read");
    }
  });

  it("does not photograph the desktop when a different object was named", () => {
    // "look at this X" points at something specific; only a bare "this" — or an
    // explicit "screen" — means the desktop. The trailing clause is allowed
    // after "this", not in place of it.
    for (const s of [
      "look at this file in the editor",
      "look at this pull request and tell me what's wrong",
    ]) {
      expect(id(s), s).not.toBe("screen.read");
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

describe("playing a song on YouTube", () => {
  const q = (text: string, ctx: IntentContext = APPS): string | undefined => {
    const r = matchIntent(text, ctx);
    return r.kind === "match" ? r.slots.query : undefined;
  };

  it("answers the utterance that was typed at the HUD and failed", () => {
    // Verbatim, misspelling included: this reached Hermes, which called
    // `browser_exec` and then died inside its own ACP adapter, and the user got a
    // red banner instead of music.
    expect(id("play sorry by justin beiber on yotuube")).toBe("media.play");
    expect(q("play sorry by justin beiber on yotuube")).toBe("sorry by justin beiber");
    expect(routeUtterance("play sorry by justin beiber on yotuube", APPS).route).toBe("local");
  });

  it("builds a youtube search url and nothing else", () => {
    const r = matchIntent("play shape of you on youtube", APPS);
    expect(r.kind === "match" && r.slots.url).toBe(
      "https://www.youtube.com/results?search_query=shape%20of%20you",
    );
  });

  it("percent-encodes what was said instead of splicing it into a url", () => {
    // The security property: the origin is a literal in the model and the
    // utterance can only ever become one encoded query component. A separator
    // survives as an escape, never as a separator.
    const r = matchIntent("play x & y ? z on youtube", APPS);
    const url = r.kind === "match" ? (r.slots.url ?? "") : "";
    expect(url.startsWith(YOUTUBE_SEARCH_PREFIX)).toBe(true);
    // `normalise` has already turned the punctuation into spaces, so what has to
    // be checked is that nothing after the prefix can start a new parameter.
    expect(url.slice(YOUTUBE_SEARCH_PREFIX.length)).not.toMatch(/[&?#/]/);
    expect(youtubeSearchUrl("a & b")).toBe(
      "https://www.youtube.com/results?search_query=a%20%26%20b",
    );
  });

  it("survives the ways a person names the site", () => {
    for (const s of [
      "play kesariya on youtube",
      "play kesariya on you tube",
      "play kesariya on yt",
      "play kesariya on youtube music",
      "play kesariya on youtube com",
      "play kesariya on utube",
      "play kesariya on yotube",
      "youtube play kesariya",
      "on youtube play kesariya",
      "youtube and play kesariya",
    ]) {
      expect(id(s), s).toBe("media.play");
      expect(q(s), s).toBe("kesariya");
    }
  });

  it("keeps the title and drops the scaffolding around it", () => {
    expect(q("play me the song sorry on youtube")).toBe("sorry");
    expect(q("play the track bohemian rhapsody on youtube")).toBe("bohemian rhapsody");
    expect(q("play bohemian rhapsody video on youtube")).toBe("bohemian rhapsody");
    expect(q("put on despacito on youtube")).toBe("despacito");
    expect(q("stream shape of you on youtube")).toBe("shape of you");
    // Politeness is gone before any rule sees it — `normalise` strips it.
    expect(q("play sorry on youtube for me")).toBe("sorry");
  });

  it("leaves 'play' alone when YouTube was not named", () => {
    // The whole safety argument for claiming a verb this common. Each of these is
    // a sentence the agent should keep.
    for (const s of [
      "play chess",
      "play the game",
      "play it again",
      "play some music",
      "play my playlist in spotify",
      "start playing the next episode",
    ]) {
      expect(id(s), s).toBe(null);
      expect(routeUtterance(s, APPS).route, s).toBe("agent");
    }
  });

  it("hands over a play request that names no song", () => {
    // Play-shaped, but a results page for the literal word "something" is a worse
    // answer than the agent's, so the slot refuses and the utterance falls through.
    for (const s of [
      "play something on youtube",
      "play anything on youtube",
      "play music on youtube",
      "play it on youtube",
    ]) {
      expect(id(s), s).toBe(null);
      expect(routeUtterance(s, APPS).route, s).toBe("agent");
    }
  });

  it("does not take an utterance about opening the site itself", () => {
    expect(id("open youtube")).toBe("web.open");
    expect(id("go to youtube")).toBe("web.open");
  });
});

describe("coding delegation", () => {
  const PROJECTS: IntentContext = {
    ...APPS,
    projects: new Map<string, readonly string[]>([
      ["jarvis", ["jarvis"]],
      ["portfolio", ["portfolio", "my portfolio"]],
    ]),
  };

  const task = (text: string, ctx: IntentContext = APPS) => {
    const r = matchIntent(text, ctx);
    return r.kind === "match" ? r.slots.codingTask ?? null : null;
  };

  const proj = (text: string, ctx: IntentContext = PROJECTS) => {
    const r = matchIntent(text, ctx);
    return r.kind === "match" ? r.slots.project ?? null : null;
  };

  it("recognises build-shaped utterances", () => {
    for (const s of [
      "build me a website about dogs",
      "make a project about weather",
      "create a react app",
      "code me a to-do list",
      "code a python script to download videos",
      "develop a portfolio website",
      "scaffold a node.js api",
      "generate a landing page",
    ]) {
      expect(id(s), s).toBe("coding.delegate");
    }
  });

  it("extracts the task from the utterance", () => {
    expect(task("build me a website about dogs")).toBe("website about dogs");
    expect(task("create a react app")).toBe("react app");
    expect(task("code a python script to download videos")).toBe(
      "python script to download videos",
    );
  });

  it("extracts an optional project when named", () => {
    expect(proj("build a landing page in my portfolio project")).toBe("portfolio");
    expect(proj("create a navbar in the jarvis project")).toBe("jarvis");
  });

  it("does not set a project when none is named", () => {
    expect(proj("build me a website about dogs")).toBeNull();
    expect(proj("create a react app")).toBeNull();
  });

  it("matches the project-first form", () => {
    expect(id("in my portfolio project build a landing page", PROJECTS)).toBe("coding.delegate");
    const r = matchIntent("in my portfolio project build a landing page", PROJECTS);
    expect(r.kind === "match" && r.slots.codingTask).toBe("landing page");
    expect(r.kind === "match" && r.slots.project).toBe("portfolio");
  });

  it("does not steal make a note from memory", () => {
    expect(id("make a note that the dentist is on tuesday")).toBe("memory.remember");
    expect(id("remember that sarah's flight is on the 14th")).toBe("memory.remember");
  });

  it("does not steal app launches", () => {
    expect(id("open notepad")).toBe("app.launch");
    expect(id("launch chrome")).toBe("app.launch");
  });

  it("leaves diagnostic and refactoring requests to the agent", () => {
    for (const s of [
      "look at this code and fix the bug",
      "what's wrong with my build",
      "refactor the database module",
      "explain how the router works",
      "debug the login page",
    ]) {
      expect(routeUtterance(s, APPS).route, s).toBe("agent");
    }
  });

  it("rejects a task that is just an app name from the catalog", () => {
    // "make me notepad" should not be a coding request — it matches an installed app.
    expect(id("make me notepad")).not.toBe("coding.delegate");
  });

  it("survives politeness and the wake word", () => {
    expect(id("Jarvis, please build me a simple website")).toBe("coding.delegate");
    expect(id("Hey Jarvis, could you create a react dashboard for me")).toBe("coding.delegate");
  });
});
