import { describe, it, expect, vi } from "vitest";
import {
  AutostartManager,
  buildLaunchCommand,
  parseRegQueryValue,
  RUN_KEY,
  type Exec,
} from "../src/system/autostart.js";

/**
 * A fake `reg.exe`.
 *
 * These tests never touch the real registry. Enabling autostart is a system
 * change, and a test suite must not make one.
 */
function fakeReg(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const calls: Array<{ file: string; args: string[] }> = [];

  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    if (file !== "reg") throw new Error(`unexpected command: ${file}`);
    const [verb, key, ...rest] = args;
    if (key !== RUN_KEY) throw new Error(`unexpected key: ${key}`);
    const name = rest[rest.indexOf("/v") + 1]!;

    if (verb === "query") {
      const value = store.get(name);
      if (value === undefined) {
        throw new Error(
          "ERROR: The system was unable to find the specified registry key or value",
        );
      }
      return {
        stdout: `\r\n${RUN_KEY}\r\n    ${name}    REG_SZ    ${value}\r\n\r\n`,
        stderr: "",
      };
    }
    if (verb === "add") {
      store.set(name, rest[rest.indexOf("/d") + 1]!);
      return { stdout: "The operation completed successfully.\r\n", stderr: "" };
    }
    if (verb === "delete") {
      if (!store.has(name)) {
        throw new Error("ERROR: The system was unable to find the specified registry key or value");
      }
      store.delete(name);
      return { stdout: "The operation completed successfully.\r\n", stderr: "" };
    }
    throw new Error(`unexpected verb: ${verb}`);
  };

  return { exec, store, calls };
}

const make = (reg: { exec: Exec }, platform: NodeJS.Platform = "win32") =>
  new AutostartManager({ exec: reg.exec, platform });

describe("AutostartManager", () => {
  it("reports disabled when nothing is registered", async () => {
    const m = make(fakeReg());
    const state = await m.getState();

    expect(state.supported).toBe(true);
    expect(state.enabled).toBe(false);
    expect(state.command).toBeNull();
  });

  it("enables, reads back, and disables", async () => {
    const reg = fakeReg();
    const m = make(reg);
    const cmd = buildLaunchCommand("E:\\jarvis\\Jarvis.exe", ["--minimized"]);

    await m.enable(cmd);
    expect(await m.isEnabled()).toBe(true);
    expect((await m.getState()).command).toBe(cmd);

    await m.disable();
    expect(await m.isEnabled()).toBe(false);
  });

  it("writes to HKCU only, so it never needs administrator rights", async () => {
    const reg = fakeReg();
    await make(reg).enable("\"E:\\jarvis\\Jarvis.exe\"");

    const keys = reg.calls.map((c) => c.args[1]);
    expect(keys.every((k) => k?.startsWith("HKCU\\"))).toBe(true);
    expect(keys.some((k) => k?.startsWith("HKLM"))).toBe(false);
  });

  it("does not touch the registry just to read state", async () => {
    const reg = fakeReg({ Jarvis: "\"E:\\jarvis\\Jarvis.exe\"" });
    await make(reg).getState();

    expect(reg.calls.every((c) => c.args[0] === "query")).toBe(true);
  });

  it("treats disabling an absent entry as success", async () => {
    await expect(make(fakeReg()).disable()).resolves.toBeUndefined();
  });

  it("overwrites an existing entry rather than failing", async () => {
    const reg = fakeReg({ Jarvis: "\"C:\\old\\path.exe\"" });
    const m = make(reg);

    await m.enable("\"E:\\jarvis\\Jarvis.exe\" \"--minimized\"");

    expect((await m.getState()).command).toBe("\"E:\\jarvis\\Jarvis.exe\" \"--minimized\"");
    // /f is what makes `reg add` non-interactive; without it the call would
    // block forever on the overwrite prompt.
    expect(reg.calls.at(-2)?.args).toContain("/f");
  });

  it("refuses an empty command instead of registering a broken entry", async () => {
    await expect(make(fakeReg()).enable("   ")).rejects.toThrow(/must not be empty/);
  });

  it("reports unsupported off Windows instead of pretending", async () => {
    const m = make(fakeReg(), "linux");
    const state = await m.getState();

    expect(state.supported).toBe(false);
    expect(state.enabled).toBe(false);
    expect(state.detail).toMatch(/only implemented for win32/);
    await expect(m.enable("x")).rejects.toThrow(/only implemented for win32/);
  });

  it("surfaces an unexpected reg failure as detail, not as enabled", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("Access is denied."));
    const m = new AutostartManager({ exec, platform: "win32" });

    const state = await m.getState();
    expect(state.enabled).toBe(false);
    expect(state.detail).toMatch(/Access is denied/);
  });

  it("setEnabled(false) needs no command", async () => {
    const reg = fakeReg({ Jarvis: "\"E:\\jarvis\\Jarvis.exe\"" });
    const m = make(reg);

    await m.setEnabled(false);
    expect(await m.isEnabled()).toBe(false);
    await expect(m.setEnabled(true)).rejects.toThrow(/requires a command/);
  });
});

describe("buildLaunchCommand", () => {
  it("quotes a path containing spaces", () => {
    expect(buildLaunchCommand("C:\\Program Files\\Jarvis\\Jarvis.exe")).toBe(
      '"C:\\Program Files\\Jarvis\\Jarvis.exe"',
    );
  });

  it("quotes each argument separately", () => {
    expect(buildLaunchCommand("C:\\a b\\J.exe", ["--minimized", "--profile", "my user"])).toBe(
      '"C:\\a b\\J.exe" "--minimized" "--profile" "my user"',
    );
  });

  it("strips embedded quotes so a crafted path cannot inject arguments", () => {
    const evil = 'C:\\a.exe" "--run-something-else';
    expect(buildLaunchCommand(evil)).toBe('"C:\\a.exe --run-something-else"');
  });
});

describe("parseRegQueryValue", () => {
  const output = [
    "",
    RUN_KEY,
    "    OneDrive    REG_SZ    \"C:\\Users\\me\\OneDrive.exe\" /background",
    "    Jarvis    REG_SZ    \"E:\\jarvis\\Jarvis.exe\" \"--minimized\"",
    "",
  ].join("\r\n");

  it("finds the requested value and keeps spaces in the data", () => {
    expect(parseRegQueryValue(output, "Jarvis")).toBe(
      '"E:\\jarvis\\Jarvis.exe" "--minimized"',
    );
  });

  it("does not confuse neighbouring entries", () => {
    expect(parseRegQueryValue(output, "OneDrive")).toBe(
      '"C:\\Users\\me\\OneDrive.exe" /background',
    );
  });

  it("returns null when the value is absent", () => {
    expect(parseRegQueryValue(output, "NotThere")).toBeNull();
  });

  it("matches case-insensitively, as the registry does", () => {
    expect(parseRegQueryValue(output, "jArViS")).not.toBeNull();
  });

  it("returns null for empty output", () => {
    expect(parseRegQueryValue("", "Jarvis")).toBeNull();
  });
});
