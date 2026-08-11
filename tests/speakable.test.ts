/**
 * Tests for the written-to-spoken rewrite.
 *
 * The rule these all serve: **a spoken reply may lose information, but it must
 * never gain a word the user did not write.** Every "must not contain" below is
 * a word Piper was measured saying out loud before this module existed.
 */
import { describe, it, expect } from "vitest";
import { speakable } from "../src/voice/speakable.js";

describe("markup that Piper was measured reading aloud", () => {
  it("does not say 'asterisk'", () => {
    // Measured: "The **battery** is fine" → "ðɪ ˈæstəɹˌɪskɐstəɹˌɪsk bˈætəɹɪ…"
    expect(speakable("The **battery** is fine")).toBe("The battery is fine");
    expect(speakable("*emphasis* here")).toBe("emphasis here");
    expect(speakable("__bold__ and _italic_")).toBe("bold and italic");
    expect(speakable("***all three***")).toBe("all three");
  });

  it("does not say 'hash'", () => {
    // Measured: "## Battery status" → "hˈæʃhæʃ bˈætəɹɪ stˈeɪtəs"
    expect(speakable("## Battery status")).toBe("Battery status.");
    expect(speakable("# One\n\n## Two")).toBe("One. Two.");
  });

  it("does not name emoji out loud", () => {
    // Measured: "✅" → "wˈaɪt hˈɛvɪ tʃˈɛk mˈɑːk" (white heavy check mark).
    const out = speakable("Battery is fine ✅ and charging 🔋");
    expect(out).toBe("Battery is fine and charging");
    expect(speakable("done 🎉️")).toBe("done");
  });

  it("does not say 'tilde' or read table pipes", () => {
    expect(speakable("about ~5 items")).toBe("about 5 items");
    expect(speakable("| CPU | fine |\n|---|---|\n| RAM | fine |")).toBe(
      "CPU, fine. RAM, fine.",
    );
  });
});

describe("pauses that must survive", () => {
  /**
   * The subtle half of the bug. espeak drops some characters *without* leaving
   * a gap, so deleting them welds two words into one non-word. Measured:
   * "One moment… looking now" → "wˈɒn mˈəʊməntlˈʊkɪŋ nˈaʊ".
   */
  it("keeps a boundary where an ellipsis was", () => {
    expect(speakable("One moment… looking now.")).toBe("One moment, looking now.");
    expect(speakable("One moment... looking now.")).toBe("One moment, looking now.");
  });

  it("keeps a boundary where a dash aside was", () => {
    expect(speakable("Battery is fine — charging now")).toBe(
      "Battery is fine, charging now",
    );
  });

  it("turns a paragraph break into a full stop, not a space", () => {
    expect(speakable("First part.\n\nSecond part.")).toBe("First part. Second part.");
  });

  it("keeps a plain wrapped line as one sentence", () => {
    expect(speakable("First sentence\nSecond sentence")).toBe(
      "First sentence Second sentence",
    );
  });

  it("separates list items so they do not run together", () => {
    // "- CPU fine\n- RAM fine" must not become "CPU fineRAM fine".
    expect(speakable("Status:\n- CPU fine\n- RAM fine")).toBe("Status: CPU fine, RAM fine");
    expect(speakable("* first\n* second")).toBe("first, second");
    expect(speakable("1. first\n2. second")).toBe("first, second");
  });
});

describe("what a reply means, kept", () => {
  it("says a link's words and not its URL", () => {
    expect(speakable("See [the docs](https://example.com/x) for more.")).toBe(
      "See the docs for more.",
    );
  });

  it("describes code instead of reciting it", () => {
    // Measured: a fence is read as source — "kˈɒnst ˈɛks ˈiːkwəlz fˈuː dˈɒt bˈɑː".
    expect(speakable("Try this:\n```ts\nconst x = 1;\nreturn x;\n```")).toBe(
      "Try this: (2 lines of code)",
    );
    expect(speakable("```\njust one\n```")).toBe("(one line of code)");
  });

  it("handles a fence the model never closed", () => {
    expect(speakable("Here:\n```ts\nconst x = 1;")).toBe("Here: (one line of code)");
  });

  it("keeps inline code as the word it is", () => {
    expect(speakable("Run `npm test` now.")).toBe("Run npm test now.");
  });

  it("expands an ampersand and an arrow into the words they stand for", () => {
    expect(speakable("Chrome & Edge")).toBe("Chrome and Edge");
    expect(speakable("CPU -> 11%")).toBe("CPU to 11%");
  });
});

describe("what must be left alone", () => {
  /**
   * Measured as already correct. A rule that "fixed" these would make the
   * voice worse, so they are pinned.
   */
  it("leaves ordinary speech byte-identical", () => {
    for (const s of [
      "Volume 62%.",
      "CPU 11%, memory 11.9 of 15.3 gigabytes.",
      "100% and charging.",
      "Opening Google Chrome.",
      "I have 3 things saved.",
    ]) {
      expect(speakable(s), s).toBe(s);
    }
  });

  it("leaves punctuation espeak already reads well", () => {
    expect(speakable("and/or the read/write path")).toBe("and/or the read/write path");
    expect(speakable("battery (charging) is fine")).toBe("battery (charging) is fine");
    expect(speakable("He said “hello” to me")).toBe("He said “hello” to me");
    expect(speakable("Criterion §62 passed")).toBe("Criterion §62 passed");
  });

  it("does not mistake a hyphenated word or a minus sign for a list", () => {
    expect(speakable("the built-in app")).toBe("the built-in app");
    expect(speakable("it fell by -3 degrees")).toBe("it fell by -3 degrees");
  });

  it("keeps a name with an accent", () => {
    // A blanket non-ASCII strip would eat this. The emoji rule is by block.
    expect(speakable("emailing Zoë")).toBe("emailing Zoë");
  });
});

describe("length", () => {
  it("stops at a sentence end and says there is more", () => {
    const long = "This sentence is a reasonable length. ".repeat(60);
    const out = speakable(long);
    expect(out.length).toBeLessThan(1_100);
    expect(out.endsWith("There's more on screen.")).toBe(true);
    // Cut at a sentence, not mid-word.
    expect(out).not.toMatch(/\bsenten\b/);
  });

  it("does not truncate a reply that is merely long-ish", () => {
    const s = "All fine. ".repeat(50).trim();
    expect(speakable(s)).toBe(s);
  });
});

describe("nothing left to say", () => {
  /**
   * The caller treats "" as "do not speak". It must not be reachable by
   * accident from a reply that had words in it, and it must be reachable from
   * one that did not — a lone emoji is a real Hermes reply.
   */
  it("is empty only when there were no words", () => {
    expect(speakable("")).toBe("");
    expect(speakable("   \n\n  ")).toBe("");
    expect(speakable("👍")).toBe("");
    expect(speakable("***")).toBe("");
    expect(speakable("ok")).toBe("ok");
  });
});

describe("a whole reply, as Hermes would write it", () => {
  it("reads as something a person would say", () => {
    const reply = [
      "## Disk check ✅",
      "",
      "I found **3 large files** in `Downloads`:",
      "",
      "- `video.mp4` — 1.2 GB",
      "- `backup.zip` — 800 MB",
      "",
      "Run this to clean up:",
      "```bash",
      "rm -rf ~/Downloads/*.tmp",
      "```",
      "",
      "See [the guide](https://example.com/docs).",
    ].join("\n");

    const out = speakable(reply);

    // Nothing invented.
    for (const word of ["asterisk", "hash", "check mark", "tilde", "backtick"]) {
      expect(out.toLowerCase()).not.toContain(word);
    }
    // Nothing meaningful lost.
    expect(out).toContain("Disk check");
    expect(out).toContain("3 large files");
    expect(out).toContain("video.mp4");
    expect(out).toContain("the guide");
    expect(out).not.toContain("https");
    // The fence's body is one line, so this is the singular form. What matters
    // is that the block is described and not read out as source.
    expect(out).toContain("(one line of code)");
    expect(out).not.toContain("rm -rf");
    // And it is one clean utterance.
    expect(out).not.toMatch(/[*_`#|]/);
    expect(out).not.toMatch(/\n/);
    expect(out).not.toMatch(/ {2}/);
  });
});
