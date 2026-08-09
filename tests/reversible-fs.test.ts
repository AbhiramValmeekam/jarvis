/**
 * Undo is only honest if the delete was recoverable.
 *
 * These tests use a fake runner, so they prove the wiring and the refusals but
 * *not* that the Recycle Bin really works — that needs a real file on a real
 * Windows disk, which is what `probe:undo` does. The distinction is the point:
 * a green suite here would not on its own justify calling the feature done.
 */
import { describe, it, expect, vi } from "vitest";
import { ReversibleFs, targetEnv } from "../src/permissions/reversible-fs.js";

const ROOT = "C:\\Users\\me\\work";

function makeFs(over: { present?: string[]; dirs?: string[] } = {}) {
  const present = new Set(over.present ?? [`${ROOT}\\a.txt`]);
  const dirs = new Set(over.dirs ?? []);
  const copies: Array<[string, string]> = [];
  const renames: Array<[string, string]> = [];
  const run = vi.fn(async (_file: string, _args: readonly string[], opts?: { env?: Record<string, string> }) => {
    const target = opts?.env?.["JARVIS_TARGET"] ?? "";
    if (!target) throw new Error("no target");
    return "RECYCLED RESTORED";
  });

  const fs = new ReversibleFs({
    run,
    roots: [ROOT],
    snapshotDir: `${ROOT}\\.jarvis\\undo`,
    now: () => 1_000,
    fs: {
      existsSync: (p) => present.has(p),
      copyFileSync: (a, b) => {
        copies.push([a, b]);
        present.add(b);
      },
      renameSync: (a, b) => {
        renames.push([a, b]);
        present.delete(a);
        present.add(b);
      },
      mkdirSync: () => {},
      statSync: (p) => ({ isDirectory: () => dirs.has(p) }),
      realpathSync: (p) => p,
    },
  });

  return { fs, run, copies, renames, present, dirs };
}

describe("deleting", () => {
  it("sends the file to the Recycle Bin rather than unlinking it", async () => {
    // §61: permanent deletion of personal files is off the table, so the undo
    // history has something to restore from.
    const { fs, run } = makeFs();
    const step = await fs.remove(`${ROOT}\\a.txt`);
    expect(step.kind).toBe("restore-from-recycle-bin");
    expect(run).toHaveBeenCalledOnce();
    const [file, , opts] = run.mock.calls[0]!;
    expect(file).toBe("powershell.exe");
    expect(opts?.env).toEqual(targetEnv(`${ROOT}\\a.txt`));
  });

  it("passes the path as data, never spliced into the script", async () => {
    const { fs, run } = makeFs({ present: [`${ROOT}\\a.txt`] });
    await fs.remove(`${ROOT}\\a.txt`);
    const args = run.mock.calls[0]![1];
    const script = Buffer.from(String(args[3]), "base64").toString("utf16le");
    expect(script).not.toContain("a.txt");
    expect(script).toContain("$env:JARVIS_TARGET");
  });

  it("refuses a path outside the allowed roots", async () => {
    const { fs, run } = makeFs();
    await expect(fs.remove("C:\\Windows\\System32\\drivers\\etc\\hosts")).rejects.toThrow(
      /refusing to use/,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a traversal that climbs out of an allowed root", async () => {
    const { fs } = makeFs();
    await expect(fs.remove(`${ROOT}\\..\\..\\secrets.txt`)).rejects.toThrow(/refusing to use/);
  });

  it("refuses a folder unless asked for one explicitly", async () => {
    const { fs } = makeFs({ present: [`${ROOT}\\stuff`], dirs: [`${ROOT}\\stuff`] });
    await expect(fs.remove(`${ROOT}\\stuff`)).rejects.toThrow(/has to be asked for explicitly/);
    await expect(fs.remove(`${ROOT}\\stuff`, { allowDirectory: true })).resolves.toBeDefined();
  });

  it("does not claim success for a file that was not there", async () => {
    const { fs } = makeFs({ present: [] });
    await expect(fs.remove(`${ROOT}\\gone.txt`)).rejects.toThrow(/nothing to delete/);
  });

  it("reports a failure rather than recording a delete that did not happen", async () => {
    const { fs } = makeFs();
    const broken = new ReversibleFs({
      run: async () => "Access is denied.",
      roots: [ROOT],
      snapshotDir: `${ROOT}\\.jarvis\\undo`,
      fs: {
        existsSync: () => true,
        copyFileSync: () => {},
        renameSync: () => {},
        mkdirSync: () => {},
        statSync: () => ({ isDirectory: () => false }),
        realpathSync: (p) => p,
      },
    });
    await expect(broken.remove(`${ROOT}\\a.txt`)).rejects.toThrow(/did not report success/);
    expect(broken.history).toHaveLength(0);
    expect(fs.history).toHaveLength(0);
  });
});

describe("overwriting", () => {
  it("keeps the previous version before a write", () => {
    // An overwrite destroys the old contents as thoroughly as a delete does.
    const { fs, copies } = makeFs();
    const step = fs.snapshot(`${ROOT}\\a.txt`);
    expect(step.kind).toBe("restore-snapshot");
    expect(copies[0]?.[0]).toBe(`${ROOT}\\a.txt`);
    expect(step.snapshot).toMatch(/undo-\d+\.bak$/);
  });

  it("does not derive the snapshot name from the untrusted path", () => {
    const { fs } = makeFs({ present: [`${ROOT}\\..\\evil.txt`, `${ROOT}\\a.txt`] });
    const step = fs.snapshot(`${ROOT}\\a.txt`);
    expect(step.snapshot).not.toContain("a.txt");
  });

  it("records a new file as nothing to restore", () => {
    const { fs, copies } = makeFs({ present: [] });
    const step = fs.snapshot(`${ROOT}\\new.txt`);
    expect(step.kind).toBe("none");
    expect(copies).toHaveLength(0);
  });

  it("restores the snapshot on undo", async () => {
    const { fs, copies } = makeFs();
    const step = fs.snapshot(`${ROOT}\\a.txt`);
    await fs.undo();
    expect(copies.at(-1)).toEqual([step.snapshot, `${ROOT}\\a.txt`]);
  });

  it("says so plainly when the saved copy is gone", async () => {
    const { fs, present } = makeFs();
    const step = fs.snapshot(`${ROOT}\\a.txt`);
    present.delete(step.snapshot!);
    await expect(fs.undo()).rejects.toThrow(/saved copy is gone/);
  });
});

describe("the scripts the probe found bugs in", () => {
  /**
   * These assert on the PowerShell text, which is normally a poor thing to test
   * — but each one pins a defect that reached a real machine and that no
   * behavioural test with a fake runner can see. They are regression locks, not
   * a substitute for `probe:permissions`.
   */
  async function scriptFor(op: "remove" | "undo"): Promise<string> {
    const { fs, run } = makeFs();
    const step = await fs.remove(`${ROOT}\\a.txt`);
    if (op === "undo") await fs.undo(step.id);
    const args = run.mock.calls.at(op === "undo" ? -1 : 0)![1];
    return Buffer.from(String(args[3]), "base64").toString("utf16le");
  }

  it("rebuilds the extension the Recycle Bin hides", async () => {
    // The bin's FolderItem.Name honours Explorer's "hide extensions for known
    // file types", so a deleted `x.txt` is reported as `x`. Matching on that
    // name alone found nothing, and the file stayed deleted.
    const script = await scriptFor("undo");
    expect(script).toContain("GetExtension");
    expect(script).not.toMatch(/Join-Path \$bin\.GetDetailsOf\(\$item, 1\) \$item\.Name/);
  });

  it("confirms the file came back instead of trusting the verb", async () => {
    // Verbs.DoIt() is asynchronous and returns nothing, so a failed restore
    // would otherwise still mark the step undone.
    const script = await scriptFor("undo");
    expect(script).toMatch(/Test-Path -LiteralPath \$target/);
    expect(script).toMatch(/did not put the file back/);
  });

  it("silences the progress stream that buried the real error", async () => {
    // Progress records are written to stderr as a CLIXML blob; the runner keeps
    // the first line of stderr, so the actual message was never visible.
    for (const op of ["remove", "undo"] as const) {
      expect(await scriptFor(op)).toContain("$ProgressPreference = 'SilentlyContinue'");
    }
  });
});

describe("undo history", () => {
  it("undoes the most recent step by default", async () => {
    const { fs, renames } = makeFs({ present: [`${ROOT}\\a.txt`, `${ROOT}\\b.txt`] });
    fs.snapshot(`${ROOT}\\a.txt`);
    fs.recordMove(`${ROOT}\\b.txt`, `${ROOT}\\c.txt`);
    const undone = await fs.undo();
    expect(undone.kind).toBe("reverse-move");
    expect(renames.at(-1)).toEqual([`${ROOT}\\c.txt`, `${ROOT}\\b.txt`]);
  });

  it("does not repeat a step that was already undone", async () => {
    const { fs } = makeFs();
    fs.snapshot(`${ROOT}\\a.txt`);
    await fs.undo();
    // Saying "undo that" twice must not restore a stale copy over newer work.
    await expect(fs.undo()).rejects.toThrow(/nothing to undo/);
  });

  it("skips steps that changed nothing restorable", async () => {
    const { fs, present } = makeFs({ present: [`${ROOT}\\a.txt`] });
    fs.snapshot(`${ROOT}\\a.txt`);
    present.delete(`${ROOT}\\new.txt`);
    fs.snapshot(`${ROOT}\\new.txt`);
    const undone = await fs.undo();
    expect(undone.kind).toBe("restore-snapshot");
  });

  it("undoes a named step out of order when asked", async () => {
    const { fs, copies } = makeFs({ present: [`${ROOT}\\a.txt`, `${ROOT}\\b.txt`] });
    const first = fs.snapshot(`${ROOT}\\a.txt`);
    fs.snapshot(`${ROOT}\\b.txt`);
    await fs.undo(first.id);
    expect(copies.at(-1)?.[1]).toBe(`${ROOT}\\a.txt`);
  });

  it("says there is nothing to undo rather than pretending", async () => {
    const { fs } = makeFs();
    await expect(fs.undo()).rejects.toThrow(/nothing to undo/);
    await expect(fs.undo("undo-999")).rejects.toThrow(/no step with id/);
  });

  it("stays bounded over a long run", () => {
    const { fs } = makeFs({ present: [] });
    for (let i = 0; i < 260; i += 1) fs.snapshot(`${ROOT}\\f${i}.txt`);
    expect(fs.history.length).toBeLessThanOrEqual(200);
  });
});

describe("undo believes the disk, not the reversal", () => {
  /**
   * The failure these guard against is the one that actually happened: the
   * Recycle Bin restore reported nothing at all, the step was marked undone, and
   * the file stayed deleted. A fake runner cannot reproduce the COM behaviour,
   * but it can reproduce the shape — say the right words, change nothing.
   */
  it("refuses to mark a step undone when the file did not come back", async () => {
    const present = new Set([`${ROOT}\\a.txt`]);
    const fs = new ReversibleFs({
      // Claims both operations worked. Only the disk disagrees.
      run: async () => "RECYCLED RESTORED",
      roots: [ROOT],
      snapshotDir: `${ROOT}\\.jarvis\\undo`,
      fs: {
        existsSync: (p) => present.has(p),
        copyFileSync: () => {},
        renameSync: () => {},
        mkdirSync: () => {},
        statSync: () => ({ isDirectory: () => false }),
        realpathSync: (p) => p,
      },
    });

    const step = await fs.remove(`${ROOT}\\a.txt`);
    present.delete(`${ROOT}\\a.txt`);

    await expect(fs.undo(step.id)).rejects.toThrow(/still not there/);
    // The important half: the history must not claim work it did not do, so
    // "undo that" a second time still tries rather than reporting it handled.
    expect(step.undone).toBe(false);
  });

  it("does not accept a move that was copied rather than reversed", async () => {
    // A rename that leaves the file at both paths has not been undone. Checking
    // only the original location would call this a success and quietly leave a
    // duplicate behind.
    const present = new Set([`${ROOT}\\c.txt`]);
    const fs = new ReversibleFs({
      run: async () => "RESTORED",
      roots: [ROOT],
      snapshotDir: `${ROOT}\\.jarvis\\undo`,
      fs: {
        existsSync: (p) => present.has(p),
        copyFileSync: () => {},
        renameSync: (_a, b) => { present.add(b); },
        mkdirSync: () => {},
        statSync: () => ({ isDirectory: () => false }),
        realpathSync: (p) => p,
      },
    });

    const step = fs.recordMove(`${ROOT}\\b.txt`, `${ROOT}\\c.txt`);
    await expect(fs.undo(step.id)).rejects.toThrow(/still there as well/);
    expect(step.undone).toBe(false);
  });

  it("marks the step undone once the disk agrees", async () => {
    // The positive case, so the two tests above are not passing by refusing
    // everything. Here the runner actually puts the file back.
    const present = new Set([`${ROOT}\\a.txt`]);
    const fs = new ReversibleFs({
      run: async (_file, _args, opts) => {
        const target = opts?.env?.["JARVIS_TARGET"] ?? "";
        if (!target) throw new Error("no target");
        if (present.has(target)) {
          present.delete(target);
          return "RECYCLED";
        }
        present.add(target);
        return "RESTORED";
      },
      roots: [ROOT],
      snapshotDir: `${ROOT}\\.jarvis\\undo`,
      fs: {
        existsSync: (p) => present.has(p),
        copyFileSync: () => {},
        renameSync: () => {},
        mkdirSync: () => {},
        statSync: () => ({ isDirectory: () => false }),
        realpathSync: (p) => p,
      },
    });

    const step = await fs.remove(`${ROOT}\\a.txt`);
    expect(present.has(`${ROOT}\\a.txt`)).toBe(false);
    const undone = await fs.undo(step.id);
    expect(undone.undone).toBe(true);
    expect(present.has(`${ROOT}\\a.txt`)).toBe(true);
  });
});
