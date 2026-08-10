import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSkills,
  parseFrontmatter,
  summariseSkills,
  type Skill,
} from "../src/memory/skill-catalog.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jarvis-skills-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Write a SKILL.md at `rel`, with CRLF line endings like the real files. */
function skill(rel: string, body: string): void {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body.replace(/\n/g, "\r\n"), "utf8");
}

const named = (skills: readonly Skill[]): string[] => skills.map((s) => s.name).sort();

describe("frontmatter", () => {
  it("parses a double-quoted description through CRLF line endings", () => {
    // The bug this exists for: `.` excludes `\r`, so the stray `\r` left by the
    // closing `\n---` made the *last* field silently unparseable — 15 of the
    // 102 installed skills lost their description to it.
    const fm = parseFrontmatter('---\r\nname: thing\r\ndescription: "does a thing"\r\n---\r\nbody');
    expect(fm).toEqual({ name: "thing", description: "does a thing" });
  });

  it("gathers a folded block rather than reporting the marker as the value", () => {
    // `computer-use` and `mlops/ml-model-porting` really do use these.
    const literal = parseFrontmatter("---\nname: a\ndescription: |\n  first line\n  second line\n---\n");
    expect(literal.description).toBe("first line second line");

    const folded = parseFrontmatter("---\nname: b\ndescription: >\n  wrapped text\n---\n");
    expect(folded.description).toBe("wrapped text");
  });

  it("returns nothing for a file with no frontmatter or no closing fence", () => {
    expect(parseFrontmatter("# just a heading")).toEqual({});
    expect(parseFrontmatter("---\nname: unterminated\n")).toEqual({});
  });
});

describe("scanning", () => {
  it("finds skills at one, two and three levels down", () => {
    // The measured layout: a two-level glob would miss both ends of this.
    skill("computer-use", "---\nname: computer-use\ndescription: drives the desktop\n---\n");
    skill("creative/songwriting", "---\nname: songwriting\ndescription: writes songs\n---\n");
    skill("mlops/inference/vllm", "---\nname: vllm\ndescription: serves models\n---\n");

    const found = loadSkills(root, join(root, "does-not-exist"));
    expect(named(found)).toEqual(["computer-use", "songwriting", "vllm"]);
  });

  it("reports the category a skill sits in, not its own directory", () => {
    skill("computer-use", "---\nname: computer-use\ndescription: d\n---\n");
    skill("mlops/inference/vllm", "---\nname: vllm\ndescription: d\n---\n");

    const found = loadSkills(root, join(root, "none"));
    const by = new Map(found.map((s) => [s.name, s.category]));
    // Including the skill's own name here gave every skill a category of one.
    expect(by.get("vllm")).toBe("mlops/inference");
    expect(by.get("computer-use")).toBe("");
  });

  it("ignores excluded directories and support dirs inside a skill", () => {
    skill("real/thing", "---\nname: thing\ndescription: d\n---\n");
    // An archived package under references/ is documentation, not a live skill.
    skill("real/thing/references/old-pkg", "---\nname: old-pkg\ndescription: d\n---\n");
    skill(".archive/retired", "---\nname: retired\ndescription: d\n---\n");
    skill("node_modules/vendored", "---\nname: vendored\ndescription: d\n---\n");

    expect(named(loadSkills(root, join(root, "none")))).toEqual(["thing"]);
  });

  it("keeps a category legitimately called scripts", () => {
    // Support dirs are pruned only when the parent is itself a skill root —
    // the same distinction Hermes makes.
    skill("scripts/deploy-helper", "---\nname: deploy-helper\ndescription: d\n---\n");
    expect(named(loadSkills(root, join(root, "none")))).toEqual(["deploy-helper"]);
  });

  it("falls back to the directory name when frontmatter omits one", () => {
    skill("misc/unnamed", "---\ndescription: has no name field\n---\n");
    const found = loadSkills(root, join(root, "none"));
    expect(found[0]?.name).toBe("unnamed");
    expect(found[0]?.description).toBe("has no name field");
  });

  it("sanitises a description that tries to hide what it says", () => {
    // §52: skill files can arrive from a registry, and this text is read aloud
    // and may reach a prompt. Bidi and zero-width characters let rendered text
    // differ from actual text.
    skill("x/sneaky", '---\nname: sneaky\ndescription: "safe‮eslaf"\n---\n');
    const d = loadSkills(root, join(root, "none"))[0]?.description ?? "";
    expect(d).not.toMatch(/[‪-‮​-‏]/);
  });

  it("returns nothing for a root that is not there", () => {
    expect(loadSkills(join(root, "nope"), join(root, "also-nope"))).toEqual([]);
  });
});

describe("user skills shadow bundled ones", () => {
  it("keeps the user's copy, since that is the one Hermes loads", () => {
    const bundled = mkdtempSync(join(tmpdir(), "jarvis-bundled-"));
    try {
      mkdirSync(join(bundled, "cat", "dup"), { recursive: true });
      writeFileSync(
        join(bundled, "cat", "dup", "SKILL.md"),
        "---\nname: dup\ndescription: the shipped one\n---\n",
        "utf8",
      );
      skill("cat/dup", "---\nname: dup\ndescription: the user's own\n---\n");

      const found = loadSkills(root, bundled);
      expect(found).toHaveLength(1);
      expect(found[0]?.description).toBe("the user's own");
      expect(found[0]?.source).toBe("user");
    } finally {
      rmSync(bundled, { recursive: true, force: true });
    }
  });
});

describe("summarising", () => {
  it("counts by category, largest first, with top-level skills as general", () => {
    skill("a/one", "---\nname: one\ndescription: d\n---\n");
    skill("a/two", "---\nname: two\ndescription: d\n---\n");
    skill("b/three", "---\nname: three\ndescription: d\n---\n");
    skill("loose", "---\nname: loose\ndescription: d\n---\n");

    expect(summariseSkills(loadSkills(root, join(root, "none")))).toEqual([
      { category: "a", count: 2 },
      { category: "b", count: 1 },
      { category: "general", count: 1 },
    ]);
  });
});
