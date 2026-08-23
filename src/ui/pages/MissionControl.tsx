/**
 * Mission Control — the window where an objective becomes visible work.
 *
 * One page, its own window, and no conversation: the HUD is where you talk to
 * Jarvis, this is where you watch it act. Everything drawn here comes from a
 * `mission*` event or from a request the runtime answered, and the presentation
 * rules — which statuses may look like success, what a progress bar counts, when a
 * badge cannot be suppressed — are in `mission-model.ts` so they are covered by
 * tests rather than by looking at the screen.
 *
 * The page holds no policy of its own. It cannot invoke a tool, cannot lower a
 * risk level, and cannot mark a step done; the buttons here start a mission, stop
 * one, and answer a question a step is parked on. That is the whole surface.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  applyEvent,
  awaitingStep,
  canStart,
  durationLabel,
  emptyMessage,
  emptyScreen,
  failed,
  focusMission,
  historyRows,
  planLanes,
  plannerLook,
  policyRows,
  progress,
  reportHeadline,
  startBlockedReason,
  startedSubmitting,
  stateLook,
  stepLook,
  toolRows,
  type MissionScreen,
  type StateTone,
  type StepTone,
  type StreamLine,
  type StreamTone,
} from "../mission-model";
import {
  applyWorldEvent,
  dismissWorldError,
  edgeRows,
  emptyWorld,
  entityGroups,
  focusLine,
  offered,
  suggestionCards,
  suggestionsNote,
  worldAnswered,
  worldFailed,
  worldSummary,
  type EntityGroup,
  type SuggestionCard,
  type WorldScreen,
} from "../world-model";
import {
  describeEngagement,
  roleTone,
  traceScreen,
  type RoleRow,
  type RoleTone,
  type TraceRow,
} from "../trace-model";
import {
  applyVisionEvent,
  dismissVision,
  emptyVision,
  visionAnswered,
  visionCard,
  visionFailed,
  visionLooking,
  type VisionCard,
  type VisionScreen,
} from "../vision-model";
import type {
  MissionReportEntryView,
  MissionReportView,
  MissionStepView,
  MissionView,
  MissionsView,
  RuntimeStatus,
  ServerEvent,
  ToolsView,
  TraceView,
} from "../../ipc/contract";

/** The preload bridge. Absent only if the page is opened outside Electron. */
const jarvis = window.jarvis;

/**
 * Colour is a claim, so the map is small and the claims are separated.
 *
 * `verified` is the only green in the file. `unverified` is amber and not green,
 * because "it ran and nothing confirmed it" is not a success wearing a different
 * shade — it is a different fact, and the palette is where a reader learns that
 * without reading anything.
 */
const STEP_TONE: Record<StepTone, string> = {
  verified: "border-emerald-500/40 bg-emerald-500/[0.07] text-emerald-200",
  unverified: "border-amber-500/40 bg-amber-500/[0.07] text-amber-200",
  failed: "border-red-500/40 bg-red-500/[0.07] text-red-200",
  waiting: "border-sky-400/50 bg-sky-500/[0.09] text-sky-200",
  running: "border-orange-400/50 bg-orange-500/[0.08] text-orange-100",
  queued: "border-slate-700 bg-white/[0.02] text-slate-400",
  muted: "border-slate-800 bg-white/[0.01] text-slate-500",
};

const STATE_TONE: Record<StateTone, string> = {
  live: "text-orange-200",
  waiting: "text-sky-200",
  good: "text-emerald-200",
  bad: "text-red-200",
  muted: "text-slate-400",
};

const STREAM_TONE: Record<StreamTone, string> = {
  ordinary: "text-slate-400",
  problem: "text-red-200",
  approval: "text-sky-200",
  good: "text-emerald-200",
};

/**
 * A colour per role, and no meaning beyond which faculty acted.
 *
 * Deliberately not the step palette: `verified` is the only green in this file and it
 * means a check passed, so the Verify *role* is drawn in a cool blue rather than green.
 * A role that acted is not a role that succeeded, and two panes using one green for both
 * would let a reader read a success off a roster that never claimed one.
 */
const ROLE_TONE: Record<RoleTone, string> = {
  plan: "text-indigo-200",
  read: "text-orange-200",
  recall: "text-violet-200",
  act: "text-slate-200",
  code: "text-teal-200",
  check: "text-sky-200",
  gate: "text-amber-200",
};

/**
 * The class for a role name, including one this build has no colour for.
 *
 * An unrecognised role keeps the neutral tone rather than being hidden or renamed. It
 * means the runtime knows a faculty this window does not, which costs a colour and
 * nothing else: the count beside it was still counted from the log.
 */
function roleClass(role: string): string {
  const tone = roleTone(role);
  return tone === null ? "text-slate-500" : ROLE_TONE[tone];
}

const CARD = "rounded-lg border border-[#4a2a12] bg-black/30 p-4";
const LABEL = "text-[10px] uppercase tracking-[0.2em] text-slate-500";

export default function MissionControl() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [linked, setLinked] = useState(false);
  const [screen, setScreen] = useState<MissionScreen>(emptyScreen);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<MissionsView | null>(null);
  const [tools, setTools] = useState<ToolsView | null>(null);
  const [world, setWorld] = useState<WorldScreen>(emptyWorld);
  // The last look at the screen, held apart from the mission it might become. A
  // proposal is not a mission and must not be able to occupy the pane that draws one.
  const [vision, setVision] = useState<VisionScreen>(emptyVision);
  // Which mission the trace on screen is *of*, held beside it. The trace is fetched on
  // demand and is by far the largest thing the bridge carries, so it is not refreshed
  // with the rest — and it must never be drawn under another mission's heading, which
  // is what the id is checked for at render.
  const [trace, setTrace] = useState<{ missionId: string; view: TraceView | null } | null>(null);
  const streamEnd = useRef<HTMLDivElement>(null);

  const connected = linked && status !== null;
  const running = status?.missions.running ?? 0;
  const facts = { connected, busy: running > 0, submitting: screen.submitting };

  useEffect(() => {
    if (!jarvis) return;

    const refresh = (): void => {
      void jarvis.getStatus().then((s) => {
        if (s) {
          setStatus(s);
          setLinked(true);
        }
      });
      // The list and the tool inventory are read on attach rather than on demand:
      // this window is opened *because* someone wants to know what has run, and an
      // empty page that fills in after a click would be answering a question late.
      void jarvis.getMissions().then((m) => setHistory(m ?? null)).catch(() => {});
      void jarvis.getTools().then((t) => setTools(t)).catch(() => {});
      // Asking is what assembles the graph, so this is the refresh: there is no
      // `refreshWorld` and nothing behind it runs on a timer.
      void jarvis
        .getWorld()
        .then((w) => setWorld((s) => (w ? worldAnswered(s, w) : worldFailed(s, "no answer"))))
        .catch(() => {});
    };
    refresh();

    const offLink = jarvis.onLink((up) => {
      setLinked(up);
      if (up) refresh();
    });
    const offEvent = jarvis.onEvent((e: ServerEvent) => {
      if (e.type === "status") setStatus(e.status);
      // Every event goes to the model, which decides what is a mission event and
      // which mission it belongs to. Filtering here would put that rule in two
      // places and only one of them would be tested.
      setScreen((s) => applyEvent(s, e));
      // A pushed suggestion is added, not a trigger to re-assemble: a mission
      // finishing must not make the page do work nobody asked for.
      setWorld((s) => applyWorldEvent(s, e));
      // A proposal read off the screen, which arrives whether this window asked for
      // it or a microphone did — the spoken door's whole offer is one sentence read
      // out once, and an objective derived from a screenshot is worth reading.
      setVision((s) => applyVisionEvent(s, e));
      // A mission that has just ended has a report the runtime composed, and this
      // page does not compose one. Ask for it.
      if (e.type === "mission" && e.mission.terminal) void reload(e.mission.id);
    });

    return () => {
      offLink();
      offEvent();
    };
  }, []);

  useEffect(() => {
    streamEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [screen.stream.length]);

  /**
   * Ask for one mission's trace.
   *
   * A failed ask is recorded as an ask that failed rather than left as an absence:
   * `traceScreen(null)` says the runtime could not be reached, which is a different fact
   * from a mission that logged nothing, and the pane has to be able to tell them apart.
   */
  async function explain(missionId: string): Promise<void> {
    if (!jarvis) return;
    try {
      const view = await jarvis.getTrace(missionId);
      setTrace({ missionId, view: view ?? null });
    } catch {
      setTrace({ missionId, view: null });
    }
  }

  /** Re-read one mission, which is how the report and the final counts arrive. */
  async function reload(missionId: string): Promise<void> {
    if (!jarvis) return;
    try {
      const detail = await jarvis.getMission(missionId);
      if (detail) setScreen((s) => focusMission(s, detail));
      const list = await jarvis.getMissions();
      setHistory(list ?? null);
    } catch {
      // Left alone deliberately. The mission on screen is still the record of what
      // ran; a failed re-read is a missing report, not a reason to blank it.
    }
  }

  async function start(): Promise<void> {
    if (!jarvis || !canStart(facts, draft)) return;
    const objective = draft.trim();
    setDraft("");
    await launch(objective);
  }

  /**
   * Send one objective, however it was arrived at.
   *
   * Shared by the console and by a proposal read off the screen, and sharing it is the
   * point rather than a saving: an objective proposed from a screenshot goes through
   * the identical call, so it reaches the same planner, the same classification and the
   * same consent prompts as one somebody typed. A second path with its own start would
   * be a door into the mission loop whose entrant came from pixels.
   */
  async function launch(objective: string): Promise<void> {
    if (!jarvis) return;
    setScreen(startedSubmitting);
    try {
      // Resolves when the mission is over — minutes, possibly. The page is not
      // waiting on it to draw: the plan and every step arrive as events while it
      // runs, and this resolution is the report at the end of them.
      const detail = await jarvis.startMission(objective);
      if (detail) setScreen((s) => focusMission(s, detail));
      const list = await jarvis.getMissions();
      setHistory(list ?? null);
    } catch (err) {
      setScreen((s) => failed(s, err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * Ask Jarvis to look at the screen.
   *
   * The draft box doubles as the question when there is something in it — "why is this
   * failing" typed beside the button is a better ask than the fixed phrase — and the
   * draft is *kept*, not cleared: this is not a submission, and a user whose typing
   * vanished into a screenshot request would have lost the objective they were writing.
   *
   * A refusal comes back as an ordinary answer and is shown as one. Only the ask
   * failing outright — a broken pipe, or a mission already running — is an error here.
   */
  async function look(): Promise<void> {
    if (!jarvis) return;
    setVision(visionLooking());
    const ask = draft.trim();
    try {
      const answer = await jarvis.proposeFromScreen(ask === "" ? undefined : ask);
      if (answer) setVision(visionAnswered(answer));
      else setVision(visionFailed("The runtime did not answer."));
    } catch (err) {
      setVision(visionFailed(err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * Take on an objective a model proposed after looking at the screen.
   *
   * The card is dropped first, deliberately. It has been acted on, and a proposal left
   * on screen beside the mission it started would be a second Start button for an
   * objective that is already running.
   */
  async function startProposed(objective: string): Promise<void> {
    setVision(dismissVision());
    await launch(objective);
  }

  async function decide(
    step: MissionStepView,
    decision: "allow_once" | "allow_always" | "deny",
  ): Promise<void> {
    const mission = screen.mission;
    if (!jarvis || !mission) return;
    try {
      await jarvis.approveStep(mission.id, step.id, decision);
    } catch (err) {
      setScreen((s) => failed(s, err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * Answer one suggestion.
   *
   * `accept` resolves when the mission it started is over, and it is the *same*
   * `runMission` a typed objective reaches — so the plan and the steps arrive as
   * events here exactly as they do for one the user typed. `decline` starts nothing.
   */
  async function resolveProposal(id: string, decision: "accept" | "decline"): Promise<void> {
    if (!jarvis) return;
    if (decision === "accept") setScreen(startedSubmitting);
    try {
      const result = await jarvis.resolveProposal(id, decision);
      if (result) {
        setWorld((s) => worldAnswered(s, result.world));
        const detail = result.mission;
        if (detail) {
          setScreen((s) => focusMission(s, detail));
          const list = await jarvis.getMissions();
          setHistory(list ?? null);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setWorld((s) => worldFailed(s, message));
      if (decision === "accept") setScreen((s) => failed(s, message));
    }
  }

  async function stop(): Promise<void> {
    const mission = screen.mission;
    if (!jarvis || !mission) return;
    try {
      await jarvis.cancelMission(mission.id);
    } catch (err) {
      setScreen((s) => failed(s, err instanceof Error ? err.message : String(err)));
    }
  }

  const mission = screen.mission;
  const waiting = awaitingStep(mission);
  const blocked = startBlockedReason(facts);
  // Whether there is a card at all, and whether it may offer to start anything, are
  // both decided in `vision-model.ts` — the page draws what it is handed.
  const card = visionCard(vision, { connected, busy: facts.busy || screen.submitting });

  return (
    <div className="flex h-screen flex-col bg-[#0d0805] text-slate-300">
      <Header status={status} connected={connected} />

      <main className="grid flex-1 grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-4 overflow-hidden p-4">
        <section className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
          <Console
            draft={draft}
            onDraft={setDraft}
            onStart={() => void start()}
            onLook={() => void look()}
            enabled={canStart(facts, draft)}
            canLook={connected && !facts.busy && !vision.looking}
            blocked={blocked}
          />

          {card && (
            <Proposal
              card={card}
              onStart={() => {
                if (card.objective) void startProposed(card.objective);
              }}
              onDismiss={() => setVision(dismissVision())}
            />
          )}

          {screen.error && (
            <p className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {screen.error}
            </p>
          )}

          {waiting && mission && (
            <Approval
              step={waiting}
              onDecide={(d) => void decide(waiting, d)}
              disabled={!connected}
            />
          )}

          {mission ? (
            <Plan mission={mission} onStop={() => void stop()} connected={connected} />
          ) : (
            <p className={`${CARD} text-xs text-slate-500`}>{emptyMessage(connected)}</p>
          )}

          {screen.report && <Report report={screen.report} />}
        </section>

        <section className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
          <Stream lines={screen.stream} endRef={streamEnd} />
          <Suggestions
            world={world}
            connected={connected}
            busy={facts.busy || screen.submitting}
            onResolve={(id, decision) => void resolveProposal(id, decision)}
            onDismissError={() => setWorld(dismissWorldError)}
          />
          {mission && <Memory mission={mission} />}
          <History
            missions={history}
            onOpen={(id) => void reload(id)}
            selected={mission?.id ?? null}
          />
          <Trace
            mission={mission}
            asked={trace !== null && mission !== null && trace.missionId === mission.id}
            view={mission !== null && trace?.missionId === mission.id ? trace.view : null}
            onExplain={() => {
              if (mission) void explain(mission.id);
            }}
            connected={connected}
          />
          <World world={world} connected={connected} />
          <Tools tools={tools} />
          <Policy
            tools={tools}
            connected={connected}
            onSet={(category, verdict) => {
              if (!jarvis) return;
              // The runtime's answer replaces the whole view rather than this row
              // being edited in place. It is the only thing that knows what the
              // engine will now do, and a row that showed the click instead of the
              // consequence would be a button pretending to be a policy.
              void jarvis
                .setToolPolicy(category, verdict)
                .then((next) => {
                  if (next) setTools(next);
                })
                .catch(() => {});
            }}
          />
        </section>
      </main>
    </div>
  );
}

// --- header ----------------------------------------------------------------

/**
 * The core state, from the same status the tray and the HUD read.
 *
 * Subsystems are named individually rather than rolled into one "healthy" light.
 * A mission that cannot speak its result is still a mission that ran, and the user
 * is better served knowing which half is missing than being shown an average.
 */
function Header({
  status,
  connected,
}: {
  status: RuntimeStatus | null;
  connected: boolean;
}) {
  const missions = status?.missions;
  const planner = plannerLook(status);
  return (
    <header className="flex items-center justify-between border-b border-[#4a2a12] px-4 py-3">
      <div className="flex items-baseline gap-3">
        <span className="text-xs font-semibold tracking-[0.3em] text-orange-300">
          JARVIS · MISSION CONTROL
        </span>
        <span className="text-[10px] text-slate-500">
          {connected ? "runtime connected" : "runtime not connected"}
        </span>
      </div>
      <div className="flex items-center gap-4 text-[10px] text-slate-500">
        {/* The planner first: it is the one line that says whether a model is
            deciding what runs, and a window that implied one when there is none
            would be the §43 failure this whole layer is careful about. */}
        <span className={planner.tone === "live" ? "text-orange-200" : ""} title={planner.detail}>
          {planner.label}
        </span>
        <span>Hermes: {status?.hermes.state ?? "unknown"}</span>
        <span>
          Voice:{" "}
          {status ? (status.voice.capturing ? "listening" : status.voice.state) : "unknown"}
        </span>
        {missions && (
          <span className={missions.running > 0 ? "text-orange-200" : ""}>
            {missions.running === 0
              ? "no mission running"
              : missions.running === 1
                ? "1 mission running"
                : `${missions.running} missions running`}
            {missions.awaitingApproval > 0 ? " · waiting on you" : ""}
            {` · ${missions.recorded} recorded`}
          </span>
        )}
      </div>
    </header>
  );
}

// --- the objective console --------------------------------------------------

/**
 * Where an outcome is stated. Not a chat box: it takes a *what*, not a *how*.
 *
 * The button's disabled state comes from `canStart`, and the reason beside it from
 * `startBlockedReason`, so a closed console always says why it is closed. A greyed
 * control with no explanation is the thing that makes people restart an app.
 */
function Console({
  draft,
  onDraft,
  onStart,
  onLook,
  enabled,
  canLook,
  blocked,
}: {
  draft: string;
  onDraft: (v: string) => void;
  onStart: () => void;
  onLook: () => void;
  enabled: boolean;
  canLook: boolean;
  blocked: string | null;
}) {
  return (
    <div className={CARD}>
      <label className={LABEL} htmlFor="objective">
        Give JARVIS an objective
      </label>
      <textarea
        id="objective"
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          // Enter alone inserts a newline: an objective is often two sentences, and
          // losing one to a stray keystroke starts a mission on half a thought.
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onStart();
          }
        }}
        rows={3}
        spellCheck={false}
        placeholder="Get my project ready for tomorrow"
        className="mt-2 w-full resize-none rounded border border-[#4a2a12] bg-black/40 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-orange-500/60"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-[11px] text-slate-500">
          {blocked ?? "Ctrl+Enter to send. Jarvis plans the steps and asks before anything risky."}
        </span>
        <div className="flex items-center gap-2">
          {/* Separated from "Start mission" by more than a gap: this one does not start
              anything. It spends one screenshot, behind a consent prompt, and comes back
              with something to read — so it is worded as a look and styled as the
              secondary action it is. */}
          <button
            type="button"
            onClick={onLook}
            disabled={!canLook}
            title="Takes one screenshot, asks a model what is on it, and proposes an objective. Nothing starts."
            className="rounded border border-[#1d4560] bg-transparent px-3 py-1.5 text-xs text-slate-300 disabled:cursor-not-allowed disabled:border-slate-800 disabled:text-slate-600"
          >
            {draft.trim() === "" ? "Look at my screen" : "Ask about my screen"}
          </button>
          <button
            type="button"
            onClick={onStart}
            disabled={!enabled}
            className="rounded border border-orange-500/50 bg-orange-500/10 px-3 py-1.5 text-xs text-orange-100 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-transparent disabled:text-slate-600"
          >
            Start mission
          </button>
        </div>
      </div>
    </div>
  );
}

// --- a proposal read off the screen -----------------------------------------

/** Border and text per tone. A proposal is not green: nothing has happened yet. */
const VISION_TONE: Record<VisionCard["tone"], string> = {
  proposal: "border-orange-500/30 bg-orange-500/5",
  refusal: "border-slate-700 bg-black/30",
  problem: "border-red-500/30 bg-red-500/10",
  looking: "border-[#4a2a12] bg-black/30",
};

/**
 * What Jarvis saw, what it would take on, and a button that is the only way from
 * one to the other.
 *
 * The observation is drawn *above* the objective and in the same weight, because it
 * is what makes the objective checkable: "make the portfolio-site build pass" read
 * off a terminal and the same words read off a week-old chat log are the same
 * sentence and different proposals, and only the observation tells them apart.
 *
 * The provenance line is not decoration either (§43). A proposal is the easiest thing
 * in this system to fake convincingly — a plausible objective needs no model at all —
 * so the card names the model that answered, how long it took, and how many kilobytes
 * of screenshot were sent. If those are absent, no model looked.
 */
function Proposal({
  card,
  onStart,
  onDismiss,
}: {
  card: VisionCard;
  onStart: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className={`rounded-lg border p-4 ${VISION_TONE[card.tone]}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs text-slate-200">{card.title}</p>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[11px] text-slate-500 hover:text-slate-300"
        >
          Dismiss
        </button>
      </div>

      {card.observed !== undefined && (
        <div className="mt-3">
          <p className={LABEL}>What it saw</p>
          <p className="mt-1 text-sm text-slate-300">{card.observed}</p>
        </div>
      )}

      {card.objective !== undefined ? (
        <div className="mt-3">
          <p className={LABEL}>The objective it proposes</p>
          <p className="mt-1 text-sm text-slate-100">{card.objective}</p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-400">{card.body}</p>
      )}

      {card.objective !== undefined && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[11px] text-slate-500">{card.cost ?? card.body}</span>
          <button
            type="button"
            onClick={onStart}
            disabled={!card.startable}
            className="rounded border border-orange-500/50 bg-orange-500/10 px-3 py-1.5 text-xs text-orange-100 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-transparent disabled:text-slate-600"
          >
            Start it
          </button>
        </div>
      )}
      {card.objective !== undefined && (
        // Said on the card rather than left to the button's tense. The objective above
        // was written by a model that read it off pixels this process could not
        // sanitise, and the sentence that says so is the one thing the user can act on.
        <p className="mt-2 text-[11px] text-slate-500">{card.body}</p>
      )}
    </div>
  );
}

// --- the consent question ---------------------------------------------------

/**
 * The one place this window can change what a mission does.
 *
 * It shows the step, the tool and the level the engine judged — the three things a
 * decision needs — and nothing it composed itself. "Deny" is presented as an
 * ordinary third option rather than a destructive one, because refusing is a legal
 * outcome the mission handles (`blocked`), not a failure the user causes.
 */
function Approval({
  step,
  onDecide,
  disabled,
}: {
  step: MissionStepView;
  onDecide: (d: "allow_once" | "allow_always" | "deny") => void;
  disabled: boolean;
}) {
  const look = stepLook(step);
  return (
    <div className="rounded-lg border border-sky-400/50 bg-sky-500/[0.07] p-4">
      <p className="text-[10px] uppercase tracking-[0.2em] text-sky-300">
        Jarvis is waiting for your answer
      </p>
      <p className="mt-2 text-sm text-slate-100">{step.title}</p>
      <p className="mt-1 text-[11px] text-slate-400">
        {step.tool}
        {step.risk ? ` · level ${step.risk.level} ${step.risk.category}` : ""}
        {step.simulated === true ? " · simulated" : ""}
      </p>
      {look.detail && <p className="mt-1 text-[11px] text-slate-400">{look.detail}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {(
          [
            ["allow_once", "Allow once", "border-sky-400/60 bg-sky-500/15 text-sky-100"],
            ["allow_always", "Always allow this", "border-slate-600 bg-white/[0.03] text-slate-300"],
            ["deny", "Deny", "border-slate-600 bg-white/[0.03] text-slate-300"],
          ] as const
        ).map(([decision, label, tone]) => (
          <button
            key={decision}
            type="button"
            onClick={() => onDecide(decision)}
            disabled={disabled}
            className={`rounded border px-3 py-1.5 text-xs ${tone} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-slate-500">
        Denying stops this step, and the mission reports what it could not do. “Always” is
        remembered by the runtime for this kind of call, not for everything.
      </p>
    </div>
  );
}

// --- the plan graph ---------------------------------------------------------

/**
 * The plan as the loop sees it: lanes of steps that do not wait on each other.
 *
 * The bar counts verified steps only, and the two numbers it refuses to include —
 * unverified and failed — are printed beside it in their own words. A single bar
 * that filled on activity would read almost complete for a mission about to fail.
 */
function Plan({
  mission,
  onStop,
  connected,
}: {
  mission: MissionView;
  onStop: () => void;
  connected: boolean;
}) {
  const look = stateLook(mission);
  const bar = progress(mission.counts);
  const lanes = planLanes(mission.steps);
  const elapsed =
    mission.finishedAt === undefined ? null : mission.finishedAt - mission.createdAt;

  return (
    <div className={CARD}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className={LABEL}>Objective</p>
          <p className="mt-1 text-sm text-slate-100">{mission.objective}</p>
          <p className="mt-1 text-[11px] text-slate-500">
            <span className={STATE_TONE[look.tone]}>{look.label}</span>
            {look.live ? " · running" : ""}
            {` · plan: ${mission.planner}`}
            {mission.replans > 0 ? ` · ${mission.replans} re-plan${mission.replans === 1 ? "" : "s"}` : ""}
            {elapsed === null ? "" : ` · ${durationLabel(elapsed)}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onStop}
          disabled={!connected || mission.terminal}
          className="shrink-0 rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-200 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-transparent disabled:text-slate-600"
        >
          Stop mission
        </button>
      </div>

      <div className="mt-3">
        <div className="flex items-baseline justify-between text-[11px] text-slate-500">
          <span>
            {bar.verified} of {bar.total} steps verified
          </span>
          <span>
            {bar.unverified > 0 ? `${bar.unverified} unconfirmed · ` : ""}
            {bar.failed > 0 ? `${bar.failed} failed · ` : ""}
            {bar.percent}%
          </span>
        </div>
        <div
          className="mt-1 h-1.5 overflow-hidden rounded bg-white/[0.06]"
          role="progressbar"
          aria-valuenow={bar.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Steps verified"
        >
          <div className="h-full bg-emerald-500/70" style={{ width: `${bar.percent}%` }} />
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {lanes.map((lane) => (
          <div key={lane.depth}>
            <p className="text-[10px] uppercase tracking-[0.2em] text-slate-600">
              {lane.depth === 0 ? "First" : `After ${lane.depth}`}
            </p>
            <div className="mt-1 grid gap-2 sm:grid-cols-2">
              {lane.steps.map((step) => (
                <StepCard key={step.id} step={step} />
              ))}
            </div>
          </div>
        ))}
        {mission.steps.length === 0 && (
          <p className="text-xs text-slate-500">
            No steps yet. The plan appears here the moment the planner emits one.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * One step. The colour, the words and the badges all come from `stepLook`.
 *
 * Nothing here decides what a status means — that rule is in `mission-model.ts`
 * where a test can hold it to account, which is the only reason the green in this
 * file can be trusted to mean "checked".
 */
function StepCard({ step }: { step: MissionStepView }) {
  const look = stepLook(step);
  return (
    <div className={`rounded border px-3 py-2 ${STEP_TONE[look.tone]}`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-xs text-slate-100">{step.title}</p>
        <span className="shrink-0 text-[10px] opacity-90">{look.label}</span>
      </div>
      <p className="mt-0.5 truncate text-[10px] text-slate-500">{step.tool}</p>
      {look.detail && <p className="mt-1 text-[11px] opacity-90">{look.detail}</p>}
      {look.badges.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {look.badges.map((badge) => (
            <span
              key={badge}
              className="rounded-sm border border-white/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wider opacity-80"
            >
              {badge}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// --- the report -------------------------------------------------------------

/**
 * The §47 report, printed as the runtime composed it.
 *
 * Every list here was counted from the mission's own record, so this component's
 * whole job is layout. The section that must never be dropped is `simulated`: it is
 * how a reader learns which parts of a finished mission stood in for a real
 * capability, and a report that omitted it would read as a clean success.
 */
function Report({ report }: { report: MissionReportView }) {
  const headline = reportHeadline(report);
  return (
    <div className={CARD}>
      <p className={LABEL}>Report</p>
      {headline && <p className="mt-1 text-sm text-slate-100">{headline}</p>}
      <p className="mt-1 text-[11px] text-slate-500">
        {`${report.counts.done} verified · ${report.counts.unverified} unconfirmed · ${report.counts.failed} failed`}
        {` · ${report.replans} re-plan${report.replans === 1 ? "" : "s"}`}
        {` · ${durationLabel(report.durationMs)}`}
        {` · plan: ${report.planner}`}
      </p>
      {report.conclusion && (
        <p className="mt-2 text-xs text-slate-300">{report.conclusion}</p>
      )}

      {report.tools.length > 0 && (
        <div className="mt-3">
          <p className={LABEL}>Tools used</p>
          <div className="mt-1 flex flex-col gap-1">
            {report.tools.map((t) => (
              <div
                key={t.tool}
                className="flex items-baseline justify-between gap-3 text-[11px] text-slate-400"
              >
                <span className="truncate">{t.tool}</span>
                <span className="shrink-0">
                  {`${t.attempts} call${t.attempts === 1 ? "" : "s"} · ${t.verified} verified`}
                  {t.unverified > 0 ? ` · ${t.unverified} unconfirmed` : ""}
                  {t.failed > 0 ? ` · ${t.failed} failed` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <ReportList title="Recovered after a failure" entries={report.recovered} />
      <ReportList title="Verified" entries={report.verified} />
      <ReportList title="Still outstanding" entries={report.outstanding} />
      <ReportList title="Simulated — not a real capability" entries={report.simulated} />

      {report.nextAction && (
        <div className="mt-3 rounded border border-orange-500/30 bg-orange-500/[0.06] px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.2em] text-orange-300">Suggested next</p>
          <p className="mt-1 text-xs text-slate-200">{report.nextAction}</p>
        </div>
      )}
    </div>
  );
}

/** One of the report's lists, or nothing at all when it is empty. */
function ReportList({
  title,
  entries,
}: {
  title: string;
  entries: readonly MissionReportEntryView[];
}) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-3">
      <p className={LABEL}>
        {title} ({entries.length})
      </p>
      <ul className="mt-1 flex flex-col gap-1">
        {entries.map((e) => (
          <li key={e.id} className="text-[11px] text-slate-400">
            <span className="text-slate-300">{e.title}</span>
            <span className="text-slate-600">
              {` · ${e.tool}`}
              {e.attempt > 1 ? ` · attempt ${e.attempt}` : ""}
              {e.simulated === true ? " · simulated" : ""}
            </span>
            {e.detail && <span className="block text-slate-500">{e.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- the live stream --------------------------------------------------------

/**
 * What has happened, in order, capped by the model at 200 lines.
 *
 * Each line is a transition the runtime named plus a note composed from the
 * mission's record — never a sentence written here, and never model prose. The
 * empty state says the stream is empty, not that nothing is happening.
 */
function Stream({
  lines,
  endRef,
}: {
  lines: readonly StreamLine[];
  endRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className={CARD}>
      <p className={LABEL}>Activity</p>
      <div className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
        {lines.length === 0 && (
          <p className="text-xs text-slate-500">Nothing has happened on this mission yet.</p>
        )}
        {lines.map((line) => (
          <div key={line.key} className="flex gap-2 text-[11px] leading-relaxed">
            <span className="shrink-0 tabular-nums text-slate-600">{line.time}</span>
            <span className={STREAM_TONE[line.tone]}>
              {line.transition && (
                <span className="mr-1 uppercase tracking-wider opacity-70">{line.transition}</span>
              )}
              {line.text}
            </span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// --- what it recalled -------------------------------------------------------

/**
 * The citations retrieval produced, by where each one came from.
 *
 * Summaries only. The stored content itself is not projected onto this wire, and
 * that is deliberate: a memory is data a mission read, and putting the whole of it
 * on screen would put whatever a file contained in front of a model's output.
 *
 * An empty list is stated rather than hidden — "it recalled nothing" is a fact
 * about how a mission was planned, and a card that vanished would leave a reader
 * assuming context was used.
 */
function Memory({ mission }: { mission: MissionView }) {
  return (
    <div className={CARD}>
      <p className={LABEL}>What Jarvis recalled</p>
      {mission.memory.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500">
          Nothing was retrieved for this objective.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {mission.memory.map((m, i) => (
            <li key={`${m.source}-${i}`} className="text-[11px] text-slate-400">
              <span className="mr-1.5 rounded-sm border border-white/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-500">
                {m.source}
              </span>
              {m.summary}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- history ----------------------------------------------------------------

/**
 * Every mission this runtime has a record of, newest first.
 *
 * `null` and empty are different sentences: a runtime that could not be asked has
 * no history to show, which is not the same as a machine on which nothing has run.
 */
function History({
  missions,
  onOpen,
  selected,
}: {
  missions: MissionsView | null;
  onOpen: (id: string) => void;
  selected: string | null;
}) {
  const rows = missions ? historyRows(missions.missions, missions.running) : [];
  return (
    <div className={CARD}>
      <p className={LABEL}>Missions</p>
      {missions === null ? (
        <p className="mt-2 text-xs text-slate-500">
          The runtime has not answered, so no history is shown.
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500">No mission has run on this machine yet.</p>
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => onOpen(row.id)}
              aria-current={row.id === selected}
              className={`rounded border px-2 py-1.5 text-left ${
                row.id === selected
                  ? "border-orange-500/40 bg-orange-500/[0.07]"
                  : "border-transparent hover:border-slate-700 hover:bg-white/[0.02]"
              }`}
            >
              <p className="truncate text-[11px] text-slate-300">{row.objective}</p>
              <p className="text-[10px] text-slate-600">
                <span className={STATE_TONE[row.tone]}>{row.state}</span>
                {row.live ? " · running now" : ""}
                {` · ${row.verified}/${row.total} verified · ${row.when}`}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- the agent trace --------------------------------------------------------

/**
 * What Jarvis did, in order, and which faculty did it.
 *
 * This is the pane the master prompt asks for when it says explain the *actions* and not
 * the chain of thought, and the distinction holds here because of what the pane is built
 * from rather than because of anything it filters. Its input is the mission's own
 * append-only log: times, states, events, steps, tools, outcomes, classifications. No
 * prompt and no completion was ever written there, so there is no reasoning on this
 * screen to leak.
 *
 * Three things it will not do:
 *
 *  - **It does not fetch itself.** A trace is the largest thing the bridge carries, and
 *    a window that pulled one for every mission it touched would spend the pipe on
 *    something nobody asked to read.
 *  - **It does not blend voices.** A `because` a planning model wrote is shown as a
 *    quotation with the model named. Every other one was composed from the record.
 *  - **It does not quietly shorten.** A trimmed trace draws the gap where the gap is,
 *    with both numbers (§43).
 */
function Trace({
  mission,
  asked,
  view,
  onExplain,
  connected,
}: {
  mission: MissionView | null;
  asked: boolean;
  view: TraceView | null;
  onExplain: () => void;
  connected: boolean;
}) {
  if (mission === null) {
    return (
      <div className={CARD}>
        <p className={LABEL}>Agent trace</p>
        <p className="mt-2 text-xs text-slate-500">
          Pick a mission above and Jarvis will account for what it did.
        </p>
      </div>
    );
  }
  if (!asked) {
    return (
      <div className={CARD}>
        <p className={LABEL}>Agent trace</p>
        <p className="mt-2 text-xs text-slate-500">
          Every line this mission recorded, in order, attributed to the faculty that acted.
        </p>
        <button
          type="button"
          onClick={onExplain}
          disabled={!connected}
          className="mt-2 rounded border border-orange-500/40 px-2 py-1 text-[11px] text-orange-100 hover:bg-orange-500/10 disabled:border-slate-800 disabled:text-slate-600"
        >
          Explain what happened
        </button>
      </div>
    );
  }

  const screen = traceScreen(view);
  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between gap-3">
        <p className={LABEL}>Agent trace</p>
        <button
          type="button"
          onClick={onExplain}
          disabled={!connected}
          className="text-[10px] text-slate-500 hover:text-slate-300 disabled:text-slate-700"
        >
          Refresh
        </button>
      </div>

      <p className="mt-2 text-[10px] text-slate-500">{describeEngagement(screen)}</p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {screen.roles.map((role) => (
          <Role key={role.role} role={role} />
        ))}
      </div>

      {screen.gap !== null ? (
        <p className="mt-3 text-xs text-amber-200">{screen.gap}</p>
      ) : screen.rows.length === 0 ? (
        <p className="mt-3 text-xs text-slate-500">This mission recorded no lines.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {screen.rows.map((row) => (
            <div key={row.key} className="contents">
              <TraceLine row={row} />
              {screen.omission !== null && screen.omission.afterSeq === row.seq && (
                <p className="border-y border-dashed border-slate-700 py-1 text-center text-[10px] text-slate-500">
                  {screen.omission.text}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One role and its count. A zero is shown, dimmed — never dropped. */
function Role({ role }: { role: RoleRow }) {
  return (
    <span
      title={role.purpose}
      className={`text-[10px] ${role.engaged ? roleClass(role.role) : "text-slate-700"}`}
    >
      {role.label} {role.actions}
    </span>
  );
}

/**
 * One recorded line.
 *
 * The action is this repository's sentence about the line; `because` is either the line's own
 * note or a sentence built from its fields. When a planning model supplied it, the row
 * says so in the model's own place rather than in a tooltip: an attribution a reader has
 * to hover to find is an attribution most readers never see.
 */
function TraceLine({ row }: { row: TraceRow }) {
  return (
    <div className="flex gap-2">
      <span className="w-14 shrink-0 pt-0.5 text-right font-mono text-[10px] text-slate-600">
        {row.time}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-slate-300">
          <span className={roleClass(row.role)}>{row.role}</span> {row.action}
        </p>
        <p className="text-[10px] text-slate-500">
          {row.attribution === "model" && (
            <span className="mr-1 rounded-sm border border-violet-500/40 px-1 py-0.5 text-[9px] uppercase tracking-wider text-violet-200">
              quoted
            </span>
          )}
          {row.because}
          {row.quoted !== undefined && (
            <span className="text-slate-600">{` (${row.quoted})`}</span>
          )}
        </p>
        {(row.tool !== undefined || row.outcome !== undefined || row.badges.length > 0) && (
          <p className="text-[10px] text-slate-600">
            {[row.tool, row.outcome, ...row.badges].filter((x) => x !== undefined).join(" · ")}
          </p>
        )}
      </div>
    </div>
  );
}

// --- suggestions ------------------------------------------------------------

/**
 * What Jarvis is offering to do, and has not done.
 *
 * Two properties this card exists to make visible, and neither is decoration:
 *
 * Every suggestion is shown **with all of its evidence** — each line names a
 * record, a mission id, a job's reported status, a time. Accepting is then a
 * decision made from what happened rather than from trust in a hunch.
 *
 * **Nothing here has run.** The buttons are the only path from this card to a
 * mission, and `accept` goes through the same call the objective box uses: same
 * planner, same permission prompts, same verification. There is no third button
 * that would let Jarvis act on its own, because there is no such request on the
 * wire (§43).
 */
function Suggestions({
  world,
  connected,
  busy,
  onResolve,
  onDismissError,
}: {
  world: WorldScreen;
  connected: boolean;
  busy: boolean;
  onResolve: (id: string, decision: "accept" | "decline") => void;
  onDismissError: () => void;
}) {
  const cards: SuggestionCard[] = suggestionCards(offered(world));
  return (
    <div className={CARD}>
      <p className={LABEL}>Suggestions</p>
      <p className="mt-2 text-[11px] text-slate-500">{suggestionsNote(world)}</p>

      {world.error && (
        <button
          type="button"
          onClick={onDismissError}
          className="mt-2 w-full rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-left text-[11px] text-red-300"
        >
          {world.error}
        </button>
      )}

      {cards.length > 0 && (
        <ul className="mt-3 flex flex-col gap-3">
          {cards.map((card) => (
            <li key={card.id} className="rounded border border-[#4a2a12] bg-white/[0.02] p-3">
              <p className="text-xs text-slate-200">{card.objective}</p>
              <p className="mt-1 text-[10px] uppercase tracking-wider text-slate-500">
                {card.rule}
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {card.because.map((line, i) => (
                  <li key={i} className="text-[11px] text-slate-400">
                    · {line}
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={!connected || busy}
                  onClick={() => onResolve(card.id, "accept")}
                  className="rounded border border-orange-400/40 bg-orange-500/10 px-2.5 py-1 text-[11px] text-orange-200 disabled:opacity-40"
                  title={
                    busy
                      ? "a mission is already running"
                      : "runs it now, through the same path a typed objective takes"
                  }
                >
                  Run it
                </button>
                <button
                  type="button"
                  disabled={!connected}
                  onClick={() => onResolve(card.id, "decline")}
                  className="rounded border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400 disabled:opacity-40"
                  title="drops it, and keeps this rule quiet about it for a month"
                >
                  No thanks
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- what Jarvis can see ----------------------------------------------------

/**
 * The entity graph, and every edge with the reason for it.
 *
 * The reason is in the row rather than in a tooltip, because an edge is an
 * inference and an inference a user cannot check is one they can only believe. An
 * edge derived from a window title or a job name — text something other than the
 * user chose — is marked `from text Jarvis did not choose` (§52): it is recorded
 * because it is true about the title, and it is barred from deciding anything.
 */
function World({ world, connected }: { world: WorldScreen; connected: boolean }) {
  const view = world.view;
  const groups: EntityGroup[] = entityGroups(view);
  const edges = edgeRows(view);
  return (
    <div className={CARD}>
      <p className={LABEL}>What Jarvis can see</p>
      <p className="mt-2 text-[11px] text-slate-400">{worldSummary(view, connected)}</p>
      <p className="mt-1 text-[11px] text-slate-500">{focusLine(view)}</p>

      {groups.map((group) => (
        <div key={group.kind} className="mt-3">
          <p className="text-[10px] uppercase tracking-wider text-slate-600">{group.heading}</p>
          <ul className="mt-1 flex flex-col gap-1">
            {group.rows.map((row) => (
              <li key={row.id} className="text-[11px] text-slate-400">
                <span className={row.focused ? "text-orange-200" : "text-slate-300"}>
                  {row.label}
                </span>
                {row.status && (
                  <span className="ml-1.5 rounded-sm border border-white/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-500">
                    {row.status}
                  </span>
                )}
                {row.steerable && (
                  <span className="ml-1.5 text-[9px] uppercase tracking-wider text-amber-300/80">
                    from a title
                  </span>
                )}
                {row.detail && <span className="ml-1.5 text-slate-500">{row.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {edges.length > 0 && (
        <div className="mt-3">
          <p className="text-[10px] uppercase tracking-wider text-slate-600">
            Connections, and why
          </p>
          <ul className="mt-1 flex flex-col gap-1.5">
            {edges.map((edge) => (
              <li key={edge.key} className="text-[11px] text-slate-400">
                <span className="text-slate-300">{edge.from}</span> {edge.verb}{" "}
                <span className="text-slate-300">{edge.to}</span>
                <span className="block text-slate-500">
                  {edge.basis}
                  {edge.steerable && (
                    <span className="ml-1.5 text-amber-300/80">
                      — from text Jarvis did not choose, so it decides nothing
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// --- the tool inventory -----------------------------------------------------

/**
 * What a mission is able to choose from — read-only, by design.
 *
 * There is no button beside a tool here, because the bridge has no `invokeTool`: a
 * click that ran something would reach the filesystem and the shell without passing
 * the mission loop, the classification or the permission engine.
 *
 * The level is labelled "typical" in the header rather than shown as a bare number,
 * because a real call is classified from its arguments and can come out higher.
 */
function Tools({ tools }: { tools: ToolsView | null }) {
  const rows = toolRows(tools?.tools ?? []);
  return (
    <div className={CARD}>
      <p className={LABEL}>Tools available ({rows.length})</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500">
          The runtime listed no tools, so nothing here is current.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          {rows.map((row) => (
            <div key={row.name} className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[11px] text-slate-300">
                  {row.name}
                  {row.simulated && (
                    <span className="ml-1.5 rounded-sm border border-amber-500/40 px-1 py-0.5 text-[9px] uppercase tracking-wider text-amber-200">
                      simulated
                    </span>
                  )}
                </p>
                <p className="truncate text-[10px] text-slate-600">{row.summary}</p>
              </div>
              <span className="shrink-0 text-[10px] text-slate-600">
                {/* The role first, because it is the only one of the three that says what
                    kind of work the tool is. The two after it are what the engine reads. */}
                <span className={roleClass(row.role)}>{row.role}</span>
                {` · ${row.category} · typically level ${row.level}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- the policy panel -------------------------------------------------------

/** The four choices, in the order they loosen. */
const CHOICES: readonly { value: "deny" | "approval" | "default" | "auto"; label: string }[] = [
  { value: "deny", label: "Never" },
  { value: "approval", label: "Always ask" },
  { value: "default", label: "By level" },
  { value: "auto", label: "Don't ask" },
];

/**
 * What a mission is permitted, by risk class, and who decided (§42).
 *
 * Four things this panel is careful about.
 *
 * It governs *classes*, not tools. The class comes from `classify()` reading a
 * call's arguments, so `delete` covers whatever turns out to be deleting something —
 * including a tool added later, and including one whose name suggested otherwise. A
 * per-tool switch would be a switch a renamed tool escapes.
 *
 * Every class is listed, even the ones no tool here classifies as. Hiding a class
 * until something used it would hide it exactly until it mattered.
 *
 * A change lasts until the runtime restarts, and the footer says so rather than
 * leaving a user to discover it. The runtime reads `config.json` once at boot; a
 * panel that wrote to that file would leave the file and the running engine
 * disagreeing until a restart, which is a worse fiction than a temporary setting.
 *
 * And two limits are printed rather than implied: `Don't ask` still asks at the top
 * level, and nothing here reaches an action the risk model forbids outright. Both
 * rules live in the engine, where this window cannot reach them, so a panel that
 * promised otherwise would be promising on someone else's behalf.
 */
function Policy({
  tools,
  connected,
  onSet,
}: {
  tools: ToolsView | null;
  connected: boolean;
  onSet: (category: string, verdict: "auto" | "approval" | "deny" | "default") => void;
}) {
  const rows = policyRows(tools);
  return (
    <div className={CARD}>
      <p className={LABEL}>What missions may do</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500">
          The runtime has not said, so nothing here would be current.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {rows.map((row) => (
            <div
              key={row.category}
              className="border-t border-[#4a2a12]/60 pt-2 first:border-0 first:pt-0"
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[11px] text-slate-300">
                  {row.category}
                  <span className="ml-1.5 text-[10px] text-slate-600">
                    {row.tools === 0
                      ? "no tool here, usually"
                      : `${row.tools} tool${row.tools === 1 ? "" : "s"}, usually`}
                  </span>
                  {row.temporary && (
                    <span className="ml-1.5 rounded-sm border border-amber-500/40 px-1 py-0.5 text-[9px] uppercase tracking-wider text-amber-200">
                      this session
                    </span>
                  )}
                </p>
                <div className="flex shrink-0 gap-1">
                  {CHOICES.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      onClick={() => onSet(row.category, choice.value)}
                      disabled={!connected}
                      aria-pressed={row.selected === choice.value}
                      className={`rounded-sm border px-1.5 py-0.5 text-[9px] uppercase tracking-wider disabled:opacity-40 ${
                        row.selected === choice.value
                          ? "border-sky-400/60 bg-sky-500/15 text-sky-100"
                          : "border-[#4a2a12] text-slate-500 hover:text-slate-300"
                      }`}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-0.5 text-[10px] text-slate-600">{row.explain}</p>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 border-t border-[#4a2a12]/60 pt-2 text-[10px] text-slate-600">
        These last until Jarvis restarts. Write <code>missionPolicy</code> in{" "}
        <code>config.json</code> for something permanent. Nothing here can permit an
        action the risk model forbids, and an irreversible step asks even where a class
        says don&apos;t.
      </p>
    </div>
  );
}
