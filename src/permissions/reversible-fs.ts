/**
 * File operations that can be taken back.
 *
 * §61 forbids permanently deleting personal files, and Phase 5 promises an undo
 * history. Those are the same requirement seen from two sides: an undo that
 * cannot restore a deleted file is a lie, so the delete has to be recoverable
 * before the history is worth keeping.
 *
 * Three things follow from that, and they shape every function here.
 *
 * **Deletion goes to the Recycle Bin, via the shell.** Not `fs.unlink`, which is
 * unrecoverable, and not a hand-rolled move into `$Recycle.Bin`, which produces
 * an entry Explorer cannot restore because the sidecar metadata is missing.
 * `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile` with `RecycleOption` is
 * the documented path that Explorer itself uses, so "Restore" in the Recycle Bin
 * works afterwards — including for a user who never opens Jarvis again.
 *
 * **An overwrite is a delete of the old contents.** Writing over a file destroys
 * what was there just as thoroughly as deleting it, so a write to an existing
 * path snapshots the previous version first. Anything else would make `undo`
 * work for deletes and silently fail for edits, which is worse than not offering
 * it.
 *
 * **Every path is checked against an allow-list before anything happens.** The
 * path arrives from a model (§52) and `path-safety` already knows how to refuse
 * one; this module never widens that. Junctions are re-resolved through
 * `realpath`, so a link inside an allowed root pointing outside it is caught.
 */
import { copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertContained } from "../system/path-safety.js";
import { isConfirmed, runVerified, type VerifiedActionSpec } from "./verified-action.js";

/** What `undo` looks at before and after, to judge whether it worked. */
interface UndoWorld {
  /** Does the path the step acted on exist? */
  target: boolean;
  /** Does the path it was moved from exist? Only meaningful for a move. */
  origin: boolean;
}

/** How a step can be taken back, if it can. */
export type UndoKind = "restore-from-recycle-bin" | "restore-snapshot" | "reverse-move" | "none";

export interface UndoStep {
  id: string;
  at: number;
  /** What happened, in a sentence for the Activity view. */
  description: string;
  kind: UndoKind;
  /** The path the operation acted on, canonicalised. */
  path: string;
  /** Where the previous contents live, for `restore-snapshot`. */
  snapshot?: string;
  /** Where the file came from, for `reverse-move`. */
  from?: string;
  undone: boolean;
}

export interface ReversibleFsDeps {
  /**
   * Runs a process without a shell. Injected so tests never touch the disk.
   *
   * `env` is part of the signature rather than an afterthought: the target path
   * travels this way, and a runner that quietly dropped it would leave the
   * scripts below reading an empty variable.
   */
  run: (
    file: string,
    args: readonly string[],
    opts?: { timeoutMs?: number; env?: Readonly<Record<string, string>> },
  ) => Promise<string>;
  /** Directories operations may touch. Empty denies everything. */
  roots: readonly string[];
  /** Where snapshots of overwritten files are kept. */
  snapshotDir: string;
  now?: () => number;
  fs?: {
    existsSync: (p: string) => boolean;
    copyFileSync: (a: string, b: string) => void;
    renameSync: (a: string, b: string) => void;
    mkdirSync: (p: string, o?: { recursive: boolean }) => void;
    statSync: (p: string) => { isDirectory: () => boolean };
    realpathSync: (p: string) => string;
  };
}

const PWSH = "powershell.exe";

/**
 * Send one file or folder to the Recycle Bin.
 *
 * The path travels in the environment rather than in the script text, the same
 * rule the Phase 4 executors follow: an environment value is read as data and
 * never parsed as script, so there is nothing to escape and nothing to splice.
 * The script re-checks existence and fails loudly rather than reporting success
 * for a path that was not there.
 */
const RECYCLE_SCRIPT = `
$ErrorActionPreference = 'Stop'
# Progress records go to stderr as a CLIXML blob, which buries the real error
# message underneath it. Nothing here needs a progress bar.
$ProgressPreference = 'SilentlyContinue'
$target = $env:JARVIS_TARGET
if ([string]::IsNullOrWhiteSpace($target)) { throw 'no target' }
Add-Type -AssemblyName Microsoft.VisualBasic
if (Test-Path -LiteralPath $target -PathType Container) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
    $target,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
} elseif (Test-Path -LiteralPath $target -PathType Leaf) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
    $target,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
} else {
  throw "not found: $target"
}
Write-Output 'RECYCLED'
`;

/**
 * Pull the most recent Recycle Bin entry for a path back to where it was.
 *
 * Explorer's own restore, through the Shell.Application COM object — the only
 * interface that restores an entry *and* clears it from the bin, which is what a
 * user means by undo. Matching is on the original full path the bin recorded, so
 * a same-named file deleted from a different folder is not the one that comes
 * back. Newest first, because a path deleted twice should undo in reverse order.
 *
 * The extension handling below is not defensive padding: on this machine the
 * probe caught the bin reporting `x` for a deleted `x.txt`, because the shell
 * applies Explorer's hide-known-extensions setting to the name it hands out. The
 * restore matched nothing and the delete had already happened.
 */
const RESTORE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$target = $env:JARVIS_TARGET
if ([string]::IsNullOrWhiteSpace($target)) { throw 'no target' }
$shell = New-Object -ComObject Shell.Application
$bin = $shell.Namespace(10)
$match = $null
foreach ($item in $bin.Items()) {
  # Column 1 is the folder the item was deleted from. The leaf has to be rebuilt
  # rather than taken from $item.Name, which honours Explorer's "hide extensions
  # for known file types" setting: with it on, a recycled notes.md comes back as
  # "notes" and never matches the target. The bin's own copy keeps the real
  # extension ($RXXXXXX.md), so $item.Path is the trustworthy source for one.
  $leaf = $item.Name
  $ext = [System.IO.Path]::GetExtension($item.Path)
  if ($ext -and -not $leaf.EndsWith($ext, [System.StringComparison]::OrdinalIgnoreCase)) {
    $leaf = $leaf + $ext
  }
  $original = Join-Path $bin.GetDetailsOf($item, 1) $leaf
  if ($original -ieq $target) {
    if ($null -eq $match -or $item.ModifyDate -gt $match.ModifyDate) { $match = $item }
  }
}
if ($null -eq $match) { throw "not in the Recycle Bin: $target" }
$done = $false
foreach ($verb in $match.Verbs()) {
  if (($verb.Name -replace '&','') -eq 'Restore') { $verb.DoIt(); $done = $true; break }
}
if (-not $done) { throw "the Recycle Bin offered no Restore for: $target" }
# DoIt() is asynchronous and reports nothing, so success is confirmed by looking
# rather than assumed. Without this a restore that silently failed would still
# mark the step undone, and the history would claim work it had not done.
for ($i = 0; $i -lt 50; $i++) {
  if (Test-Path -LiteralPath $target) { break }
  Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $target)) { throw "the restore did not put the file back: $target" }
Write-Output 'RESTORED'
`;

function encodePwsh(script: string): readonly string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

/**
 * Reversible file operations plus the history that reverses them.
 *
 * The history is in memory only, and deliberately: it exists so a user can say
 * "undo that" in the same sitting. Persisting it would mean writing a list of
 * everything Jarvis touched to disk, which is a privacy cost the feature does not
 * need — and the Recycle Bin itself already survives a restart for the case that
 * matters.
 */
export class ReversibleFs {
  private readonly steps: UndoStep[] = [];
  private readonly now: () => number;
  private readonly fs: NonNullable<ReversibleFsDeps["fs"]>;
  private counter = 0;

  constructor(private readonly deps: ReversibleFsDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.fs = deps.fs ?? {
      existsSync,
      copyFileSync,
      renameSync,
      mkdirSync,
      statSync,
      realpathSync,
    };
  }

  /** Canonicalise and confirm the path is inside the allow-list. */
  private safe(path: string): string {
    return assertContained(path, this.deps.roots, (p) => this.fs.realpathSync(p));
  }

  /**
   * Delete to the Recycle Bin.
   *
   * Refuses a directory unless asked explicitly. "Delete the folder" and "delete
   * the file" are different amounts of damage, and a tool call that names a
   * directory when the caller expected a file is more likely a mistake than an
   * intention.
   */
  async remove(path: string, opts: { allowDirectory?: boolean } = {}): Promise<UndoStep> {
    const target = this.safe(path);
    if (!this.fs.existsSync(target)) throw new Error(`nothing to delete at "${target}"`);
    if (!opts.allowDirectory && this.fs.statSync(target).isDirectory()) {
      throw new Error(`"${target}" is a folder; deleting a folder has to be asked for explicitly`);
    }

    const out = await this.deps.run(PWSH, encodePwsh(RECYCLE_SCRIPT), {
      timeoutMs: 20_000,
      env: targetEnv(target),
    });
    if (!out.includes("RECYCLED")) throw new Error(`the delete did not report success: ${out.trim()}`);

    return this.push({
      description: `moved ${target} to the Recycle Bin`,
      kind: "restore-from-recycle-bin",
      path: target,
    });
  }

  /**
   * Snapshot a file that is about to be overwritten.
   *
   * Called *before* the write, and returns the step so the caller can hand it
   * back to `undo`. A path that does not exist yet yields a `none` step: there is
   * nothing to restore, and creating a file is undone by deleting it, which is
   * the caller's own `remove`.
   */
  snapshot(path: string): UndoStep {
    const target = this.safe(path);
    if (!this.fs.existsSync(target)) {
      return this.push({
        description: `created ${target}`,
        kind: "none",
        path: target,
      });
    }

    this.fs.mkdirSync(this.deps.snapshotDir, { recursive: true });
    // Name is unique per step, not derived from the file's own name: two files
    // called `notes.md` from different folders must not collide, and a name
    // taken from an untrusted path must not decide where a write lands.
    const id = this.nextId();
    const snapshot = join(this.deps.snapshotDir, `${id}.bak`);
    this.fs.copyFileSync(target, snapshot);

    return this.push({
      description: `kept the previous version of ${target}`,
      kind: "restore-snapshot",
      path: target,
      snapshot,
    });
  }

  /** Record a move so it can be reversed. The move itself is the caller's. */
  recordMove(from: string, to: string): UndoStep {
    const a = this.safe(from);
    const b = this.safe(to);
    return this.push({
      description: `moved ${a} to ${b}`,
      kind: "reverse-move",
      path: b,
      from: a,
    });
  }

  /**
   * Take back one step.
   *
   * Defaults to the most recent thing that can be undone, which is what "undo
   * that" means. Already-undone steps are skipped rather than repeated, so
   * saying it twice does not restore a stale snapshot over newer contents.
   */
  async undo(id?: string): Promise<UndoStep> {
    const step = id
      ? this.steps.find((s) => s.id === id)
      : [...this.steps].reverse().find((s) => !s.undone && s.kind !== "none");
    if (!step) throw new Error(id ? `no step with id ${id}` : "there is nothing to undo");
    if (step.undone) throw new Error("that step has already been undone");
    if (step.kind === "none") {
      throw new Error("that step did not change anything that can be restored");
    }

    // `undone` is set from the verdict, not from the reversal returning. That
    // distinction is the whole lesson of the restore bug: `DoIt()` returned
    // nothing, the code read that as success, and the history claimed work it
    // had not done. Anything short of "verified" leaves the step un-undone, so
    // the user can try again instead of being told it is already handled.
    const report = await runVerified(this.reversal(step), { timeoutMs: 25_000 });
    if (!isConfirmed(report.outcome)) throw new Error(report.detail);

    step.undone = true;
    return step;
  }

  /**
   * Undoing one step, expressed as something whose success can be checked.
   *
   * The Recycle Bin script already confirms the file came back, so the check
   * here is a second, independent look from outside PowerShell — cheap, and it
   * does not take the script's word for it. For the other two kinds it is the
   * only check there is: `copyFileSync` and `renameSync` throw on most failures,
   * but "it did not throw" is the assumption this file exists to stop making.
   */
  private reversal(step: UndoStep): VerifiedActionSpec<UndoWorld> {
    const origin = step.from;
    return {
      description: `undo: ${step.description}`,
      observe: () => ({
        target: this.fs.existsSync(step.path),
        origin: origin ? this.fs.existsSync(origin) : false,
      }),
      act: async () => {
        switch (step.kind) {
          case "restore-from-recycle-bin": {
            const out = await this.deps.run(PWSH, encodePwsh(RESTORE_SCRIPT), {
              timeoutMs: 20_000,
              env: targetEnv(step.path),
            });
            if (!out.includes("RESTORED")) {
              throw new Error(`the restore did not report success: ${out.trim()}`);
            }
            return;
          }
          case "restore-snapshot": {
            if (!step.snapshot || !this.fs.existsSync(step.snapshot)) {
              throw new Error("the saved copy is gone, so this cannot be undone");
            }
            this.fs.copyFileSync(step.snapshot, step.path);
            return;
          }
          case "reverse-move": {
            if (!origin) throw new Error("no original location was recorded");
            this.fs.renameSync(step.path, origin);
            return;
          }
          case "none":
            throw new Error("that step did not change anything that can be restored");
        }
      },
      verify: (_before, after) => {
        // A move is the one kind with two halves to check. Confirming only that
        // the file reappeared at its old path would call a copy a move and leave
        // a duplicate behind at the new one.
        if (step.kind === "reverse-move") {
          if (after.origin && !after.target) {
            return { ok: true, detail: `${origin} is back where it was` };
          }
          return {
            ok: false,
            reason: after.origin
              ? `${step.path} is still there as well, so the move was copied rather than reversed`
              : `nothing came back to ${origin}`,
          };
        }
        return after.target
          ? { ok: true, detail: `${step.path} is back` }
          : { ok: false, reason: `${step.path} is still not there` };
      },
    };
  }

  private nextId(): string {
    this.counter += 1;
    return `undo-${this.counter}`;
  }

  private push(step: Omit<UndoStep, "id" | "at" | "undone">): UndoStep {
    const full: UndoStep = { ...step, id: this.nextId(), at: this.now(), undone: false };
    this.steps.push(full);
    // Bounded like the audit log: the runtime stays up for weeks.
    if (this.steps.length > 200) this.steps.splice(0, this.steps.length - 200);
    return full;
  }

  /** Most recent last, for the Activity view. */
  get history(): readonly UndoStep[] {
    return this.steps;
  }
}

/** The environment a recycle or restore call needs. Path as data, never script. */
export function targetEnv(path: string): Readonly<Record<string, string>> {
  return { JARVIS_TARGET: path };
}
