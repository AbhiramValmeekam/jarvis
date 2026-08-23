/**
 * Which coding platforms are on *this* machine, and what could reach each one.
 *
 * The unit tests decide what is installed, because that is the only way to test
 * discovery at all. This is the check that the answers are true here — and it is
 * the check that would have caught the mistake this feature was built around.
 * Antigravity IDE 1.107.0 advertises a `chat` subcommand inherited from VS Code
 * and exits 0 when you run it; the prompt goes nowhere, because the fork replaced
 * VS Code's chat stack with its own panel and the renderer logs
 * `command 'workbench.action.chat.newChat' not found`. An exit code was never
 * going to notice that. A person reading this output will.
 *
 * Nothing is spawned unless `--open` is passed. Every invocation is resolved and
 * printed instead, so the argv that *would* run can be read without an editor
 * window arriving on the user's screen. With `--open`, one handoff is staged for
 * real: a task note is written, the clipboard is set, and the editor opens.
 *
 *   npx tsx scripts/probe-coding-platforms.ts              # resolve only
 *   npx tsx scripts/probe-coding-platforms.ts --open       # stage one real handoff
 *   npx tsx scripts/probe-coding-platforms.ts --open cursor
 */
import { dirname } from "node:path";
import { discoverPlatforms, findPlatform } from "../src/coding/platforms.js";
import { openInvocation, promptInvocation } from "../src/coding/platform-invoke.js";
import { stageHandoff } from "../src/coding/handoff.js";
import { nodeLauncher } from "../src/local-intents/executors.js";
import { nodeProcessRunner } from "../src/tools/process-run.js";
import { configFilePath } from "../src/context/config.js";

const open = process.argv.includes("--open");
const named = process.argv.slice(2).filter((a) => !a.startsWith("--"))[0];

/** A short, readable argv. Quoted only where a space would mislead. */
const argv = (file: string, args: readonly string[]): string =>
  [file, ...args].map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");

const TASK = "make a small html page that says hello, and open it in the browser";

async function main(): Promise<number> {
  const installed = discoverPlatforms();
  console.log(`discovered ${installed.length} of 6 known platforms\n`);
  if (installed.length === 0) {
    console.log("nothing installed — `delegate_coding_task` would report that and stop");
    return 1;
  }

  for (const p of installed) {
    const channel = p.spec.channel === "headless" ? "accepts a task" : "opens only";
    console.log(`${p.spec.label}  [${channel}]`);
    console.log(`  found      ${p.command}  (via ${p.foundVia}${p.needsShell ? ", batch shim" : ""})`);
    console.log(`  checked    ${p.spec.checkedOn ?? "never"}`);

    const opener = openInvocation(p, process.cwd());
    console.log(`  open       ${opener === null ? "— no spawnable binary" : argv(opener.file, opener.args)}`);

    const prompt = promptInvocation(p, TASK);
    if ("refused" in prompt) {
      console.log(`  prompt     — refused: ${prompt.refused}`);
    } else {
      const env = Object.entries(prompt.env)
        .map(([k, v]) => `${k}=${v === "" ? "(empty)" : v}`)
        .join(" ");
      console.log(`  prompt     ${argv(prompt.file, prompt.args)}`);
      if (env) console.log(`  env        ${env}`);
    }
    console.log(`  note       ${p.spec.note}`);
    console.log("");
  }

  const direct = installed.filter((p) => p.spec.channel === "headless");
  console.log(
    direct.length === 0
      ? "no platform here can be given a task directly — every route is a staged handoff"
      : `can be given a task directly: ${direct.map((p) => p.spec.label).join(", ")}`,
  );

  if (!open) {
    console.log("\n(nothing was spawned; pass --open to stage one real handoff)");
    return 0;
  }

  const target = named ? findPlatform(named, installed) : (installed.find((p) => p.spec.channel === "handoff") ?? null);
  if (target === null) {
    console.log(`\n--open: no installed platform answers to "${named ?? "a handoff platform"}"`);
    return 1;
  }
  console.log(`\nstaging a real handoff to ${target.spec.label} …`);
  const staged = await stageHandoff(target, process.cwd(), TASK, {
    dataDir: dirname(configFilePath()),
    launch: nodeLauncher,
    run: nodeProcessRunner,
    log: (line) => console.log(`  ${line}`),
  });
  console.log(`  note       ${staged.taskFile}`);
  console.log(`  prompt     ${staged.promptFile}`);
  console.log(`  clipboard  ${staged.copied ? "holds the task, and nothing around it" : "not set"}`);
  console.log(`  editor     ${staged.opened ? "opened" : `did not open — ${staged.problem ?? "unknown"}`}`);
  console.log(
    staged.opened
      ? "\nthe outstanding action is a paste, which is what the tool reports as `unconfirmed`"
      : "\nthe task is written down even though the editor did not open",
  );
  return staged.opened ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
