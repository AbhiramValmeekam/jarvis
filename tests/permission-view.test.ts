/**
 * The dialog is the last thing standing between a tool call and the machine.
 *
 * These tests are less about layout than about a single property: a user reading
 * this dialog should not be able to approve something materially worse than what
 * they think they are approving. That covers weight (a serious action must not
 * look routine), completeness (a truncated list must say so), and display safety
 * (the strings come from a tool call, which may have come from a web page).
 */
import { describe, it, expect } from "vitest";
import {
  toPermissionView,
  buttonsFor,
  currentRequest,
  type PermissionRequestEvent,
} from "../src/ui/permission-model";

function req(over: Partial<PermissionRequestEvent> = {}): PermissionRequestEvent {
  return {
    requestId: "perm-1",
    title: "run_command",
    detail: "execute a command",
    options: ["allow_once", "allow_always", "deny"],
    risk: { level: 2, category: "write" },
    ...over,
  };
}

describe("weight follows the risk", () => {
  it("makes Allow the easy button for a routine change", () => {
    const v = toPermissionView(req({ risk: { level: 1, category: "write" } }));
    expect(v.buttons[0]?.decision).toBe("allow_once");
    expect(v.buttons[0]?.emphasis).toBe("primary");
    expect(v.levelLabel).toBe("Minor");
  });

  it("makes refusing the easy button for a destructive one", () => {
    // The reflex that approves "open Notepad" must not also approve this.
    const v = toPermissionView(req({ risk: { level: 3, category: "delete" } }));
    expect(v.buttons[0]?.decision).toBe("deny");
    expect(v.buttons[0]?.emphasis).toBe("primary");
    expect(v.buttons.find((b) => b.decision === "allow_once")?.emphasis).toBe("quiet");
  });

  it("never lets Allow outrank Deny at level 4", () => {
    const v = toPermissionView(req({ risk: { level: 4, category: "security-control" } }));
    const allow = v.buttons.find((b) => b.decision === "allow_once");
    expect(allow?.emphasis).toBe("quiet");
    expect(v.accent).toBe("#f87171");
  });

  it("treats an unrecognised level as serious, not as trivial", () => {
    // Same rule as the classifier: fail closed. A level the UI does not know
    // must not render as the mildest thing on the list.
    for (const level of [99, -1, 2.5, Number.NaN]) {
      const v = toPermissionView(req({ risk: { level, category: "unknown" } }));
      expect(v.levelLabel).toBe("Unknown");
      expect(v.buttons[0]?.decision).toBe("deny");
    }
  });

  it("treats a missing risk block as serious too", () => {
    const { risk: _drop, ...rest } = req();
    const v = toPermissionView(rest as PermissionRequestEvent);
    expect(v.levelLabel).toBe("Unknown");
    expect(v.buttons[0]?.decision).toBe("deny");
  });
});

describe("refusing is always available", () => {
  it("offers Deny even when the runtime did not list it", () => {
    // Silence already denies, so a dialog without the button would misrepresent
    // what happens if the user walks away.
    const v = toPermissionView(req({ options: ["allow_once"] }));
    expect(v.buttons.some((b) => b.decision === "deny")).toBe(true);
  });

  it("never renders Deny as the discouraged choice", () => {
    for (const level of [0, 1, 2, 3, 4]) {
      const v = toPermissionView(req({ risk: { level, category: "write" } }));
      expect(v.buttons.find((b) => b.decision === "deny")?.emphasis).not.toBe("quiet");
    }
  });

  it("only offers Always when the engine did", () => {
    // Level 4 never accepts "always"; the dialog must not invent the option.
    const v = toPermissionView(req({ options: ["allow_once", "deny"], risk: { level: 4, category: "execute" } }));
    expect(v.buttons.some((b) => b.decision === "allow_always")).toBe(false);
  });

  it("keeps a way out when the runtime sends no options at all", () => {
    expect(buttonsFor([], 2).map((b) => b.decision)).toEqual(["deny"]);
  });
});

describe("what is at stake is stated, not implied", () => {
  it("says how many paths were not shown", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `C:\\Users\\me\\f${i}.txt`);
    const v = toPermissionView(req({ risk: { level: 3, category: "delete", paths, pathCount: 400 } }));
    expect(v.paths).toHaveLength(12);
    // 12 of 400 shown without a word about the rest would understate this by
    // two orders of magnitude.
    expect(v.moreCount).toBe(388);
  });

  it("does not claim more when nothing was truncated", () => {
    const v = toPermissionView(
      req({ risk: { level: 1, category: "write", paths: ["C:\\a.txt"], pathCount: 1 } }),
    );
    expect(v.moreCount).toBe(0);
  });

  it("warns that a network call cannot be recalled", () => {
    const v = toPermissionView(req({ risk: { level: 2, category: "network" } }));
    expect(v.warning).toMatch(/leaves your machine/);
  });

  it("does not warn about a delete, which the Recycle Bin makes reversible", () => {
    // Overstating the stakes is its own failure: a warning on every dialog is a
    // warning on none.
    const v = toPermissionView(req({ risk: { level: 2, category: "delete" } }));
    expect(v.warning).toBeNull();
  });

  it("warns on anything destructive even in an unfamiliar category", () => {
    const v = toPermissionView(req({ risk: { level: 3, category: "something-new" } }));
    expect(v.warning).toMatch(/cannot be undone/);
  });
});

describe("the strings are untrusted", () => {
  it("strips control characters that could forge the dialog", () => {
    const v = toPermissionView(
      req({ title: "read_file\r\n\u001b[2JAllow: yes", detail: "a\u0000b" }),
    );
    expect(v.title).not.toMatch(/[\r\n\u001b\u0000]/);
    expect(v.detail).not.toMatch(/\u0000/);
  });

  it("truncates a title long enough to push the buttons off screen", () => {
    const v = toPermissionView(req({ title: "x".repeat(5_000) }));
    expect(v.title.length).toBeLessThanOrEqual(121);
  });

  it("sanitises paths as well as the title", () => {
    const v = toPermissionView(
      req({ risk: { level: 2, category: "write", paths: ["C:\\a\u001b[31m.txt"], pathCount: 1 } }),
    );
    expect(v.paths[0]).not.toContain("\u001b");
  });
});

describe("several questions at once", () => {
  it("shows the oldest first", () => {
    // The oldest is closest to timing out; answering the newest would let it
    // expire unseen, which reads as Jarvis ignoring the user.
    const a = req({ requestId: "perm-1" });
    const b = req({ requestId: "perm-2" });
    expect(currentRequest([a, b])?.requestId).toBe("perm-1");
  });

  it("shows nothing when nothing is pending", () => {
    expect(currentRequest([])).toBeNull();
  });
});
