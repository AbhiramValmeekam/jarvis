/**
 * Phase 5 gate: do the permission engine and undo actually work on this machine?
 *
 * The unit tests drive `ReversibleFs` through a fake `run`, which proves the
 * refusals and the bookkeeping but says nothing about whether the PowerShell is
 * correct — the Phase 4 probe found two defects of exactly that shape, both
 * invisible to a fake runner. So this runs the real scripts against real Windows.
 *
 * **What it does to your machine.** It creates a scratch folder under
 * `%LOCALAPPDATA%\Jarvis\probe`, writes files in it, sends one to the Recycle Bin
 * and restores it, then cleans up after itself. It touches nothing outside that
 * folder — every path goes through the same allow-list the runtime uses, and the
 * probe asserts that a path outside it is refused.
 *
 *   npx tsx scripts/probe-permissions.ts
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { PermissionEngine } from "../src/permissions/permission-engine.js";
import { ReversibleFs } from "../src/permissions/reversible-fs.js";
import { nodeRunner } from "../src/local-intents/executors.js";

const root = `${process.env["LOCALAPPDATA"] ?? process.env["TEMP"]}\\Jarvis\\probe`;
const results: { name: string; verdict: string; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, verdict: ok ? "PASS" : "FAIL", detail });
}

async function main(): Promise<void> {
  mkdirSync(root, { recursive: true });

  const fs = new ReversibleFs({
    run: nodeRunner,
    roots: [root],
    snapshotDir: `${root}\\.undo`,
  });

  // --- the Recycle Bin round trip, which is the part that cannot be faked ----

  const doomed = `${root}\\delete-me.txt`;
  writeFileSync(doomed, "jarvis probe: this file should come back\n", "utf8");

  try {
    const step = await fs.remove(doomed);
    check("delete goes to the Recycle Bin", !existsSync(doomed), step.description);

    await fs.undo(step.id);
    const back = existsSync(doomed);
    check(
      "undo restores it from the Recycle Bin",
      back,
      back ? "file is back where it was" : "file did not come back",
    );
  } catch (err) {
    check("Recycle Bin round trip", false, err instanceof Error ? err.message : String(err));
  }

  // --- overwrite is a delete of the old contents ----------------------------

  const edited = `${root}\\notes.md`;
  writeFileSync(edited, "original\n", "utf8");
  try {
    const snap = fs.snapshot(edited);
    writeFileSync(edited, "clobbered\n", "utf8");
    await fs.undo(snap.id);
    const restored = readFileSync(edited, "utf8").trim();
    check("undo restores an overwritten file", restored === "original", `contents: ${restored}`);
  } catch (err) {
    check("undo restores an overwritten file", false, err instanceof Error ? err.message : String(err));
  }

  // --- the allow-list holds on a real filesystem ----------------------------

  try {
    await fs.remove("C:\\Windows\\System32\\drivers\\etc\\hosts");
    check("refuses a path outside the allow-list", false, "it did not refuse");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check("refuses a path outside the allow-list", /refusing to use/.test(msg), msg.slice(0, 70));
  }

  // --- §61 forbidden ground, through the real engine ------------------------

  let askedFor = 0;
  const engine = new PermissionEngine({
    ask: async () => {
      askedFor += 1;
      return "allow_always";
    },
  });

  const forbidden = [
    "Set-MpPreference -DisableRealtimeMonitoring $true",
    "netsh advfirewall set allprofiles state off",
    "vssadmin delete shadows /all /quiet",
  ];
  for (const command of forbidden) {
    const d = await engine.evaluate({ tool: "run_command", args: { command } });
    check(
      `refuses: ${command.slice(0, 38)}`,
      d.verdict === "deny" && d.classification.forbidden,
      d.reason,
    );
  }
  check("never put a forbidden action to the user", askedFor === 0, `asked ${askedFor} times`);

  // A real read still runs without asking, or the whole thing is unusable.
  const readDecision = await engine.evaluate({
    tool: "read_file",
    args: { path: `${root}\\notes.md` },
  });
  check(
    "an ordinary read runs without asking",
    readDecision.verdict === "allow" && askedFor === 0,
    readDecision.reason,
  );

  // A grant for a single command must not cover a chained one.
  await engine.evaluate({ tool: "run_command", args: { command: "git status" } });
  const before = askedFor;
  await engine.evaluate({ tool: "run_command", args: { command: "git status && rm -rf ." } });
  check(
    "a grant does not stretch to a riskier call",
    askedFor === before + 1,
    `asked again: ${askedFor > before}`,
  );

  check(
    "every decision reached the audit log",
    engine.audit.length === forbidden.length + 3,
    `${engine.audit.length} entries`,
  );

  // --- report ---------------------------------------------------------------

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`${r.verdict.padEnd(5)} ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = results.filter((r) => r.verdict === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} passed`);

  // Clean up the scratch folder. Real delete here, not the Recycle Bin: this is
  // the probe's own temp directory, not a personal file.
  rmSync(root, { recursive: true, force: true });

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
