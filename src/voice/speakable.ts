/**
 * Turn a written reply into something a person would say out loud.
 *
 * Jarvis' answers come from two places, and both write for the eye. Hermes
 * replies in markdown because that is what a coding agent emits; Jarvis' own
 * local replies carry paths, percentages and the occasional em dash. Piper
 * synthesises whatever it is handed, so until now the assistant said
 * "asteriskasterisk battery asteriskasterisk" and "white heavy check mark" out
 * loud. That is not a cosmetic complaint — it makes the voice unusable, which
 * is the one thing this project cannot afford (§75: reliability, then real-time,
 * then voice).
 *
 * **Every rule here was measured, not guessed.** Piper phonemises through
 * espeak-ng, so what it will say is observable before a single sample is
 * played. Running the real voice over the real cases gave, among others:
 *
 *   "The **battery** is fine"   → "ðɪ ˈæstəɹˌɪskɐstəɹˌɪsk bˈætəɹɪ …"
 *   "## Battery status"         → "hˈæʃhæʃ bˈætəɹɪ stˈeɪtəs"
 *   "fine ✅ and charging"      → "fˈaɪn wˈaɪt hˈɛvɪ tʃˈɛk mˈɑːk ænd …"
 *   "about ~5 items"            → "ɐbˌaʊt tˈɪldɐ fˈaɪv ˈaɪtəmz"
 *   "One moment… looking now"   → "wˈɒn mˈəʊməntlˈʊkɪŋ nˈaʊ"   ← words welded
 *
 * The last one is the subtle half of the bug and the reason this module does
 * not simply delete punctuation: espeak drops "…" **without leaving a gap**, so
 * two sentences run together into one non-word. Several characters behave that
 * way. Where a symbol carries a pause, it is replaced by punctuation that keeps
 * the pause rather than by nothing.
 *
 * Equally deliberate is what is **left alone**. Measurement showed espeak
 * already handles these well, and "improving" them would make speech worse:
 *
 *   "and/or"        → "and slash or"     — genuinely how it is read aloud
 *   "battery (ok)"  → "battery ok"       — parens are already silent
 *   "§62"           → "section sixty two"
 *   "- [x] done"    → "ex done"
 *   "`npm test`"    → backticks already silent
 *   "2^3"           → "two three"
 *
 * The guiding rule: **a spoken reply may lose information, but it may never
 * gain a word the user did not write.** Dropping a table's pipes is fine.
 * Inventing "asterisk" is not.
 *
 * @see docs/PERFORMANCE.md for the synthesis latency this sits in front of.
 */

/**
 * Emoji, symbols, dingbats, flags and the variation selectors that follow them.
 *
 * Not a "strip everything non-ASCII" rule, which would eat accented names and
 * the em dash handled properly below. These are the blocks espeak-ng reads out
 * by their Unicode *names* — "white heavy check mark" for ✅ — which is the
 * failure being fixed.
 */
const PICTOGRAPHS =
  /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}]/gu;

/** A fenced code block, including an unterminated one at the end of a reply. */
const CODE_FENCE = /```[\s\S]*?(?:```|$)/g;

/** How much of a reply is worth speaking before it becomes a monologue. */
const MAX_SPOKEN_CHARS = 1_000;

/**
 * Describe a code block rather than reciting it.
 *
 * Reading source aloud is never useful — "const ex equals foo dot bar open
 * paren one comma two" tells nobody anything, and it is exactly the case where
 * a reply is longest. The user has the HUD for the code; the voice says that
 * there is some.
 */
function describeFence(block: string): string {
  const lines = block.replace(/```/g, "").split("\n").filter((l) => l.trim());
  // The first line of a fence is usually the language, not code.
  const body = lines.length > 1 ? lines.slice(1) : lines;
  const n = body.length;
  if (n === 0) return " ";
  return n === 1 ? " (one line of code) " : ` (${n} lines of code) `;
}

/**
 * Rewrite a written reply for synthesis.
 *
 * Returns "" when nothing sayable is left — the caller must treat that as "do
 * not speak" rather than as an empty utterance, or the turn wedges waiting for
 * a `speaking_done` that never comes.
 */
export function speakable(text: string): string {
  let s = text;

  // 1. Code first, before any markdown rule can mangle its contents.
  s = s.replace(CODE_FENCE, describeFence);

  // 2. Structures that carry a sentence boundary. Each becomes punctuation
  //    rather than nothing, because espeak needs a mark to place the pause —
  //    deleting them welds the neighbouring words together.
  s = s
    .replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, "$1.")           // heading → sentence
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, ".")           // horizontal rule
    .replace(/^\s*>\s?/gm, "")                             // blockquote marker
    .replace(/^\s*[-*+]\s+/gm, ", ")                       // bullet → brief pause
    .replace(/^\s*\d+[.)]\s+/gm, ", ");                    // numbered item

  // 3. Tables. The pipes are furniture; the cells are the content.
  //    Horizontal whitespace only, never `\s`: `\s` matches newlines, so a
  //    class like `[\s:|-]*` eats the line break the separator row leaves
  //    behind and welds the rows into "CPU, fine.RAM, fine." — measured.
  s = s
    .replace(/^[ \t]*\|?[ \t:|-]*\|[ \t:|-]*$/gm, "")      // separator row
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) =>
      row.split("|").map((c) => c.trim()).filter(Boolean).join(", ") + ".");

  // 4. Inline markers. Ordered longest-first so ** is gone before * is seen.
  s = s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")              // image → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")               // link → its words
    .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1");                // inline code

  // 5. Leftover markup characters that survived because they were unpaired.
  //    A stray "*" or "#" is read as a word, so it goes; it never carries a
  //    pause, so nothing replaces it.
  s = s.replace(/[*_`#|~^]/g, "");

  // 6. Symbols espeak names aloud or swallows silently.
  s = s
    .replace(PICTOGRAPHS, " ")
    .replace(/\.{3}|…/g, ", ")                             // keeps the pause
    .replace(/\s*[-–—]{1,3}\s+/g, ", ")                    // dash aside → comma
    .replace(/\s*(?:->|=>|→)\s*/g, " to ")                 // "CPU -> 11%"
    .replace(/&/g, " and ");

  // 7. Whitespace. A blank line is a paragraph break and deserves a full stop;
  //    a single newline inside one is just a wrap.
  s = s
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/[ \t]{2,}/g, " ");

  // 8. Tidy the punctuation this function itself created. Without this a
  //    bulleted list under a heading says "status dot comma CPU fine" — the
  //    bullet's comma lands directly after the lead-in line's own terminator,
  //    so a stronger mark always absorbs the comma this module added.
  s = s
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:!?])\1+/g, "$1")
    .replace(/([.;:!?])\s*,/g, "$1")
    .replace(/,\s*\./g, ".")
    .replace(/^[\s,.;:]+/, "")
    .trim();

  if (s.length > MAX_SPOKEN_CHARS) s = truncateAtSentence(s, MAX_SPOKEN_CHARS);
  return s;
}

/**
 * Cut a long reply at a sentence end rather than mid-word.
 *
 * Long answers are read on screen, not listened to. Stopping cleanly and
 * saying so is better than either reciting three paragraphs at someone or
 * halting in the middle of a clause as though the process died.
 */
function truncateAtSentence(s: string, limit: number): string {
  const head = s.slice(0, limit);
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  const kept = cut > limit * 0.5 ? head.slice(0, cut + 1) : head.replace(/\s+\S*$/, "") + ".";
  return `${kept} There's more on screen.`;
}
