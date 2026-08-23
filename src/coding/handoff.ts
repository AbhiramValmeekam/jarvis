/**
 * Handing a task to an editor that has no way to be told one.
 *
 * `platform-invoke.ts` answers "can this platform be given a prompt". For
 * Antigravity the answer is no, and this file is what happens then. It is the
 * honest version of the thing Jarvis previously had to apologise for: asked to
 * open Antigravity and tell it to build a page, it could do the first half and
 * nothing else, and said so.
 *
 * Three steps, in this order, and the order is the useful part:
 *
 *  1. **The task is written down**, to a file under Jarvis' own data directory.
 *     Not into the project — a task note is not a change to someone's
 *     repository, and a file that appears in `git status` because an assistant
 *     was asked a question is a small betrayal of §43.
 *  2. **It is put on the clipboard** — the task by itself, not the note. The
 *     remaining human action is one paste and not a re-typing of what was
 *     already said out loud, and what lands in the agent panel has to be the
 *     instruction and nothing around it: a pasted "Paste this into the agent
 *     panel:" is a line an agent will answer instead of act on. So the task is
 *     written twice, and the second copy exists only to be pasted.
 *  3. **The editor is opened on the project, with that file as a second
 *     argument**, so the task is visible on screen next to the code it is about
 *     even if the clipboard has since been used for something else.
 *
 * What is *not* here is a fourth step that sends the paste itself. The reason is
 * in `platforms.ts` and it is worth repeating where the code would go: nothing
 * outside the editor can establish that the caret is in an agent panel rather
 * than in a source file, so a synthesised `Ctrl+V` is a capability whose failure
 * mode is silently editing a file the user did not name. `verified-action.ts`
 * refuses to let an actor grade its own work; this refuses to act where no
 * grading is possible at all.
 *
 * ## The clipboard call, and why it looks the way it does
 *
 * The command string handed to PowerShell is a constant in this file. The one
 * value that varies — the path of the file to read — travels in the environment
 * and is read back as `$env:JARVIS_HANDOFF_FILE`, so it is never part of a
 * command line and never re-parsed. That is the same property
 * `youtube-search.ts` keeps for a URL: exactly one variable component, and it
 * goes through a channel that cannot be confused for syntax. Checked with a task
 * containing `&`, `|` and `>`, which arrived on the clipboard unaltered.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openInvocation, type InvokeDeps } from "./platform-invoke.js";
import type { InstalledPlatform } from "./platforms.js";
import type { ProcessRunner } from "../tools/process-run.js";

/** How far the handoff got. Every field is something that was observed. */
export interface HandoffResult {
  /** The note that opens as a tab: the task with the context around it. */
  readonly taskFile: string;
  /** The task alone, which is what the clipboard reads. Written beside the note. */
  readonly promptFile: string;
  /** True when the clipboard really holds the task. False is reported, not hidden. */
  readonly copied: boolean;
  /** True when the editor process was confirmed started. */
  readonly opened: boolean;
  /** Why a step did not happen, when one did not. */
  readonly problem?: string;
}

export interface HandoffDeps extends InvokeDeps {
  /** Where the task note goes. A directory Jarvis owns, not the project. */
  readonly dataDir: string;
  /** Detached start, so the editor outlives the runtime. `nodeLauncher` shape. */
  readonly launch: (file: string, args: readonly string[]) => Promise<void>;
  /** Used only for the clipboard, and only with the constant command below. */
  readonly run?: ProcessRunner;
  readonly platform?: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/**
 * The clipboard command, in full, as a constant.
 *
 * `-NoProfile` so a user's profile script cannot change what this means, and
 * `-NonInteractive` so a prompt inside it fails instead of hanging a runtime that
 * has nobody at a keyboard. `Get-Content -Raw` keeps the newlines a multi-line
 * task has; `-LiteralPath` stops a `[` in a path from being read as a wildcard.
 */
const CLIPBOARD_SCRIPT =
  "Set-Clipboard -Value (Get-Content -Raw -LiteralPath $env:JARVIS_HANDOFF_FILE)";

/** The environment variable the script above reads. Nothing else uses it. */
const HANDOFF_ENV = "JARVIS_HANDOFF_FILE";

/** A task note, as a person would want to find it a week later. */
function note(task: string, dir: string, platform: string, when: number): string {
  return [
    `# Task for ${platform}`,
    "",
    `Prepared by Jarvis at ${new Date(when).toISOString()}.`,
    `Project: ${dir}`,
    "",
    "Paste this into the agent panel:",
    "",
    task,
    "",
  ].join("\n");
}

/**
 * Prepare a task for a platform that cannot be told one, and open it.
 *
 * Never throws for a step that failed: each of the three either happened or is
 * reported as not having happened, because the caller's sentence to the user
 * differs in each case and "handoff failed" is not one of the sentences worth
 * saying. A write that cannot happen at all is the one exception — with no task
 * file there is nothing to hand over — and it propagates.
 */
export async function stageHandoff(
  platform: InstalledPlatform,
  dir: string,
  task: string,
  deps: HandoffDeps,
): Promise<HandoffResult> {
  const when = deps.now?.() ?? Date.now();
  const folder = join(deps.dataDir, "handoff");
  mkdirSync(folder, { recursive: true });
  const taskFile = join(folder, `task-${when}.md`);
  writeFileSync(taskFile, note(task, dir, platform.spec.label, when), "utf8");
  // The paste-able copy. Same directory, same timestamp, and deliberately not the
  // note: a clipboard that holds the note holds a heading and an instruction
  // addressed to a person, and an agent panel would read both as the prompt.
  const promptFile = join(folder, `task-${when}.txt`);
  writeFileSync(promptFile, `${task.trim()}
`, "utf8");

  const copied = await copyToClipboard(promptFile, task, deps);
  const invocation = openInvocation(platform, dir, [taskFile], deps);
  if (invocation === null) {
    return {
      taskFile,
      promptFile,
      copied,
      opened: false,
      problem: `no ${platform.spec.label} binary could be spawned directly (only a batch shim was found)`,
    };
  }
  try {
    await deps.launch(invocation.file, invocation.args);
    return { taskFile, promptFile, copied, opened: true };
  } catch (err) {
    return {
      taskFile,
      promptFile,
      copied,
      opened: false,
      problem: `could not start ${platform.spec.label}: ${(err as Error).message}`,
    };
  }
}

/**
 * Put the task on the clipboard, and say whether it is really there.
 *
 * The file is read by PowerShell rather than passed as text for two reasons: the
 * task is multi-line, and a value that never enters a command line cannot be
 * mistaken for part of one. Windows only — `pbcopy` and `xclip` would each be a
 * guess about a machine this has not run on, and a handoff without a clipboard is
 * still a handoff, so the honest answer there is `false` with a reason.
 */
async function copyToClipboard(
  promptFile: string,
  task: string,
  deps: HandoffDeps,
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    deps.log?.(`handoff: clipboard not attempted on ${platform}`);
    return false;
  }
  if (!deps.run) {
    deps.log?.("handoff: no process runner, clipboard skipped");
    return false;
  }
  // Unused beyond this check: a task long enough to be worth truncating is a task
  // the file already holds in full, and a clipboard silently holding half of one
  // is worse than a clipboard holding nothing.
  if (task.trim() === "") return false;
  try {
    const result = await deps.run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", CLIPBOARD_SCRIPT],
      { cwd: deps.dataDir, timeoutMs: 10_000, env: { [HANDOFF_ENV]: promptFile } },
    );
    if (result.code === 0) return true;
    deps.log?.(`handoff: clipboard refused (exit ${result.code ?? "signal"})`);
    return false;
  } catch (err) {
    deps.log?.(`handoff: clipboard failed: ${(err as Error).message}`);
    return false;
  }
}
