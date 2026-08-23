/**
 * Filesystem tools.
 *
 * Two gates stand in front of every one of these, and neither is negotiable from
 * a plan:
 *
 *  - **`checkPath` against `ctx.roots`.** The roots come from config and the
 *    project registry, never from a step's arguments. An empty root list denies
 *    everything, which is `path-safety.ts`'s reading of "nothing configured" and
 *    the right one for an autonomous loop.
 *  - **`runVerified` for anything that writes.** The write is followed by a read
 *    of the same path, so "the call returned" never becomes "the file is there".
 *
 * Deletes go to the Recycle Bin through `ReversibleFs`, which also snapshots a
 * file before it is overwritten. Nothing here removes anything permanently.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { win32 as path } from "node:path";
import { checkPath } from "../../system/path-safety.js";
import { runVerified, existenceVerifier } from "../../permissions/verified-action.js";
import type { ReversibleFs } from "../../permissions/reversible-fs.js";
import {
  readBoolean,
  readString,
  type Tool,
  type ToolArgs,
  type ToolContext,
  type ToolRun,
} from "../registry.js";

/** How much of a file one step may read. A step is a summary, not a copy. */
const MAX_READ_BYTES = 64 * 1024;

/** How many names one listing returns. The count is reported in full. */
const MAX_ENTRIES = 200;

export interface FilesystemDeps {
  /**
   * The undo layer, for deletes and for snapshotting a file about to be
   * overwritten. Absent means neither tool is registered — a Jarvis that cannot
   * take a delete back does not offer one.
   */
  readonly reversible?: ReversibleFs;
}

/**
 * Resolve a path argument, or say why not.
 *
 * The refusal text is the verdict's own, which is written to be shown: "path is
 * outside the allowed directories" is what the user needs to read on a failed
 * step, and it names no path the caller does not already know about.
 */
function resolve(
  raw: string,
  ctx: ToolContext,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string } {
  const verdict = checkPath(raw, ctx.roots);
  if (!verdict.ok || !verdict.path) {
    return { ok: false, reason: verdict.reason ?? "that path is not allowed" };
  }
  // Re-check the resolved target: a junction inside an allowed root that points
  // outside it passes the lexical check and fails this one.
  try {
    const real = realpathSync(verdict.path);
    const again = checkPath(real, ctx.roots);
    if (!again.ok || !again.path) {
      return { ok: false, reason: "that path resolves outside the allowed directories" };
    }
    return { ok: true, path: again.path };
  } catch {
    // Nothing there yet. Normal for a write, and the lexical check has passed.
    return { ok: true, path: verdict.path };
  }
}

function refused(reason: string): ToolRun {
  return { outcome: "failed", summary: "refused", error: reason };
}

const readFile: Tool = {
  name: "read_file",
  summary: "Read a text file inside the allowed directories",
  schema: { path: { kind: "string", required: true, max: 400 } },
  async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
    const target = resolve(readString(args, "path"), ctx);
    if (!target.ok) return refused(target.reason);
    let raw: string;
    try {
      const stat = statSync(target.path);
      if (stat.isDirectory()) return refused("that is a directory, not a file");
      raw = readFileSync(target.path, "utf8").slice(0, MAX_READ_BYTES);
    } catch (err) {
      return {
        outcome: "failed",
        summary: `could not read ${path.basename(target.path)}`,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    // The contents are data. They travel in `data` for a later step to read and
    // in `detail` for the user to see; nothing downstream treats either as an
    // instruction, and the registry sanitises what is displayed.
    return {
      outcome: "verified",
      summary: `read ${path.basename(target.path)} (${raw.length} characters)`,
      detail: raw,
      data: { path: target.path, text: raw },
    };
  },
};

const listDirectory: Tool = {
  name: "list_directory",
  summary: "List the entries of a directory inside the allowed directories",
  schema: { path: { kind: "string", required: true, max: 400 } },
  async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
    const target = resolve(readString(args, "path"), ctx);
    if (!target.ok) return refused(target.reason);
    try {
      const all = readdirSync(target.path, { withFileTypes: true });
      const names = all
        .slice(0, MAX_ENTRIES)
        .map((d) => (d.isDirectory() ? `${d.name}\\` : d.name));
      return {
        outcome: "verified",
        // The full count, not the truncated one: a listing that says "12 entries"
        // when there are 900 is worse than one that says it was cut short.
        summary: `${all.length} entries in ${path.basename(target.path) || target.path}`,
        detail: names.join(", "),
        data: { path: target.path, entries: names, total: all.length },
      };
    } catch (err) {
      return {
        outcome: "failed",
        summary: `could not list ${target.path}`,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

function writeFileTool(deps: FilesystemDeps): Tool {
  return {
    name: "write_file",
    summary: "Write a text file, snapshotting anything it replaces",
    schema: {
      path: { kind: "string", required: true, max: 400 },
      text: { kind: "string", required: true, max: 100_000 },
      createDirectories: { kind: "boolean" },
    },
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      const target = resolve(readString(args, "path"), ctx);
      if (!target.ok) return refused(target.reason);
      const text = readString(args, "text");
      const dir = path.dirname(target.path);

      let snapshot: string | undefined;
      if (existsSync(target.path)) {
        if (!deps.reversible) {
          return refused("that file exists and there is no undo layer to snapshot it");
        }
        try {
          snapshot = deps.reversible.snapshot(target.path).snapshot;
        } catch (err) {
          // A snapshot that cannot be taken stops the write. Overwriting anyway
          // would be the one filesystem action here with no way back.
          return refused(
            `could not snapshot the existing file: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // The verifier reads the file back and compares. `existenceVerifier` is not
      // enough for a write: a file that was already there would satisfy it
      // without a single byte having changed.
      const report = await runVerified(
        {
          description: `write ${path.basename(target.path)}`,
          observe: () => (existsSync(target.path) ? readFileSync(target.path, "utf8") : null),
          act: () => {
            if (readBoolean(args, "createDirectories") && !existsSync(dir)) {
              mkdirSync(dir, { recursive: true });
            }
            writeFileSync(target.path, text, "utf8");
          },
          verify: (_before, after) =>
            after === text
              ? { ok: true, detail: `${path.basename(target.path)} holds what was asked for` }
              : { ok: false, reason: "the file does not hold what was written" },
        },
        { timeoutMs: ctx.timeoutMs, now: ctx.now },
      );

      return {
        outcome: report.outcome,
        summary: `${report.description}: ${report.detail}`,
        ...(report.error !== undefined ? { error: report.error } : {}),
        data: {
          path: target.path,
          bytes: text.length,
          ...(snapshot !== undefined ? { snapshot } : {}),
        },
      };
    },
  };
}

function deleteFileTool(reversible: ReversibleFs): Tool {
  return {
    name: "delete_file",
    summary: "Send a file to the Recycle Bin, so it can be restored",
    schema: { path: { kind: "string", required: true, max: 400 } },
    // Slower than the default: `remove` runs PowerShell, and the shell's own
    // start-up is most of that time.
    timeoutMs: 45_000,
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      const target = resolve(readString(args, "path"), ctx);
      if (!target.ok) return refused(target.reason);
      // `remove` reports success from the script's own output, which is a claim.
      // The verifier is what settles it: the file is gone, or it is not.
      const report = await runVerified(
        {
          description: `send ${path.basename(target.path)} to the Recycle Bin`,
          observe: () => existsSync(target.path),
          act: async () => {
            await reversible.remove(target.path);
          },
          verify: existenceVerifier(path.basename(target.path), "absent"),
        },
        { timeoutMs: ctx.timeoutMs, now: ctx.now },
      );
      return {
        outcome: report.outcome,
        summary: `${report.description}: ${report.detail}`,
        ...(report.error !== undefined ? { error: report.error } : {}),
        data: { path: target.path, recoverable: report.outcome === "verified" },
      };
    },
  };
}

/**
 * The filesystem tools, given what is available to back them.
 *
 * `write_file` and `delete_file` appear only with an undo layer. That is not
 * defensive coding: a delete with no way back is the one thing §3 of the security
 * model says never happens, and a tool that is absent cannot be planned with.
 */
export function filesystemTools(deps: FilesystemDeps = {}): readonly Tool[] {
  const tools: Tool[] = [readFile, listDirectory];
  if (deps.reversible) {
    tools.push(writeFileTool(deps), deleteFileTool(deps.reversible));
  }
  return tools;
}
