/**
 * Presentation rules for what Jarvis can see, and for what it is offering to do.
 *
 * Separate from React for the reason `mission-model` is: these rules are the
 * difference between a page that reports and a page that flatters, and they are
 * worth testing without a DOM.
 *
 * Three of them are load-bearing:
 *
 * **An edge is never drawn without its reason.** `basis` is required on the wire and
 * required here, and `edgeRows` puts it in the row rather than in a tooltip. A graph
 * of confident lines with no visible derivation is a machine telling a user about
 * their own life and asking to be believed.
 *
 * **A steerable derivation says so, in words.** An edge that came out of a window
 * title or a job name — text something other than the user chose — carries a mark and
 * a sentence (§52). "You are working on this" and "a web page mentioned this" look
 * identical once the reason is dropped, and only one of them is a fact about the user.
 *
 * **A suggestion is shown with its evidence, or not at all.** `suggestionCards` keeps
 * every `because` line. A proposal whose evidence is truncated to fit is one the user
 * accepts on trust, which is the thing this whole subsystem is arranged to avoid.
 *
 * Nothing here is invented: no relevance score, no "probably", no ranking beyond the
 * order the runtime already put things in.
 */
import { sanitiseForDisplay } from "../permissions/risk-model";
import type {
  ProactiveProposalView,
  ServerEvent,
  WorldEdgeView,
  WorldEntityView,
  WorldView,
} from "../ipc/contract";

const MAX_TEXT = 200;

/** Entity kinds, in the order the panel groups them. */
export const KIND_ORDER = ["project", "app", "window", "task", "mission"] as const;

const KIND_LABEL: Record<string, string> = {
  project: "Projects",
  app: "Apps",
  window: "Foreground window",
  task: "Scheduled jobs",
  mission: "Missions",
};

/** Human words for each edge kind. The verb, not the identifier. */
const EDGE_LABEL: Record<string, string> = {
  worked_on: "worked on",
  focused: "appears to be about",
  window_of: "is a window of",
  scheduled_in: "is scheduled against",
};

export interface WorldScreen {
  view: WorldView | null;
  /** True once an answer arrived, so "nothing yet" and "nothing to show" differ. */
  asked: boolean;
  /** Suggestions pushed since the last full view, newest first. */
  pushed: ProactiveProposalView[];
  /** The last refusal from a resolve, shown verbatim. */
  error: string | null;
}

export const emptyWorld: WorldScreen = { view: null, asked: false, pushed: [], error: null };

/**
 * Fold one runtime event into the screen.
 *
 * Only `proactive` matters here, and it is *added* rather than triggering a re-ask:
 * a suggestion arrives while a mission is finishing, and re-assembling the graph on
 * a push would mean every mission ended with the page doing work nobody asked for.
 * The next `getWorld()` supersedes it.
 */
export function applyWorldEvent(screen: WorldScreen, e: ServerEvent): WorldScreen {
  if (e.type !== "proactive") return screen;
  const already =
    screen.pushed.some((p) => p.id === e.proposal.id) ||
    (screen.view?.proposals ?? []).some((p) => p.id === e.proposal.id);
  if (already) return screen;
  return { ...screen, pushed: [e.proposal, ...screen.pushed] };
}

export function worldAnswered(screen: WorldScreen, view: WorldView): WorldScreen {
  // The view carries the queue, so anything pushed is now either in it or expired.
  return { view, asked: true, pushed: [], error: null };
}

export function worldFailed(screen: WorldScreen, error: string): WorldScreen {
  return { ...screen, asked: true, error: sanitiseForDisplay(error, MAX_TEXT) };
}

export function dismissWorldError(screen: WorldScreen): WorldScreen {
  return { ...screen, error: null };
}

/**
 * Everything on offer, newest first, with pushes ahead of the stored queue.
 *
 * The two sources are kept separate in the screen and merged only here, so a page
 * cannot show a pushed suggestion twice after a refresh.
 */
export function offered(screen: WorldScreen): ProactiveProposalView[] {
  const seen = new Set<string>();
  const out: ProactiveProposalView[] = [];
  for (const p of [...screen.pushed, ...(screen.view?.proposals ?? [])]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

export interface SuggestionCard {
  id: string;
  /** Exactly what would run, if the user says yes. */
  objective: string;
  /** Every line of evidence. Never a subset. */
  because: string[];
  /** The rule, in words a person can hold Jarvis to. */
  rule: string;
  entityId: string;
}

const RULE_LABEL: Record<string, string> = {
  "left-failing": "a mission here ended failing",
  "job-failing": "a scheduled job is reporting an error",
  "focused-untouched": "you appear to be in a project nothing has run against",
};

export function suggestionCards(proposals: readonly ProactiveProposalView[]): SuggestionCard[] {
  return proposals.map((p) => ({
    id: p.id,
    objective: sanitiseForDisplay(p.objective, MAX_TEXT),
    because: p.because.map((b) => sanitiseForDisplay(b, MAX_TEXT)),
    rule: RULE_LABEL[p.rule] ?? sanitiseForDisplay(p.rule, 60),
    entityId: p.entityId,
  }));
}

/**
 * The sentence under the Suggestions heading.
 *
 * It states the arrangement rather than the count, because the count is visible and
 * the arrangement is the part a user has to take on faith otherwise: nothing here
 * has run, and nothing will until they say so.
 */
export function suggestionsNote(screen: WorldScreen): string {
  const view = screen.view;
  if (view && !view.proactive.enabled) return sanitiseForDisplay(view.proactive.reason, MAX_TEXT);
  const count = offered(screen).length;
  if (count === 0) {
    return screen.asked
      ? "Nothing to suggest. Jarvis looks after a mission finishes, and never on a timer."
      : "Not asked yet.";
  }
  return count === 1
    ? "One suggestion. It has not run, and it will not until you accept it."
    : `${count} suggestions. None of them has run, and none will until you accept it.`;
}

export interface EntityRow {
  id: string;
  label: string;
  detail: string | null;
  /** The source's own word for its state, when it had one. Never re-worded. */
  status: string | null;
  /** Where this came from — the registry, the catalog, the foreground read. */
  source: string;
  /** True when this is the node the user appears to be on right now. */
  focused: boolean;
  /** True when the *reason* it is focused came from text the user did not choose. */
  steerable: boolean;
}

export interface EntityGroup {
  kind: string;
  heading: string;
  rows: EntityRow[];
}

/**
 * The graph, grouped by kind in a fixed order.
 *
 * Rows keep the order the runtime produced. Sorting by recency here would put a
 * different project at the top of the list every time the page was opened, and the
 * order the runtime built is the order the records are in.
 */
export function entityGroups(view: WorldView | null): EntityGroup[] {
  if (view === null) return [];
  const focusId = view.focus?.projectId ?? null;
  const groups: EntityGroup[] = [];
  for (const kind of KIND_ORDER) {
    const rows = view.entities
      .filter((e) => e.kind === kind)
      .map((e) => entityRow(e, focusId, view.focus?.steerable === true));
    if (rows.length > 0) {
      groups.push({ kind, heading: KIND_LABEL[kind] ?? kind, rows });
    }
  }
  return groups;
}

function entityRow(e: WorldEntityView, focusId: string | null, steerable: boolean): EntityRow {
  return {
    id: e.id,
    label: sanitiseForDisplay(e.label, 80),
    detail: e.detail === undefined ? null : sanitiseForDisplay(e.detail, MAX_TEXT),
    status: e.status === undefined ? null : sanitiseForDisplay(e.status, 40),
    source: sanitiseForDisplay(e.source, 60),
    focused: focusId !== null && e.id === focusId,
    steerable: focusId !== null && e.id === focusId && steerable,
  };
}

export interface EdgeRow {
  key: string;
  /** Both ends by their display labels, so a row reads as a sentence. */
  from: string;
  verb: string;
  to: string;
  /** Why Jarvis claims it. Always present, never truncated away. */
  basis: string;
  /** True when the basis is text something other than the user chose (§52). */
  steerable: boolean;
}

/**
 * Every edge, as a sentence with its reason attached.
 *
 * An edge whose endpoints are not both in `entities` is dropped rather than drawn
 * with an id in place of a name. The runtime already filters those out; this is the
 * second check, because a row reading `mission:m3 worked on project:xyz` is a row
 * that tells the user nothing and looks like a bug.
 */
export function edgeRows(view: WorldView | null): EdgeRow[] {
  if (view === null) return [];
  const label = new Map(view.entities.map((e) => [e.id, sanitiseForDisplay(e.label, 80)]));
  const rows: EdgeRow[] = [];
  for (const [i, e] of view.edges.entries()) {
    const from = label.get(e.from);
    const to = label.get(e.to);
    if (from === undefined || to === undefined) continue;
    rows.push({
      key: `${e.kind}:${e.from}->${e.to}:${i}`,
      from,
      verb: EDGE_LABEL[e.kind] ?? sanitiseForDisplay(e.kind, 40),
      to,
      basis: sanitiseForDisplay(e.basis, MAX_TEXT),
      steerable: e.steerable === true,
    });
  }
  return rows;
}

/**
 * What the page says it is looking at, in one line.
 *
 * The steerable case is spelled out rather than marked, because this line is the
 * one a user reads before accepting a suggestion about the project it names.
 */
export function focusLine(view: WorldView | null): string {
  if (view === null) return "Not asked yet.";
  const focus = view.focus;
  if (focus === null) return "Jarvis could not read the foreground window.";
  const label = (id: string | undefined): string | null => {
    if (id === undefined) return null;
    const found = view.entities.find((e) => e.id === id);
    return found ? sanitiseForDisplay(found.label, 80) : null;
  };
  const window = label(focus.windowId) ?? "an unnamed window";
  const project = label(focus.projectId);
  if (project === null) return `${window}, which Jarvis cannot tie to a known project.`;
  if (focus.steerable) {
    return `${window}. Its title mentions ${project}, but a title is chosen by whatever the app loaded, so Jarvis will not act on that alone.`;
  }
  return `${window}, working in ${project}.`;
}

/** The counts line, plus the cap when one was hit. Never "all" when it is not. */
export function worldSummary(view: WorldView | null, connected: boolean): string {
  if (view === null) {
    return connected ? "Nothing yet." : "We could not ask — the runtime is not connected.";
  }
  const summary = sanitiseForDisplay(view.summary, MAX_TEXT);
  return view.truncated ? `${summary} — and more than fitted.` : summary;
}
