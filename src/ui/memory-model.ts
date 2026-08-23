/**
 * Presentation rules for the Memory page, separate from React so they can be
 * tested without a DOM — the same split as `hud-model` and `mission-model`.
 *
 * This is the window where a person finds out what Jarvis knows about them and
 * takes it away again, so the rules it must not break are about not overstating
 * what is there:
 *
 * **Similarity is described as what it is.** When no embedding model is
 * configured, the index is a local lexical hash: it generalises over word forms and
 * typos and knows nothing about meaning. The page says that in those words. Calling
 * it semantic search would claim a capability the process does not have (§43).
 *
 * **Off is shown as a switch, not as emptiness.** A store the user has switched off
 * still has everything in it. The page says the layer is off *and* how much is
 * sitting behind the switch, because "off" and "empty" are different answers to
 * "what do you know about me".
 *
 * **A suggestion is not a memory.** Proposals are rendered in their own section,
 * described as offered and not kept, with the provenance line the runtime supplied.
 * Nothing here can accept one without a click.
 *
 * **A refusal is not an error.** `screenMemory` declining a token-shaped sentence is
 * the subsystem working; the page shows the reason as a notice, in the words the
 * spoken path would have used, and leaves the link alone.
 *
 * **An episode with a hole in it says so.** `redacted` means something
 * credential-shaped was removed on the way in, and a row that hid that would be
 * presenting a partial record as a complete one.
 */
import { sanitiseForDisplay } from "../permissions/risk-model";
import { FORGET_EVERYTHING, type MemoryView, type MemoryWriteResult } from "../ipc/contract";
import { describeWhen } from "./command-model";

/** A memory is the user's own note, so it is shown whole up to a sane ceiling. */
const MAX_ENTRY = 600;
const MAX_LINE = 200;

export type Status = "loading" | "ready" | "failed";

/** What the page has just been told, in the words the runtime used. */
export interface Notice {
  text: string;
  /** `refused` is a legitimate outcome the user asked for and did not get. */
  tone: "ok" | "refused";
}

export interface MemoryScreen {
  view: MemoryView | null;
  status: Status;
  /** Set only when the *link* failed. A refused write is a `notice`, not this. */
  error: string | null;
  notice: Notice | null;
}

export const emptyScreen: MemoryScreen = {
  view: null,
  status: "loading",
  error: null,
  notice: null,
};

export function loaded(screen: MemoryScreen, view: MemoryView): MemoryScreen {
  return { ...screen, view, status: "ready", error: null };
}

/**
 * The link, or the request, failed.
 *
 * The last view is kept. A broken pipe says nothing about what was in the store a
 * second ago, and blanking the page would replace a true list with no list.
 */
export function failedToLoad(screen: MemoryScreen, error: string): MemoryScreen {
  return { ...screen, status: "failed", error: sanitiseForDisplay(error, MAX_LINE) };
}

/**
 * Fold one write's answer into the screen.
 *
 * The whole view is replaced from the result rather than patched from it, which is
 * why every write carries one: a page that edited its own list would disagree with
 * the store the first time a write was partly refused.
 *
 * `null` means main declined to send the request at all — a validation this page
 * should have prevented. Reported rather than swallowed, because a button that
 * silently does nothing is the worst of the three outcomes.
 */
export function applyResult(
  screen: MemoryScreen,
  result: MemoryWriteResult | null,
): MemoryScreen {
  if (!result) {
    return {
      ...screen,
      notice: { text: "that request was not accepted", tone: "refused" },
    };
  }
  return {
    view: result.memory,
    status: "ready",
    error: null,
    notice: {
      text: sanitiseForDisplay(result.speech, MAX_LINE),
      tone: result.saved ? "ok" : "refused",
    },
  };
}

export function dismissNotice(screen: MemoryScreen): MemoryScreen {
  return screen.notice === null ? screen : { ...screen, notice: null };
}

// --- memories --------------------------------------------------------------

export interface EntryRow {
  id: string;
  text: string;
  when: string;
  /** Present only when the text was changed after it was first saved. */
  edited?: string;
}

/**
 * The memories, newest first.
 *
 * Newest first because the question this page answers is "what have you just
 * learned about me", and `at` stays the moment it was first said even after an
 * edit — so a fixed typo does not jump a three-month-old note to the top.
 */
export function toEntryRows(view: MemoryView, now: number, locale?: string): EntryRow[] {
  return view.entries
    .map((e) => ({
      id: e.id,
      text: sanitiseForDisplay(e.text, MAX_ENTRY),
      when: describeWhen(e.at, now, locale),
      ...(e.editedAt !== undefined
        ? { edited: `edited ${describeWhen(e.editedAt, now, locale)}` }
        : {}),
    }))
    .reverse();
}

/** Both caps, because characters bind long before the row count does. */
export function storeLine(view: MemoryView): string {
  return (
    `${view.entries.length} of ${view.maxEntries} memories, ` +
    `${view.chars.toLocaleString()} of ${view.maxChars.toLocaleString()} characters`
  );
}

// --- the switch ------------------------------------------------------------

export interface EnabledLook {
  on: boolean;
  label: string;
  /** The sentence under the switch. Says what off does, and what it does not do. */
  detail: string;
}

/**
 * The off switch, described so that nobody expects it to delete anything.
 *
 * When it is off the page still says how much is behind it: a user deciding whether
 * to turn it back on is entitled to know whether there is anything there, and an
 * empty-looking page would answer that question wrongly.
 */
export function enabledLook(view: MemoryView): EnabledLook {
  const held =
    view.entries.length + view.profile.filter((f) => f.value !== undefined).length +
    view.episodeCount;
  const scope = view.enabledIsSession
    ? " This is for this session only — config.json is what outlives a restart."
    : "";
  if (!view.enabled) {
    return {
      on: false,
      label: "Memory is off",
      detail:
        `Nothing is being read: no memory, no profile field and no episode reaches a plan or a ` +
        `prompt. Nothing has been deleted either — ${held} thing${held === 1 ? "" : "s"} ` +
        `${held === 1 ? "is" : "are"} still here, waiting for you to switch it back on.${scope}`,
    };
  }
  return {
    on: true,
    label: "Memory is on",
    detail:
      "What is here is retrieved before a mission plans, fenced as data, and cited on the " +
      `plan rather than obeyed as an instruction.${scope}`,
  };
}

// --- profile ---------------------------------------------------------------

export interface ProfileRow {
  key: string;
  label: string;
  hint: string;
  max: number;
  /** The empty string when the field is not filled in, so an input can bind to it. */
  value: string;
  filled: boolean;
  /** How it got here, in words. Absent when the field is empty. */
  provenance?: string;
}

/**
 * All eight fields, filled or not.
 *
 * The empty ones travel because they are half the answer to "what do you keep about
 * me": a page that listed only what it had would leave the user unable to see that
 * the vocabulary is eight slots and not an open-ended dossier.
 */
export function toProfileRows(view: MemoryView, now: number, locale?: string): ProfileRow[] {
  return view.profile.map((f) => {
    const filled = f.value !== undefined && f.value !== "";
    return {
      key: f.key,
      label: sanitiseForDisplay(f.label, 60),
      hint: sanitiseForDisplay(f.hint, MAX_LINE),
      max: f.max,
      value: filled ? sanitiseForDisplay(f.value!, f.max) : "",
      filled,
      ...(filled
        ? {
            provenance: `${
              f.source === "confirmed" ? "you confirmed a suggestion" : "you told me"
            }${f.at !== undefined ? ` — ${describeWhen(f.at, now, locale)}` : ""}`,
          }
        : {}),
    };
  });
}

// --- episodes --------------------------------------------------------------

export type EpisodeTone = "good" | "bad" | "waiting" | "muted";

export interface EpisodeRow {
  id: string;
  title: string;
  outcome: string;
  tone: EpisodeTone;
  when: string;
  detail?: string;
  /** Joined for display; the wire keeps them as a list. */
  tools?: string;
  duration?: string;
  /** Present only when something credential-shaped was removed on the way in. */
  redacted?: string;
}

/**
 * How a recorded outcome reads.
 *
 * `completed` is the only good one, and an outcome this build does not recognise is
 * `muted` rather than either — an unknown word is not evidence of success, and
 * guessing it was a failure would put a red row under something that went fine.
 */
const OUTCOME_TONE: Record<string, EpisodeTone> = {
  completed: "good",
  failed: "bad",
  blocked: "waiting",
  cancelled: "muted",
};

export function episodeTone(outcome: string): EpisodeTone {
  return OUTCOME_TONE[outcome] ?? "muted";
}

export function toEpisodeRows(view: MemoryView, now: number, locale?: string): EpisodeRow[] {
  return view.episodes.map((e) => ({
    id: e.id,
    title: sanitiseForDisplay(e.title, MAX_LINE),
    outcome: sanitiseForDisplay(e.outcome, 40),
    tone: episodeTone(e.outcome),
    when: describeWhen(e.at, now, locale),
    ...(e.detail !== undefined ? { detail: sanitiseForDisplay(e.detail, 400) } : {}),
    ...(e.tools && e.tools.length > 0
      ? { tools: e.tools.map((t) => sanitiseForDisplay(t, 40)).join(", ") }
      : {}),
    ...(e.durationMs !== undefined ? { duration: describeSpan(e.durationMs) } : {}),
    // Said on the row rather than in a footnote. A record with something removed
    // from it is a different record, and the user is the only one who can judge
    // whether the hole matters.
    ...(e.redacted === true
      ? { redacted: "something that looked like a secret was removed before this was saved" }
      : {}),
  }));
}

/** Kept local rather than imported, so this file has one shape of duration. */
function describeSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

/** How much history there is, against how much of it travelled. */
export function episodeLine(view: MemoryView): string {
  if (view.episodeCount === 0) return "Nothing recorded yet.";
  if (view.episodes.length >= view.episodeCount) {
    return `${view.episodeCount} recorded.`;
  }
  return `Showing the newest ${view.episodes.length} of ${view.episodeCount} recorded.`;
}

// --- suggestions -----------------------------------------------------------

export interface ProposalRow {
  id: string;
  text: string;
  /** The provenance the runtime supplied. Never a model's account of itself (§45). */
  why: string;
  /** What accepting it would do, named exactly. */
  target: string;
  when: string;
}

export function toProposalRows(view: MemoryView, now: number, locale?: string): ProposalRow[] {
  return view.proposals.map((p) => ({
    id: p.id,
    text: sanitiseForDisplay(p.text, MAX_ENTRY),
    why: sanitiseForDisplay(p.why, MAX_LINE),
    target:
      p.kind === "profile" && p.key
        ? `would fill in your ${sanitiseForDisplay(p.key, 40)}`
        : "would be saved as a memory",
    when: describeWhen(p.at, now, locale),
  }));
}

/** The line above the list, which has to say that none of it has been stored. */
export function proposalLine(view: MemoryView): string {
  const n = view.proposals.length;
  if (n === 0) return "Jarvis is not offering to remember anything right now.";
  return (
    `${n} thing${n === 1 ? "" : "s"} Jarvis is offering to remember. ` +
    `None of ${n === 1 ? "it" : "them"} has been saved.`
  );
}

// --- similarity ------------------------------------------------------------

export interface EmbedderLook {
  /** True only when a real embedding model is behind the vectors. */
  semantic: boolean;
  label: string;
  detail: string;
  /** The runtime's own sentence, printed verbatim. */
  reason: string;
}

/**
 * What similarity search actually is, in this run.
 *
 * The distinction is the whole point of putting this on screen. With an embedding
 * model configured, "the thing I said about deployment" can find a note that used
 * none of those words. Without one, the index is a lexical hash — it survives typos
 * and word endings and nothing else — and a page that called that semantic would be
 * describing software the user does not have.
 */
export function embedderLook(view: MemoryView): EmbedderLook | null {
  const e = view.embedder;
  if (!e) return null;
  return {
    semantic: e.semantic,
    label: e.semantic ? "Semantic search" : "Lexical similarity",
    detail: e.semantic
      ? `${e.rows} row${e.rows === 1 ? "" : "s"} indexed as ${e.dims}-dimension embeddings, ` +
        "so a search can match meaning rather than words."
      : `${e.rows} row${e.rows === 1 ? "" : "s"} indexed by a local ${e.dims}-dimension word ` +
        "hash. It matches wording, not meaning — no embedding model is configured.",
    reason: sanitiseForDisplay(e.reason, MAX_LINE),
  };
}

// --- deleting everything ---------------------------------------------------

/** The phrase the runtime insists on, so the page asks for exactly that. */
export const CONFIRM_PHRASE = FORGET_EVERYTHING;

/**
 * Whether what the user typed is the confirmation.
 *
 * Compared after trimming and case-folding, and no further: a phrase is a
 * deliberate act, and matching "forget" or "everything" on its own would defeat the
 * reason this is not a boolean.
 */
export function confirmsForgetEverything(typed: string): boolean {
  return typed.trim().toLowerCase() === CONFIRM_PHRASE;
}

/**
 * What deleting everything would actually delete, counted before it happens.
 *
 * Shown on the button's own confirmation, because "forget everything" is the one
 * irreversible action here and a number is what makes it real.
 */
export function forgetEverythingSummary(view: MemoryView): string {
  const profile = view.profile.filter((f) => f.value !== undefined).length;
  const parts = [
    `${view.entries.length} memor${view.entries.length === 1 ? "y" : "ies"}`,
    `${view.episodeCount} episode${view.episodeCount === 1 ? "" : "s"}`,
    `${profile} profile field${profile === 1 ? "" : "s"}`,
    `${view.proposals.length} pending suggestion${view.proposals.length === 1 ? "" : "s"}`,
  ];
  return `This deletes ${parts.join(", ")} and the search index. It cannot be undone.`;
}

/** The message for a section with nothing in it, which is not the same as an error. */
export function emptyMessage(screen: MemoryScreen, connected: boolean): string | null {
  if (screen.view) return null;
  if (!connected) return "Not connected to the runtime.";
  if (screen.status === "failed") return screen.error ?? "That could not be read.";
  return "Reading…";
}
