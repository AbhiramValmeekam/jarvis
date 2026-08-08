import { describe, it, expect } from "vitest";
import {
  resolveAutostartCommand,
  START_MINIMIZED_FLAG,
  startedMinimized,
} from "../src/desktop/launch.js";

describe("resolveAutostartCommand", () => {
  it("builds a quoted command with --minimized for a packaged build", () => {
    const target = resolveAutostartCommand({
      execPath: "C:\\Program Files\\Jarvis\\Jarvis.exe",
      isPackaged: true,
    });

    expect(target.available).toBe(true);
    if (target.available) {
      expect(target.command).toBe(
        '"C:\\Program Files\\Jarvis\\Jarvis.exe" "--minimized"',
      );
    }
  });

  it("refuses in dev instead of registering a bare electron.exe", () => {
    const target = resolveAutostartCommand({
      execPath: "E:\\jarvis\\node_modules\\electron\\dist\\electron.exe",
      isPackaged: false,
    });

    expect(target.available).toBe(false);
    if (!target.available) {
      expect(target.reason).toMatch(/no stable executable/);
    }
  });
});

describe("startedMinimized", () => {
  it("detects the flag anywhere on the command line", () => {
    expect(startedMinimized(["electron", "out", "--minimized"])).toBe(true);
    expect(startedMinimized(["electron", "--minimized"])).toBe(true);
  });

  it("is false without the flag", () => {
    expect(startedMinimized(["electron", "out"])).toBe(false);
    expect(startedMinimized([])).toBe(false);
  });

  it("the flag constant is what the autostart entry uses", () => {
    // A typo between these two files would silently break start-minimised.
    expect(START_MINIMIZED_FLAG).toBe("--minimized");
  });
});
