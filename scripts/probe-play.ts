/**
 * Does "play <song> on youtube" reach the right video?
 *
 * Deliberately not part of `probe-local.ts`: that file promises no network call
 * anywhere in its path, and this one makes a real request to `www.youtube.com`.
 * `media.play` is the only local intent that reaches the internet, and what it
 * depends on is someone else's markup — so the unit tests, which read a results
 * page captured on 2026-08-23, will keep passing on the day the real page stops
 * looking like that. This is the check that notices.
 *
 * Nothing opens unless `--open` is passed. The launch is recorded and printed
 * instead, so the resolved URL can be read without a browser tab arriving on the
 * user's screen; with `--open`, only the first one is actually launched.
 *
 *   npx tsx scripts/probe-play.ts                 # route + resolve; nothing opens
 *   npx tsx scripts/probe-play.ts --open          # also opens the first result
 *   npx tsx scripts/probe-play.ts "shape of you"  # ask for something specific
 */
import { readdirSync } from "node:fs";
import { LocalIntentEngine } from "../src/local-intents/engine.js";
import {
  nodeRunner,
  nodeLauncher,
  defaultScreenshotRoots,
} from "../src/local-intents/executors.js";
import { findYouTubeVideo } from "../src/tools/net/youtube-search.js";
import { defaultStartMenuRoots } from "../src/system/app-catalog.js";

const open = process.argv.includes("--open");
const asked = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const launched: { file: string; args: readonly string[] }[] = [];
let opened = false;
let micMuted = false;

const engine = new LocalIntentEngine(
  {
    run: nodeRunner,
    /** Recorded rather than performed, so the resolved target can be inspected. */
    launch: async (file, args) => {
      launched.push({ file, args });
      if (open && !opened) {
        opened = true;
        await nodeLauncher(file, args);
      }
    },
    screenshotRoots: defaultScreenshotRoots(),
    now: () => new Date(),
    setMicMuted: (m) => {
      micMuted = m;
      return true;
    },
    isMicMuted: () => micMuted,
    // The real lookup against the real page. Everything else in this file exists
    // to put a plausible utterance in front of it.
    findTrack: (query) => findYouTubeVideo(query, { log: (line) => console.log(`    ${line}`) }),
  },
  {
    catalog: {
      startMenuRoots: defaultStartMenuRoots(),
      readDir: (d: string): readonly string[] => readdirSync(d),
    },
  },
);

/** Run one utterance the whole way through, and say what came out. */
async function play(utterance: string): Promise<boolean> {
  const before = launched.length;
  const started = Date.now();
  const d = await engine.handle(utterance);
  const ms = Date.now() - started;

  if (d.route !== "local") {
    console.log(`✗ "${utterance}"\n    ${d.route}: ${d.reason ?? d.question ?? ""}`);
    return false;
  }
  const target = launched[before]?.args[0] ?? "(nothing launched)";
  const watched = target.startsWith("https://www.youtube.com/watch?v=");
  console.log(
    `${d.outcome?.ok && watched ? "✓" : "·"} "${utterance}"  ${ms}ms\n` +
      `    ${d.intent} → ${target}\n` +
      `    said: ${d.outcome?.speech ?? "(nothing)"}`,
  );
  // A search page is a pass for the intent and a failure for this probe: the
  // fallback working is what the unit tests cover, and what cannot be checked
  // without the network is whether the page still yields an id.
  if (!watched) console.log(`    fell back to search — the page did not yield a video id`);
  return Boolean(d.outcome?.ok) && watched;
}

/** Where an utterance goes, without letting it happen. */
async function routesTo(utterance: string, expected: string): Promise<boolean> {
  const d = await engine.handle(utterance);
  const got = d.route === "local" ? d.intent : d.route;
  console.log(`${got === expected ? "✓" : "✗"} "${utterance}" → ${got}` +
    (got === expected ? "" : ` (expected ${expected})`));
  return got === expected;
}

async function main(): Promise<void> {
  console.log(`media.play against the real YouTube. Hermes is not running.\n`);
  console.log(`Resolving:`);

  const results: boolean[] = [];
  // The utterance that came back as a red "internal error" banner from inside
  // Hermes' own ACP adapter, typed exactly as it was typed then.
  results.push(await play("play sorry by justin beiber on yotuube"));
  results.push(await play("youtube play bohemian rhapsody"));
  for (const q of asked) results.push(await play(`play ${q} on youtube`));

  // Routing only, and no network: these must not become a YouTube search.
  console.log(`\nStaying with the agent:`);
  results.push(await routesTo("play chess", "agent"));
  results.push(await routesTo("play something on youtube", "agent"));
  results.push(await routesTo("play my playlist in spotify", "agent"));
  results.push(await routesTo("open youtube", "web.open"));

  const failed = results.filter((r) => !r).length;
  console.log(
    `\n${results.length - failed} passed, ${failed} failed. ` +
      (open
        ? opened
          ? `Opened ${launched[0]?.args[0]}.`
          : `Nothing was launched.`
        : `Nothing was opened; pass --open to play the first one.`),
  );
  if (failed) process.exitCode = 1;
}

void main();
