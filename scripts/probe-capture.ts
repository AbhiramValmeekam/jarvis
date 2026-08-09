/**
 * Does the screenshot PowerShell actually work on this machine?
 *
 * The one part of Phase 6 that `probe:context` deliberately does not run. That
 * script proves the *policy* — who is asked, what they are told, what is
 * refused — with the display stubbed, because demonstrating consent by
 * photographing the desktop of whoever runs it would be an odd way round. This
 * script is the other half: the PowerShell, the base64 round-trip, the decode.
 *
 * **What it does to your machine.** It takes exactly one screenshot of your
 * whole desktop, in memory, and tells you how big it was. Nothing is written to
 * disk, nothing is sent anywhere, and the image is never printed — only its size
 * and dimensions. Nothing is captured until you say yes at the prompt below.
 *
 * Separate from `probe:context` and not part of `npm run verify` for that
 * reason: a gate that photographs the screen is not something to run by
 * accident. Every other check here is offline and runs first, so a failure in
 * the script's shape is reported before you are asked anything.
 *
 *   npx tsx scripts/probe-capture.ts
 *   npx tsx scripts/probe-capture.ts --yes   (skip the prompt, for a headless run)
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  CAPTURE_SCRIPT,
  CAPTURE_MAX_WIDTH,
  decodePng,
  windowsCapturePng,
} from "../src/context/capture-png.js";
import { nodeRunner, encodePwsh } from "../src/local-intents/executors.js";

const results: { name: string; verdict: string; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, verdict: ok ? "PASS" : "FAIL", detail });
}

/** Width and height from the PNG's IHDR, which is always the first chunk. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function main(): Promise<void> {
  // --- offline first, so a broken script fails before anyone is prompted ----

  check(
    "the capture script takes no interpolated input",
    !/\$\{/.test(CAPTURE_SCRIPT),
    "the only variable is read from the environment, as data",
  );
  check(
    "the width cap is validated inside PowerShell",
    CAPTURE_SCRIPT.includes("match '^[0-9]+$'"),
    "an environment variable is still untrusted input",
  );
  check(
    "the script writes no file",
    !/Out-File|Set-Content|\.Save\(\s*['"]/.test(CAPTURE_SCRIPT),
    "a PNG of the desktop must not be left in %TEMP%",
  );

  for (const [name, bad] of [
    ["empty output", ""],
    ["an error message", "Cannot find drive"],
    ["CLIXML on stdout", "#< CLIXML\r\n<Objs Version=\"1.1.0.1\">"],
  ] as const) {
    let threw = false;
    try {
      decodePng(bad);
    } catch {
      threw = true;
    }
    check(`${name} is rejected, not decoded into garbage`, threw);
  }

  // --- the real thing, only with permission --------------------------------

  if (!process.argv.includes("--yes")) {
    console.log(
      "\nThis will take ONE screenshot of your entire desktop, in memory.\n" +
        "It is not saved, not printed, and not sent anywhere — only its size is shown.\n" +
        "Close anything you would not want a screenshot of first.\n",
    );
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = (await rl.question("Take one screenshot now? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log("\nNothing captured. The offline checks above still ran:\n");
      return report();
    }
  }

  const capture = windowsCapturePng({ run: nodeRunner, encode: encodePwsh });
  const t0 = Date.now();
  let bytes: Uint8Array;
  try {
    bytes = await capture();
  } catch (err) {
    check("captures the screen", false, err instanceof Error ? err.message : String(err));
    return report();
  }
  const elapsed = Date.now() - t0;

  check("captures the screen", true, `${bytes.byteLength} bytes in ${elapsed} ms`);
  check(
    "the bytes really are a PNG",
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
  );

  const { width, height } = pngSize(bytes);
  check(
    "the image has real dimensions",
    width > 0 && height > 0,
    `${width}×${height}`,
  );
  check(
    "the width cap is honoured",
    width <= CAPTURE_MAX_WIDTH,
    `${width} ≤ ${CAPTURE_MAX_WIDTH}`,
  );
  // A blank or single-colour capture compresses to almost nothing. That is the
  // shape of a screenshot taken on a locked or virtual desktop — technically a
  // success, and useless to a vision model.
  check(
    "the image has content, not a blank desktop",
    bytes.byteLength > 10_000,
    `${(bytes.byteLength / 1024).toFixed(0)} KiB`,
  );
  check(
    "a screenshot arrives fast enough to be worth waiting for",
    elapsed < 10_000,
    `${elapsed} ms`,
  );

  report();
}

function report(): void {
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`${r.verdict.padEnd(5)} ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = results.filter((r) => r.verdict === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
