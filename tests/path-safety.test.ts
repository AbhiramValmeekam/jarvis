import { describe, it, expect } from "vitest";
import {
  canonicalise,
  checkPath,
  assertContained,
} from "../src/system/path-safety.js";

const ROOTS = ["C:\\Users\\me\\Pictures", "C:\\Users\\me\\Documents"];

const ok = (p: string): string | undefined => checkPath(p, ROOTS).path;
const why = (p: string): string | undefined => checkPath(p, ROOTS).reason;

describe("canonicalise", () => {
  it("accepts an ordinary absolute path and returns one comparable form", () => {
    expect(canonicalise("C:\\Users\\me\\Pictures\\shot.png").path).toBe(
      "C:\\Users\\me\\Pictures\\shot.png",
    );
    // Forward slashes are what a model or a config file tends to produce.
    expect(canonicalise("C:/Users/me/Pictures/shot.png").path).toBe(
      "C:\\Users\\me\\Pictures\\shot.png",
    );
  });

  it("collapses traversal before anything compares the result", () => {
    expect(canonicalise("C:\\Users\\me\\Pictures\\..\\Documents\\a.txt").path).toBe(
      "C:\\Users\\me\\Documents\\a.txt",
    );
  });

  it("requires an absolute path", () => {
    expect(canonicalise("shot.png").ok).toBe(false);
    expect(canonicalise("..\\..\\Windows").ok).toBe(false);
  });

  it("refuses the shapes it cannot safely canonicalise", () => {
    // Each of these is a real way to name one file while appearing to name
    // another, so refusing beats cleaning up.
    expect(canonicalise("\\\\?\\C:\\Users\\me").reason).toMatch(/device-namespace/);
    expect(canonicalise("\\\\.\\PhysicalDrive0").reason).toMatch(/device-namespace/);
    expect(canonicalise("\\\\server\\share\\x").reason).toMatch(/network/);
    expect(canonicalise("C:\\Users\\me\\notes.txt:hidden").reason).toMatch(/alternate data stream/);
    expect(canonicalise("C:\\Users\\me\\secret.txt.").reason).toMatch(/dot or space/);
    expect(canonicalise("C:\\Users\\me\\NUL").reason).toMatch(/reserved/);
    expect(canonicalise("C:\\Users\\me\\nul.txt").reason).toMatch(/reserved/);
    expect(canonicalise("C:\\PROGRA~1\\thing").reason).toMatch(/8\.3/);
    expect(canonicalise("C:\\Users\\me\\a<b.txt").reason).toMatch(/does not allow/);
  });

  it("refuses an embedded NUL, which truncates the path inside Win32", () => {
    expect(canonicalise("C:\\Users\\me\\Pictures\\a.png\u0000.exe").reason).toMatch(/NUL byte/);
  });

  it("refuses nothing at all", () => {
    expect(canonicalise("").ok).toBe(false);
    expect(canonicalise("   ").ok).toBe(false);
  });
});

describe("allow-list containment", () => {
  it("permits paths under a root", () => {
    expect(ok("C:\\Users\\me\\Pictures\\shot.png")).toBe("C:\\Users\\me\\Pictures\\shot.png");
    expect(ok("C:\\Users\\me\\Documents\\notes\\a.txt")).toBeDefined();
  });

  it("matches case-insensitively, because NTFS does", () => {
    // A case-sensitive check here would be trivially bypassable in one
    // direction and annoying in the other.
    expect(ok("c:\\users\\ME\\pictures\\shot.png")).toBeDefined();
  });

  it("rejects a path that escapes via traversal", () => {
    expect(why("C:\\Users\\me\\Pictures\\..\\..\\..\\Windows\\System32\\drivers\\etc\\hosts"))
      .toMatch(/outside the allowed/);
  });

  it("rejects a sibling whose name merely starts with a root", () => {
    // The separator check: C:\Users\me\Picturesabc is not under C:\Users\me\Pictures.
    expect(why("C:\\Users\\me\\Picturesabc\\x.png")).toMatch(/outside the allowed/);
  });

  it("rejects anything outside the roots", () => {
    expect(why("C:\\Windows\\System32\\cmd.exe")).toMatch(/outside the allowed/);
    expect(why("C:\\Users\\other\\Pictures\\x.png")).toMatch(/outside the allowed/);
  });

  it("denies everything when no roots are configured", () => {
    // A misconfiguration must stop Jarvis touching the disk, not unlock it.
    expect(checkPath("C:\\Users\\me\\Pictures\\shot.png", []).ok).toBe(false);
    expect(checkPath("C:\\Users\\me\\Pictures\\shot.png", []).reason).toMatch(/no allowed/);
  });

  it("accepts the root itself", () => {
    expect(ok("C:\\Users\\me\\Pictures")).toBeDefined();
  });
});

describe("assertContained", () => {
  it("returns the canonical path for an allowed target", () => {
    expect(assertContained("C:/Users/me/Pictures/a.png", ROOTS)).toBe(
      "C:\\Users\\me\\Pictures\\a.png",
    );
  });

  it("throws with a reason a user can act on", () => {
    expect(() => assertContained("C:\\Windows\\x.txt", ROOTS)).toThrow(/outside the allowed/);
    expect(() => assertContained("C:\\Users\\me\\Pictures\\NUL", ROOTS)).toThrow(/reserved/);
  });

  it("catches a link inside a root that points outside it", () => {
    // The hole a lexical check cannot see. Resolving is the caller's job, so
    // the resolver is injected; here it stands in for a junction.
    const realpath = (p: string): string =>
      p.toLowerCase() === "c:\\users\\me\\pictures\\escape"
        ? "C:\\Windows\\System32"
        : p;
    expect(() => assertContained("C:\\Users\\me\\Pictures\\escape", ROOTS, realpath)).toThrow(
      /resolves outside/,
    );
  });

  it("allows a path that does not exist yet", () => {
    // Writing a new screenshot is the normal case; realpath will throw for it.
    const realpath = (): string => {
      throw new Error("ENOENT");
    };
    expect(assertContained("C:\\Users\\me\\Pictures\\new.png", ROOTS, realpath)).toBe(
      "C:\\Users\\me\\Pictures\\new.png",
    );
  });

  it("accepts a link that stays inside the allow-list", () => {
    const realpath = (): string => "C:\\Users\\me\\Documents\\real.txt";
    expect(assertContained("C:\\Users\\me\\Pictures\\link.txt", ROOTS, realpath)).toBe(
      "C:\\Users\\me\\Documents\\real.txt",
    );
  });
});
