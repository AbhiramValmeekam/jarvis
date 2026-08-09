/**
 * Phase 4 gate: do the local commands actually work on this machine?
 *
 * The unit tests drive the executors through a fake `run`, which proves the
 * routing and the failure handling but says nothing about whether the PowerShell
 * is correct — a script that throws on a real machine passes every one of them.
 * This runs the real thing against the real Windows, with no Hermes process and
 * no network call anywhere in the path.
 *
 * **What it will not do to your machine.** Locking the session and launching an
 * application are both disruptive and both are skipped unless `--all` is passed;
 * they are reported as SKIPPED rather than quietly counted as passes. Everything
 * else is either read-only or restored: the speaker level and mute state are
 * read first and put back afterwards, whatever the outcome.
 *
 *   npx tsx scripts/probe-local.ts          # safe subset
 *   npx tsx scripts/probe-local.ts --all    # also locks the screen and opens an app
 */
import { LocalIntentEngine } from "../src/local-intents/engine.js";
import {
  nodeRunner,
  nodeLauncher,
  defaultScreenshotRoots,
  audioEndpoint,
} from "../src/local-intents/executors.js";
import { defaultStartMenuRoots } from "../src/system/app-catalog.js";
import { readdirSync } from "node:fs";

const all = process.argv.includes("--all");

let micMuted = false;
const engine = new LocalIntentEngine(
  {
    run: nodeRunner,
    launch: nodeLauncher,
    screenshotRoots: defaultScreenshotRoots(),
    now: () => new Date(),
    setMicMuted: (m) => {
      micMuted = m;
      return true;
    },
    isMicMuted: () => micMuted,
  },
  {
    catalog: {
      startMenuRoots: defaultStartMenuRoots(),
      readDir: (d: string): readonly string[] => readdirSync(d),
    },
  },
);

const results: { utterance: string; verdict: string; detail: string }[] = [];

async function probe(utterance: string): Promise<void> {
  const started = Date.now();
  const d = await engine.handle(utterance);
  const ms = Date.now() - started;

  if (d.route === "agent") {
    results.push({ utterance, verdict: "ROUTED-TO-AGENT", detail: d.reason ?? "" });
    return;
  }
  if (d.route === "ask") {
    results.push({ utterance, verdict: "ASKED", detail: d.question ?? "" });
    return;
  }
  results.push({
    utterance,
    verdict: d.outcome?.ok ? `PASS ${ms}ms` : `FAIL ${ms}ms`,
    detail: d.outcome?.speech ?? "",
  });
}

function skip(utterance: string, why: string): void {
  results.push({ utterance, verdict: "SKIPPED", detail: why });
}

async function main(): Promise<void> {
  console.log(`Local intents against real Windows. Hermes is not running.\n`);
  console.log(`Catalog: ${engine.catalog.length} apps discovered\n`);

  // Read-only.
  await probe("what time is it");
  await probe("what's the date");
  await probe("how much battery do i have");
  await probe("cpu usage");

  // Reversible: capture the real state first, and put it back in `finally` so a
  // crash midway through still leaves the speakers where it found them.
  const before = await audioEndpoint(nodeRunner, "get").catch(() => null);
  console.log(
    before
      ? `Speakers are at ${before.level}%${before.muted ? ", muted" : ""} — restored at the end.\n`
      : `Could not read the speaker state; volume probes will still run.\n`,
  );

  try {
    await probe("set the volume to 40");
    await probe("volume up by 5");
    await probe("mute the speakers");
    await probe("unmute the speakers");
  } finally {
    if (before) {
      await audioEndpoint(nodeRunner, "set", before.level).catch(() => null);
      if (before.muted) await audioEndpoint(nodeRunner, "mute").catch(() => null);
    }
  }

  // Runtime state only; no Windows device is touched.
  await probe("mute the microphone");
  await probe("unmute the microphone");

  // Writes one PNG into the allow-listed folder.
  await probe("take a screenshot");

  // Proof that the guard is live, not just unit-tested.
  await probe("open the pod bay doors");
  await probe("summarise my unread email");
  await probe("mute");

  if (all) {
    await probe("open notepad");
    await probe("lock the computer");
  } else {
    skip("open notepad", "would open a window; pass --all");
    skip("lock the computer", "would lock your session; pass --all");
  }

  const width = Math.max(...results.map((r) => r.utterance.length));
  for (const r of results) {
    const mark =
      r.verdict.startsWith("PASS")
        ? "✓"
        : r.verdict.startsWith("FAIL")
          ? "✗"
          : "·";
    console.log(`${mark} ${r.utterance.padEnd(width)}  ${r.verdict.padEnd(16)} ${r.detail}`);
  }

  const failed = results.filter((r) => r.verdict.startsWith("FAIL"));
  const passed = results.filter((r) => r.verdict.startsWith("PASS"));
  console.log(`\n${passed.length} passed, ${failed.length} failed, ` +
    `${results.filter((r) => r.verdict === "SKIPPED").length} skipped`);
  if (failed.length) process.exitCode = 1;
}

void main();
