/**
 * Presentation rules for Mission Control, separate from React so they can be
 * tested without a DOM — the same split as `hud-model` and `activity-model`.
 *
 * This page is the only place a person watches an autonomous loop act on their
 * machine, so the rules it must not break are the ones about not overstating what
 * happened:
 *
 * **Only `verified` is a success.** A step reaches `done` when
 * `runVerified()` confirmed it and never otherwise, so `done` is the one status
 * this file is willing to draw as a success. `unverified` — the tool returned and
 * nothing could confirm the effect — gets its own colour and its own words, never
 * a tick. A view that collapsed the two would put a green row on screen that no
 * check supports (§18, §43).
 *
 * **Simulated is always said out loud.** A step standing in for a capability that
 * is mocked or absent carries a badge that no other state can suppress.
 * A simulated success rendered as a real one is the specific thing the build rules
 * forbid.
 *
 * **Progress is settled work, not activity.** The bar counts steps that verified.
 * A running step earns no partial credit, because "80%" over a mission whose last
 * step is about to fail is a number that misleads exactly when it matters.
 *
 * **Nothing is invented for a missing answer.** No mission and no report render as
 * "nothing to show" and, when the link is down, as "we could not ask" — which is a
 * different fact from a quiet machine.
 */
import { sanitiseForDisplay } from "../permissions/risk-model";
import type {
  MissionCountsView,
  MissionDetailView,
  MissionReportView,
  MissionStepView,
  MissionView,
  RuntimeStatus,
  ServerEvent,
  ToolPolicyEntry,
  ToolView,
  ToolsView,
} from "../ipc/contract";

/** Lines kept in the live stream. The runtime's own log is bounded separately. */
export const MAX_STREAM_LINES = 200;

const MAX_TEXT = 200;

/** One line of the activity stream, already display-safe. */
export interface StreamLine {
  key: string;
  time: string;
  /** The transition word the runtime named, when it named one. */
  transition?: string;
  text: string;
  tone: StreamTone;
}

export type StreamTone = "ordinary" | "problem" | "approval" | "good";

/**
 * How each transition reads, and how loudly.
 *
 * A word the runtime sends that this build does not know reads as ordinary rather
 * than being dropped: an unrecognised transition still happened, and the note
 * beside it is composed from the mission's record either way. Guessing that it was
 * bad would cry wolf; hiding it would be the worse of the two.
 */
const TRANSITION_TONE: Record<string, StreamTone> = {
  planned: "ordinary",
  plan_empty: "problem",
  retrieved: "ordinary",
  verify: "ordinary",
  step_ok: "good",
  step_bad: "problem",
  need_approval: "approval",
  approved: "ordinary",
  denied: "problem",
  replanned: "approval",
  replan_exhausted: "problem",
  ask_user: "approval",
  finish: "good",
  give_up: "problem",
  cancel: "problem",
  error: "problem",
};

/** What the page holds. Every field is either from the runtime or derived here. */
export interface MissionScreen {
  /** The mission being watched, or null before one has been started or opened. */
  mission: MissionView | null;
  /**
   * The §47 report, which exists only once the runtime has composed one.
   *
   * Null while a mission runs, and null for a terminal mission whose detail has
   * not been fetched yet. Never a partial report assembled here: the arithmetic
   * belongs to the process that holds the record.
   */
  report: MissionReportView | null;
  stream: readonly StreamLine[];
  /** True from the moment an objective is submitted until the first event lands. */
  submitting: boolean;
  error: string | null;
}

export const emptyScreen: MissionScreen = {
  mission: null,
  report: null,
  stream: [],
  submitting: false,
  error: null,
};

/** Local wall-clock, as the activity log uses: a stream is read against a clock. */
export function formatTime(at: number, locale?: string): string {
  if (!Number.isFinite(at)) return "—";
  return new Date(at).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Fold one runtime event into the screen.
 *
 * Everything that is not a mission event is returned unchanged, so the page can
 * hand this its whole event feed rather than filtering first — one place decides
 * what is relevant, and it is the tested one.
 */
export function applyEvent(screen: MissionScreen, e: ServerEvent, locale?: string): MissionScreen {
  switch (e.type) {
    case "mission":
      return applyMission(screen, e.mission);
    case "mission_step":
      return applyStep(screen, e.missionId, e.step);
    case "mission_event":
      if (!isFocused(screen, e.missionId)) return screen;
      return {
        ...screen,
        stream: appendLine(screen.stream, {
          key: `${e.at}-${screen.stream.length}`,
          time: formatTime(e.at, locale),
          ...(e.transition !== undefined
            ? { transition: sanitiseForDisplay(e.transition, 40) }
            : {}),
          text: sanitiseForDisplay(e.note, MAX_TEXT),
          tone: transitionTone(e.transition),
        }),
      };
    default:
      return screen;
  }
}

function isFocused(screen: MissionScreen, missionId: string): boolean {
  return screen.mission !== null && screen.mission.id === missionId;
}

function transitionTone(transition: string | undefined): StreamTone {
  if (transition === undefined) return "ordinary";
  return TRANSITION_TONE[transition] ?? "ordinary";
}

/**
 * Take a whole mission from the wire.
 *
 * The rule for *which* mission the page follows is `createdAt`, not arrival order.
 * The runtime broadcasts to every attached client, so a second window — or a
 * mission started by voice while this page was reading an old one — can deliver
 * events for something else entirely. Following the newest objective means the
 * page shows what the user just asked for; comparing timestamps rather than
 * trusting order means a late event from a finished mission cannot steal the view
 * from the one that is running.
 *
 * Switching missions clears the stream and the report, because both belong to the
 * mission that produced them. Carrying either across would caption one mission's
 * plan with another mission's account of itself.
 */
function applyMission(screen: MissionScreen, mission: MissionView): MissionScreen {
  const current = screen.mission;
  if (current !== null && current.id !== mission.id && mission.createdAt < current.createdAt) {
    return screen;
  }
  const same = current !== null && current.id === mission.id;
  return {
    ...screen,
    mission,
    report: same ? screen.report : null,
    stream: same ? screen.stream : [],
    submitting: false,
  };
}

/**
 * Update one step in place.
 *
 * Matched by id and appended when the id is new: the replanner adds corrective
 * steps mid-mission, and a `mission_step` for one can arrive before the `mission`
 * event that carries the rewritten plan. Appending keeps it visible for those few
 * milliseconds; matching by id keeps the later whole-plan event from doubling it.
 */
function applyStep(
  screen: MissionScreen,
  missionId: string,
  step: MissionStepView,
): MissionScreen {
  if (!isFocused(screen, missionId)) return screen;
  const mission = screen.mission!;
  const known = mission.steps.some((s) => s.id === step.id);
  const steps = known
    ? mission.steps.map((s) => (s.id === step.id ? step : s))
    : [...mission.steps, step];
  return { ...screen, mission: { ...mission, steps } };
}

function appendLine(lines: readonly StreamLine[], line: StreamLine): StreamLine[] {
  const next = [...lines, line];
  return next.length > MAX_STREAM_LINES ? next.slice(next.length - MAX_STREAM_LINES) : next;
}

/**
 * Show a mission the runtime answered a question with.
 *
 * Used for `start_mission`, which resolves with the finished mission and its
 * report, and for opening one from the history list. The stream is kept only when
 * it is the same mission the page was already watching — the lines were collected
 * live and cannot be reconstructed from a snapshot, so throwing them away on a
 * reload of the same mission would lose the only record of the moments.
 */
export function focusMission(screen: MissionScreen, detail: MissionDetailView): MissionScreen {
  const same = screen.mission !== null && screen.mission.id === detail.mission.id;
  return {
    mission: detail.mission,
    report: detail.report,
    stream: same ? screen.stream : [],
    submitting: false,
    error: null,
  };
}

/** An objective has gone to the runtime; nothing has come back yet. */
export function startedSubmitting(screen: MissionScreen): MissionScreen {
  return { ...screen, submitting: true, error: null };
}

/**
 * A failure the page has to show.
 *
 * The mission is left exactly as it was. A refused start or a broken pipe says
 * nothing about the mission already on screen, and blanking it would throw away
 * the record of what did run.
 */
export function failed(screen: MissionScreen, error: string): MissionScreen {
  return { ...screen, submitting: false, error: sanitiseForDisplay(error, MAX_TEXT) };
}

export function dismissError(screen: MissionScreen): MissionScreen {
  return screen.error === null ? screen : { ...screen, error: null };
}

// --- mission state ---------------------------------------------------------

export type StateTone = "live" | "waiting" | "good" | "bad" | "muted";

export interface StateLook {
  label: string;
  tone: StateTone;
  /** True only while the loop is genuinely turning. A finished mission is still. */
  live: boolean;
}

/**
 * The ten states in the user's words.
 *
 * `waiting_approval` is the one worth reading twice: it is not an error and not
 * progress, it is the loop stopped on a question that only the person at the
 * keyboard can answer, and the label says so rather than saying "paused".
 */
const STATE_LOOKS: Record<string, Omit<StateLook, "live">> = {
  planning: { label: "Planning", tone: "live" },
  retrieving: { label: "Recalling what it knows", tone: "live" },
  executing: { label: "Executing", tone: "live" },
  verifying: { label: "Checking the result", tone: "live" },
  replanning: { label: "Re-planning after a failure", tone: "waiting" },
  waiting_approval: { label: "Waiting for your answer", tone: "waiting" },
  completed: { label: "Completed", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  blocked: { label: "Blocked — not permitted", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

export function stateLook(mission: MissionView): StateLook {
  const look = STATE_LOOKS[mission.state] ?? {
    label: sanitiseForDisplay(mission.state, 40),
    tone: "muted" as StateTone,
  };
  // `terminal` comes from the runtime rather than being derived from the label:
  // a state this build has no words for is still over if the runtime says it is,
  // and a spinner on a finished mission would be the page claiming work continues.
  return { ...look, live: !mission.terminal };
}

// --- steps -----------------------------------------------------------------

export type StepTone =
  | "verified"
  | "unverified"
  | "failed"
  | "waiting"
  | "running"
  | "queued"
  | "muted";

export interface StepLook {
  label: string;
  tone: StepTone;
  /** The one line the record holds: a result, or an error. */
  detail?: string;
  /**
   * Short flags shown beside the title.
   *
   * Ordered so the ones a user must not miss come first: simulated before
   * anything, then the risk the engine judged, then how the step got here.
   */
  badges: readonly string[];
}

/**
 * The five words a settled step is allowed to be described with.
 *
 * `done` is the only success, and it is spelled "Verified" so the claim on screen
 * is the claim the check actually made. `unverified` is spelled out at length
 * because it is the state most easily mistaken for fine: the tool returned, and
 * nothing was able to confirm that it did what it said.
 */
const STEP_LOOKS: Record<string, Omit<StepLook, "badges" | "detail">> = {
  pending: { label: "Queued", tone: "queued" },
  awaiting_approval: { label: "Waiting for your answer", tone: "waiting" },
  running: { label: "Running", tone: "running" },
  done: { label: "Verified", tone: "verified" },
  unverified: { label: "Ran, but nothing confirmed it", tone: "unverified" },
  failed: { label: "Failed", tone: "failed" },
  skipped: { label: "Skipped", tone: "muted" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

export function stepLook(step: MissionStepView): StepLook {
  const base = STEP_LOOKS[step.status] ?? {
    label: sanitiseForDisplay(step.status, 40),
    tone: "muted" as StepTone,
  };
  // A `done` step whose outcome is not `verified` cannot happen upstream — only
  // `verified` produces that status. It is handled anyway, and handled by
  // *demoting* it, because the alternative is a tick drawn from a status while the
  // outcome beside it says nothing was checked. This page is not the right place
  // to give a runtime bug the benefit of the doubt.
  const look =
    step.status === "done" && step.outcome !== undefined && step.outcome !== "verified"
      ? { label: "Reported done, but nothing confirmed it", tone: "unverified" as StepTone }
      : base;
  return {
    ...look,
    badges: stepBadges(step),
    ...(step.detail !== undefined ? { detail: sanitiseForDisplay(step.detail, MAX_TEXT) } : {}),
  };
}

function stepBadges(step: MissionStepView): string[] {
  const badges: string[] = [];
  // First, and from a field nothing else can suppress: a mocked capability that
  // reads as a real one is the single failure mode the build rules name outright.
  if (step.simulated === true) badges.push("simulated");
  // Second, because it is what a person weighs a consent decision with. Only when
  // something has classified this call — an absent `risk` means "not classified
  // yet", and a level invented here would be a guess in exactly the wrong field.
  if (step.risk !== undefined) {
    badges.push(`level ${step.risk.level} ${sanitiseForDisplay(step.risk.category, 20)}`);
  }
  if (step.attempt > 1) badges.push(`attempt ${step.attempt}`);
  if (step.origin === "replan") badges.push("added after a failure");
  if (step.optional) badges.push("optional");
  return badges;
}

/** The step a mission is parked on, if it is parked on one. */
export function awaitingStep(mission: MissionView | null): MissionStepView | null {
  return mission?.steps.find((s) => s.status === "awaiting_approval") ?? null;
}

// --- the plan graph --------------------------------------------------------

/** One column of the graph: everything at the same dependency depth. */
export interface PlanLane {
  depth: number;
  steps: readonly MissionStepView[];
}

/**
 * The plan arranged by what waits on what.
 *
 * Depth is the longest chain of dependencies behind a step, so a lane can only
 * contain steps that are genuinely independent of each other — which is what makes
 * the drawing a plan rather than a list. Within a lane the order is the one the
 * orchestrator uses (priority, then the plan's own order), so the graph reads in
 * the sequence the loop will actually take.
 *
 * A dependency naming a step that is not in the plan, and a cycle, both resolve to
 * depth 0 rather than throwing or recursing forever. A malformed plan is a thing to
 * *show* — an always-on window must not go blank because a planner emitted a loop.
 */
export function planLanes(steps: readonly MissionStepView[]): PlanLane[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (step: MissionStepView): number => {
    const cached = depths.get(step.id);
    if (cached !== undefined) return cached;
    if (visiting.has(step.id)) return 0;
    visiting.add(step.id);
    let depth = 0;
    for (const id of step.dependsOn) {
      const parent = byId.get(id);
      if (parent === undefined) continue;
      depth = Math.max(depth, depthOf(parent) + 1);
    }
    visiting.delete(step.id);
    depths.set(step.id, depth);
    return depth;
  };

  const lanes = new Map<number, MissionStepView[]>();
  steps.forEach((step) => {
    const depth = depthOf(step);
    const lane = lanes.get(depth) ?? [];
    lane.push(step);
    lanes.set(depth, lane);
  });

  const order = new Map(steps.map((s, i) => [s.id, i]));
  return [...lanes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([depth, laneSteps]) => ({
      depth,
      steps: laneSteps.sort(
        (a, b) => a.priority - b.priority || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
      ),
    }));
}

// --- arithmetic ------------------------------------------------------------

export interface Progress {
  verified: number;
  total: number;
  /** 0–100, whole numbers. `verified / total`, and nothing else. */
  percent: number;
  /** Steps that ran and could not be confirmed. Shown beside the bar, never in it. */
  unverified: number;
  failed: number;
}

/**
 * How far along, counting only what has been confirmed.
 *
 * `done` over `total`. A running step contributes nothing, an unverified one
 * contributes nothing, and both are reported separately instead — a bar that
 * filled on activity would read 80% for a mission about to fail, which is the
 * number that misleads at the exact moment a person is deciding whether to
 * intervene.
 */
export function progress(counts: MissionCountsView): Progress {
  const total = Math.max(0, counts.total);
  const verified = Math.max(0, Math.min(total, counts.done));
  return {
    verified,
    total,
    percent: total === 0 ? 0 : Math.round((verified / total) * 100),
    unverified: counts.unverified,
    failed: counts.failed,
  };
}

/** A duration a person can read. `null` stays "—" rather than becoming zero. */
export function durationLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes} m ${String(rest).padStart(2, "0")} s`;
}

// --- the console -----------------------------------------------------------

export interface ConsoleFacts {
  connected: boolean;
  /** True while the runtime is already turning a mission. It runs one at a time. */
  busy: boolean;
  submitting: boolean;
}

/**
 * Whether the objective box should accept this.
 *
 * The busy check is the interesting one: the runtime refuses a second mission and
 * says which one is running, so a button that submitted anyway would produce an
 * error the user could have been spared. Disabling it is not hiding a capability —
 * one mission at a time is the design, because a single consent question queue
 * cannot honestly serve two loops.
 */
export function canStart(facts: ConsoleFacts, objective: string): boolean {
  return facts.connected && !facts.busy && !facts.submitting && objective.trim().length > 0;
}

/** Why the box is closed, when it is. Null when it is open for business. */
export function startBlockedReason(facts: ConsoleFacts): string | null {
  if (!facts.connected) return "Not connected to the Jarvis runtime.";
  if (facts.submitting) return "Sending your objective…";
  if (facts.busy) return "A mission is already running. It finishes, or you cancel it.";
  return null;
}

/**
 * What the page says with no mission on screen.
 *
 * Separates "none yet" from "we could not ask", for the same reason the activity
 * list does: an empty console under a dead link is not evidence that nothing has
 * ever run on this machine.
 */
export function emptyMessage(connected: boolean): string {
  return connected
    ? "No mission yet. Say what you want to be true, and Jarvis works out the steps."
    : "Not connected to the runtime, so nothing here is current.";
}

// --- lists -----------------------------------------------------------------

export interface HistoryRow {
  id: string;
  objective: string;
  state: string;
  tone: StateTone;
  /** True when this is one of the missions the loop is turning right now. */
  live: boolean;
  when: string;
  verified: number;
  total: number;
}

/**
 * The mission list, newest first.
 *
 * `live` comes from the runtime's own list of running ids rather than from the
 * state string. A mission whose last broadcast said `executing` and whose runtime
 * has since restarted is not running, and a row that claimed otherwise would
 * invite someone to wait for a loop that no longer exists.
 */
export function historyRows(
  missions: readonly MissionView[],
  running: readonly string[],
  locale?: string,
): HistoryRow[] {
  const live = new Set(running);
  return [...missions]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((m) => ({
      id: m.id,
      objective: sanitiseForDisplay(m.objective, MAX_TEXT),
      state: stateLook(m).label,
      tone: stateLook(m).tone,
      live: live.has(m.id),
      when: formatTime(m.createdAt, locale),
      verified: m.counts.done,
      total: m.counts.total,
    }));
}

export interface ToolRow {
  name: string;
  summary: string;
  category: string;
  level: number;
  simulated: boolean;
  /**
   * Which faculty owns the tool, as `agents/roles.ts` groups it.
   *
   * A grouping and nothing else. It is not a second permission dimension and the
   * engine never sees it, so a row whose role is unfamiliar loses a heading and
   * loses no accuracy about what the tool may do — which is `level` and `category`.
   */
  role: string;
}

/**
 * The tool list, grouped the way a person would ask about it.
 *
 * Sorted by category and then by name, and the level shown is `typicalLevel` —
 * what the tool classifies as with no arguments. It is labelled as typical in the
 * component for a reason: a real call is classified from its arguments and can come
 * out higher, and a number here presented as a promise would be a promise this
 * layer cannot keep.
 */
export function toolRows(tools: readonly ToolView[]): ToolRow[] {
  return [...tools]
    .map((t) => ({
      name: sanitiseForDisplay(t.name, 60),
      summary: sanitiseForDisplay(t.summary, MAX_TEXT),
      category: sanitiseForDisplay(t.category, 30),
      level: t.typicalLevel,
      simulated: t.simulated,
      role: sanitiseForDisplay(t.role, 20),
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export interface PolicyRow {
  /** The risk class, as the engine names it. */
  category: string;
  /** Which of the four choices is selected right now. */
  selected: "auto" | "approval" | "deny" | "default";
  /** One sentence saying what will happen and where the rule came from. */
  explain: string;
  /** True while the choice is a session override, so the row can say it is temporary. */
  temporary: boolean;
  /** How many of the listed tools usually classify as this class. */
  tools: number;
}

/**
 * The policy table, as a settings panel shows it (§42).
 *
 * Three things this function will not do, each because the honest version is
 * shorter than the reassuring one:
 *
 *  - It does not claim `auto` means silence. Above `autoCeiling` a step asks anyway,
 *    so a row set to `auto` says "except level 4, which still asks".
 *  - It does not hide that a class has no rule. `default` is a real state with a
 *    real consequence — the level rule — and the sentence names the level.
 *  - It does not count a tool's class as a promise. `typicalLevel` and the category
 *    beside it are what a tool classifies as with *no* arguments, so the count is
 *    "usually", which is what the sentence says.
 */
export function policyRows(view: ToolsView | null): PolicyRow[] {
  if (view === null) return [];
  const counts = new Map<string, number>();
  for (const tool of view.tools) {
    counts.set(tool.category, (counts.get(tool.category) ?? 0) + 1);
  }
  return view.policy.map((entry) => {
    const category = sanitiseForDisplay(entry.category, 30);
    return {
      category,
      selected: entry.effective,
      explain: explainPolicy(entry, view, category),
      temporary: entry.source === "session",
      tools: counts.get(entry.category) ?? 0,
    };
  });
}

function explainPolicy(
  entry: ToolPolicyEntry,
  view: ToolsView,
  category: string,
): string {
  const where =
    entry.source === "session"
      ? ` — chosen here${
          entry.configured === null ? "" : `, over config.json's "${entry.configured}"`
        }, so a restart forgets it`
      : entry.source === "config"
        ? " — from config.json"
        : "";
  switch (entry.effective) {
    case "deny":
      return `A mission may not take ${category} actions. A step that needs one ends the mission blocked, which is an answer and not a fault${where}.`;
    case "approval":
      return `Every ${category} step asks first, including ones you have allowed before${where}.`;
    case "auto":
      return `${category} steps run without asking, except at level ${view.autoCeiling + 1} — an irreversible action asks whatever this says${where}.`;
    default:
      // Reachable only when nothing is set: a session override holds one of the
      // three verdicts, and choosing "default" deletes it rather than storing a
      // fourth. So there is no config value to mention here — if there were, the
      // entry's `effective` would be that value.
      return `No rule, so the level decides: level ${view.autoAllowUpTo} and below runs, above that asks.`;
  }
}

/**
 * The report's one-line verdict, or what to say instead.
 *
 * There is deliberately no fallback headline composed here. A report is built from
 * a mission's own record by the runtime; if there is no report yet, the honest thing
 * on screen is that the mission has not finished, not a sentence this file wrote
 * about work it did not observe.
 */
export function reportHeadline(report: MissionReportView | null): string | null {
  return report === null ? null : sanitiseForDisplay(report.headline, MAX_TEXT);
}

export interface PlannerLook {
  /** What the header says: short, and true about this machine. */
  readonly label: string;
  /** The hover text: how the model was configured, never with what. */
  readonly detail: string;
  /** Dim when there is no model, so the header does not advertise one. */
  readonly tone: "live" | "muted";
}

/**
 * What the header says about the planner.
 *
 * "Built-in planner" rather than "offline" or "degraded", because that is what it is:
 * the deterministic planner is a real planner with real rules, and a mission it plans
 * is not a lesser mission. What the label must never do is imply a model when there is
 * none — that is the §43 line, and it is drawn here because this is the only place the
 * window can claim one.
 *
 * A model that is configured but not permitted to plan (`llmPlanner: false`) is named
 * and marked, rather than hidden: a user who set that key should be able to see that
 * Jarvis noticed.
 */
export function plannerLook(status: { readonly llm: RuntimeStatus["llm"] } | null): PlannerLook {
  if (status === null) {
    return { label: "Planner: unknown", detail: "the runtime has not reported yet", tone: "muted" };
  }
  const llm = status.llm;
  const note = sanitiseForDisplay(llm.note, MAX_TEXT);
  if (!llm.available) {
    return { label: "Planner: built-in", detail: note, tone: "muted" };
  }
  if (!llm.planning) {
    return {
      label: `Planner: built-in (${sanitiseForDisplay(llm.model, 40)} available)`,
      detail: `${note} · the model is configured but llmPlanner is off`,
      tone: "muted",
    };
  }
  return {
    label: `Planner: ${sanitiseForDisplay(llm.model, 40)}`,
    detail: `${sanitiseForDisplay(llm.provider, 30)} · ${note}`,
    tone: "live",
  };
}
