import { describe, it, expect } from "vitest";
import {
  buildCatalog,
  catalogMaps,
  aliasesFor,
  defaultStartMenuRoots,
  type ReadDir,
} from "../src/system/app-catalog.js";
import { matchIntent } from "../src/local-intents/intent-model.js";

/** A Start Menu as it actually looks, folders and all. */
const TREE: Record<string, readonly string[]> = {
  "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs": [
    "Spotify.lnk",
    "Visual Studio Code",
    "Steam",
  ],
  "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Visual Studio Code": [
    "Visual Studio Code.lnk",
    "Uninstall Visual Studio Code.lnk",
  ],
  "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Steam": [
    "Steam.lnk",
    "Steam Support Center.url",
    "readme.txt",
  ],
  "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs": ["Firefox.lnk", "Settings.lnk"],
};

const readDir: ReadDir = (dir) => {
  const entry = TREE[dir];
  if (!entry) throw new Error(`ENOENT: ${dir}`);
  return entry;
};

const ROOTS = [
  "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs",
  "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
];

const build = () => buildCatalog({ startMenuRoots: ROOTS, readDir });

describe("discovery", () => {
  it("finds shortcuts nested in publisher folders", () => {
    const keys = build().map((e) => e.key);
    expect(keys).toContain("spotify");
    expect(keys).toContain("visual studio code");
    expect(keys).toContain("steam");
    expect(keys).toContain("firefox");
  });

  it("drops shortcuts nobody asks for by name", () => {
    // "open uninstall" resolving to a live uninstaller is a bad voice outcome.
    const keys = build().map((e) => e.key);
    expect(keys).not.toContain("uninstall visual studio code");
  });

  it("skips website shortcuts, which are not applications", () => {
    // A .url opens a browser at a remote address. That is a different action
    // from starting an app and must not hide behind "open X".
    expect(build().some((e) => e.key.includes("support center"))).toBe(false);
  });

  it("ignores files that are not shortcuts", () => {
    expect(build().some((e) => e.key.includes("readme"))).toBe(false);
  });

  it("treats a missing Start Menu root as normal, not an error", () => {
    const entries = buildCatalog({ startMenuRoots: ["C:\\nope"], readDir });
    // Built-ins survive; discovery simply adds nothing.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.source === "builtin")).toBe(true);
  });

  it("returns only built-ins when no reader is supplied", () => {
    expect(buildCatalog().every((e) => e.source === "builtin")).toBe(true);
  });

  it("bounds the catalog size", () => {
    const many = Array.from({ length: 900 }, (_, i) => `App${i}.lnk`);
    const entries = buildCatalog({
      startMenuRoots: ["X:\\menu"],
      readDir: (d) => (d === "X:\\menu" ? many : []),
      limit: 50,
    });
    expect(entries.length).toBeLessThanOrEqual(50);
  });

  it("does not follow a junction loop forever", () => {
    // Bounded depth, because this runs at startup and hanging means Jarvis
    // never comes up.
    const loop: ReadDir = (d) => (d.length > 400 ? [] : ["sub"]);
    expect(() => buildCatalog({ startMenuRoots: ["C:\\loop"], readDir: loop })).not.toThrow();
  });
});

describe("launch specs", () => {
  it("hands the shortcut itself to the shell rather than a parsed target", () => {
    // Resolving a .lnk would mean trusting an executable path read off disk.
    const spotify = build().find((e) => e.key === "spotify")!;
    expect(spotify.launch).toEqual({
      kind: "exec",
      file: "explorer.exe",
      args: ["C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Spotify.lnk"],
    });
  });

  it("addresses built-in Windows apps the way Windows wants", () => {
    const byKey = new Map(build().map((e) => [e.key, e]));
    expect(byKey.get("settings")?.launch).toEqual({ kind: "uri", uri: "ms-settings:" });
    expect(byKey.get("notepad")?.launch).toEqual({ kind: "exec", file: "notepad.exe" });
  });

  it("lets a built-in keep its name against a shortcut of the same name", () => {
    // The ProgramData tree also has a "Settings.lnk". The built-in must win,
    // or an arbitrary shortcut captures the word "settings".
    const settings = build().filter((e) => e.key === "settings");
    expect(settings).toHaveLength(1);
    expect(settings[0]?.source).toBe("builtin");
  });
});

describe("aliases", () => {
  it("keeps the spoken name and strips installer noise", () => {
    expect(aliasesFor("Spotify")).toContain("spotify");
    expect(aliasesFor("7-Zip (x64)")).toContain("7-zip");
    expect(aliasesFor("Blender 4.2")).toContain("blender");
  });

  it("adds initials only when a name is genuinely multi-word", () => {
    expect(aliasesFor("Visual Studio Code")).toContain("vsc");
    // "File Explorer" → "fe" is not something anyone says.
    expect(aliasesFor("File Explorer")).not.toContain("fe");
  });

  it("drops the vendor word people do not say", () => {
    // §63's own wording is "Open Chrome", and a Start Menu holds "Google
    // Chrome". Before this, that command reached the agent — a slow model turn
    // for something the catalog already knew.
    expect(aliasesFor("Google Chrome")).toContain("chrome");
    expect(aliasesFor("Mozilla Firefox")).toContain("firefox");
    expect(aliasesFor("Microsoft Edge")).toContain("edge");
    // The full name never stops working.
    expect(aliasesFor("Google Chrome")).toContain("google chrome");
  });

  it("keeps a vendor word that is part of the name", () => {
    // Not a blanket first-word strip: these would become different products.
    expect(aliasesFor("Windows Terminal")).not.toContain("terminal");
    expect(aliasesFor("Visual Studio Code")).not.toContain("studio code");
  });

  it("initialises a leading suite name, which is how it is said", () => {
    // §63's other command is "Open VS Code".
    expect(aliasesFor("Visual Studio Code")).toContain("vs code");
    // Two words give no head worth initialising — "f explorer" is nonsense.
    expect(aliasesFor("File Explorer")).not.toContain("f explorer");
  });

  it("never invents an alias that collides by mere similarity", () => {
    // No fuzzy distance anywhere: "steam" must not reach "settings".
    const { aliases } = catalogMaps(build());
    const r = matchIntent("open steam", { apps: aliases });
    expect(r.kind === "match" && r.slots.app).toBe("steam");
  });

  it("gives a contested alias to nobody rather than to whoever was scanned first", () => {
    // Two browsers both generating "chrome". `resolveApp` returns the first
    // match, so without a guard the winner would be decided by directory
    // iteration order — a silent wrong-app launch, which is worse than an
    // utterance that reaches an agent able to ask which one was meant.
    const tree: Record<string, readonly string[]> = {
      R: ["Google Chrome.lnk", "Chrome Remote Desktop.lnk"],
    };
    const entries = buildCatalog({
      startMenuRoots: ["R"],
      readDir: (d) => tree[d] ?? [],
    });
    const claimants = entries.filter((e) => e.aliases.includes("chrome"));
    expect(claimants).toHaveLength(1);
    expect(claimants[0]?.key).toBe("google chrome");

    // And the loser keeps its own full name, so it is still reachable.
    const other = entries.find((e) => e.key === "chrome remote desktop");
    expect(other?.aliases).toContain("chrome remote desktop");
  });

  it("lets a built-in keep a word a shortcut would otherwise take", () => {
    // "Microsoft Terminal Preview" strips to "terminal", which the built-in
    // Windows Terminal already answers to. Built-ins are added first, so the
    // guard protects them by construction — asserted, not assumed.
    const tree: Record<string, readonly string[]> = {
      R: ["Microsoft Terminal Preview.lnk"],
    };
    const entries = buildCatalog({
      startMenuRoots: ["R"],
      readDir: (d) => tree[d] ?? [],
    });
    const owner = entries.filter((e) => e.aliases.includes("terminal"));
    expect(owner).toHaveLength(1);
    expect(owner[0]?.source).toBe("builtin");
  });
});

describe("the maps the rest of the system consumes", () => {
  it("derives both maps over exactly the same key set", () => {
    // A matcher key the executor lacks would look like understanding followed
    // by "I don't know how to open that".
    const { aliases, apps } = catalogMaps(build());
    expect([...aliases.keys()].sort()).toEqual([...apps.keys()].sort());
  });

  it("resolves a real utterance end to end", () => {
    const { aliases, apps } = catalogMaps(build());
    const r = matchIntent("open visual studio code", { apps: aliases });
    expect(r.kind).toBe("match");
    const key = r.kind === "match" ? r.slots.app : undefined;
    expect(key).toBe("visual studio code");
    expect(apps.get(key!)?.name).toBe("Visual Studio Code");
  });

  it("sends an app that is not installed to the agent", () => {
    const { aliases } = catalogMaps(build());
    expect(matchIntent("open photoshop", { apps: aliases }).kind).toBe("none");
  });
});

describe("Start Menu roots", () => {
  it("uses both the per-user and the machine-wide tree", () => {
    const roots = defaultStartMenuRoots({
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
      ProgramData: "C:\\ProgramData",
    } as NodeJS.ProcessEnv);
    expect(roots).toEqual([
      "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs",
      "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
    ]);
  });

  it("skips a root whose variable is not set rather than guessing a path", () => {
    expect(defaultStartMenuRoots({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});
