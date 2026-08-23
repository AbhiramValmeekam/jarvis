import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Orb } from "./components/Orb";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { CommandCenter } from "./components/CommandCenter";
import { canSubmit, wakeWordPhrases, type HudFacts } from "./hud-model";
import { currentRequest, type PermissionRequestEvent } from "./permission-model";
import { appendEntry, mergeBacklog, refusedCount } from "./activity-model";
import {
  attentionCount,
  loadingData,
  type CommandData,
  type CommandTabId,
  type Section,
} from "./command-model";
import type { ActivityEntry, RuntimeStatus, ServerEvent } from "../ipc/contract";

/** The preload bridge. Absent only if the page is opened outside Electron. */
const jarvis = window.jarvis;

/**
 * The 3D core, split out of the initial bundle.
 *
 * three.js and the postprocessing chain are ~2.7 MB of JavaScript, and the HUD is
 * opened by saying a wake word — the window is created and shown while the user is
 * still speaking, so anything on the critical path to first paint is felt. Loading
 * it lazily lets the shell, the conversation and the composer paint immediately;
 * the `Orb` below stands in for the tick or two the core takes to arrive, which is
 * the same thing it does when the machine has no working WebGL at all.
 */
const NeuralCore = lazy(() =>
  import("./components/NeuralCore").then((m) => ({ default: m.NeuralCore })),
);
type NeuralCoreHandle = import("./components/NeuralCore").NeuralCoreHandle;

type Turn = {
  id: number;
  role: "you" | "jarvis";
  text: string;
  pending?: boolean;
};

const EMPTY_HERMES: RuntimeStatus["hermes"] = {
  state: "unknown",
  pid: null,
  sessionId: null,
  restartCount: 0,
  gaveUpReason: null,
};

/** Before the first status arrives, voice is unknown — never "working". */
const EMPTY_VOICE: RuntimeStatus["voice"] = {
  state: "unknown",
  pid: null,
  wakeWord: null,
  device: null,
  capturing: false,
  restartCount: 0,
  gaveUpReason: null,
};

export default function App() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [linked, setLinked] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // A queue, not a single slot: Hermes can ask twice before anyone answers, and
  // overwriting the first question would leave it to expire unseen.
  const [asks, setAsks] = useState<PermissionRequestEvent[]>([]);
  // Accumulated whether or not the panel is open. The runtime decides things
  // while this window is hidden, and a list that only started when the user
  // looked would present a partial record as the whole one.
  const [activity, setActivity] = useState<readonly ActivityEntry[]>([]);
  // Which Command Center tab is open, or null for closed. A tab id rather than a
  // boolean because the header has more than one way in: the Activity button
  // opens the record, the attention badge opens whatever raised it.
  const [panel, setPanel] = useState<CommandTabId | null>(null);
  // Kept across closes, so reopening shows the last answer instead of flashing
  // "Reading…" over data that is still on screen a moment later. It refreshes
  // underneath, which is the point of re-reading on every open.
  const [command, setCommand] = useState<CommandData>(loadingData);
  const nextId = useRef(1);
  const scroller = useRef<HTMLDivElement>(null);
  // The core, so a sent message can surge it. A ref rather than a prop for the
  // same reason the pointer is one: this is a one-off event, not a value to
  // render, and threading it through state would re-render the whole HUD to
  // deliver it.
  const core = useRef<NeuralCoreHandle>(null);

  const facts: HudFacts = {
    connected: linked && status !== null,
    state: status?.state ?? "idle",
    muted: status?.muted ?? false,
    listening: status?.listening ?? false,
    hermesState: status?.hermes.state ?? "unknown",
    hermesRestarts: status?.hermes.restartCount ?? 0,
    ...(status
      ? {
          voiceState: status.voice.state,
          capturing: status.voice.capturing,
          wakeWord: status.voice.wakeWord,
        }
      : {}),
  };

  /**
   * Re-read the four Command Center inventories.
   *
   * Four independent reads that land separately rather than one combined await,
   * because they fail for unrelated reasons — Hermes' config can be unreadable
   * while its skills directory is perfectly fine — and a single rejected promise
   * must not blank three panels that had answers.
   *
   * A `null` from the bridge is recorded as a failure, not as an empty view. The
   * runtime returns a view or nothing at all, so nothing here knows whether the
   * list is empty or the question went unanswered — and inventing an empty list
   * is the false all-clear the whole model is built to avoid.
   */
  function loadCommand(): void {
    if (!jarvis) return;
    const put = <K extends keyof CommandData>(key: K, value: CommandData[K]): void =>
      setCommand((c) => ({ ...c, [key]: value }));
    void asSection(jarvis.getTasks()).then((s) => put("tasks", s));
    void asSection(jarvis.getMcp()).then((s) => put("mcp", s));
    void asSection(jarvis.getMemory()).then((s) => put("memory", s));
    void asSection(jarvis.getSkills()).then((s) => put("skills", s));
  }

  /** Open the panel on a tab, and refresh it — an inventory opened is one re-read. */
  function openPanel(tab: CommandTabId): void {
    setPanel(tab);
    loadCommand();
  }

  useEffect(() => {
    if (!jarvis) return;

    void jarvis.getStatus().then((s) => {
      if (s) {
        setStatus(s);
        setLinked(true);
      }
    });

    // Fetched on attach, not on panel open: the runtime has been deciding things
    // since boot, and the backlog is the part of the record this window never saw.
    const loadActivity = (): void => {
      void jarvis
        .getActivity()
        .then((list) => setActivity((a) => mergeBacklog(a, list)))
        // Swallowed on purpose. A failed fetch leaves the list as it was, and
        // `emptyMessage` already tells the user an unlinked list may be stale —
        // an error banner over the conversation would be the wrong place to say it.
        .catch(() => {});
    };
    loadActivity();
    // Also on attach, for the same reason the badge exists: a flagged MCP server
    // is worth surfacing to someone who has not thought to open the panel.
    loadCommand();

    const offLink = jarvis.onLink((up) => {
      setLinked(up);
      // Decisions taken while detached are only in the runtime's log, so a
      // reconnect has to go and ask rather than resume appending.
      if (up) loadActivity();
      // Same for the inventories, which are read through the runtime and so are
      // exactly as stale as the link that was down.
      if (up) loadCommand();
      // The runtime cancels its open questions when the last UI detaches, so a
      // dialog left on screen after the link drops is asking about something
      // already refused. Clearing it beats collecting an answer that goes
      // nowhere — and a reconnect brings any live question back.
      if (!up) setAsks([]);
    });
    const offEvent = jarvis.onEvent((e: ServerEvent) => {
      switch (e.type) {
        case "status":
          setStatus(e.status);
          break;
        case "state":
          setStatus((s) => (s ? { ...s, state: e.state } : s));
          break;
        case "level":
          setLevel(e.rms);
          break;
        case "transcript":
          // Live transcription replaces the in-progress user turn.
          setTurns((t) => upsertPending(t, "you", e.text, !e.final, nextId));
          // A final transcript *is* a message being sent, so it surges the core
          // exactly as `send` does. Only on the final one: pulsing per interim
          // transcript would re-peak the decay every few hundred milliseconds and
          // hold the rig at maximum for the whole utterance, which stops reading
          // as "something just happened".
          if (e.final) core.current?.pulse();
          break;
        case "reply_chunk":
          setTurns((t) => appendPending(t, "jarvis", e.text, nextId));
          break;
        case "reply_done":
          setTurns((t) => t.map((x) => (x.pending ? { ...x, pending: false } : x)));
          break;
        case "permission_request":
          setAsks((q) =>
            // Guard against a duplicate id: a reconnect can replay an event, and
            // the same question twice would need answering twice.
            q.some((x) => x.requestId === e.requestId) ? q : [...q, e],
          );
          break;
        case "activity":
          setActivity((a) => appendEntry(a, e.entry));
          break;
        case "error":
          setError(e.message);
          break;
        case "unavailable":
          setError(`${e.subsystem}: ${e.reason}`);
          break;
        default:
          break;
      }
    });

    return () => {
      offLink();
      offEvent();
    };
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  async function send() {
    if (!jarvis || !canSubmit(facts, draft)) return;
    const text = draft.trim();
    setDraft("");
    setError(null);
    setTurns((t) => [...t, { id: nextId.current++, role: "you", text }]);
    // Before the await, not after: the core should acknowledge the send at the
    // moment it happens, not when the runtime gets round to answering.
    core.current?.pulse();
    try {
      await jarvis.prompt(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function decide(
    requestId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ): Promise<void> {
    // Removed first, so a slow round trip cannot leave the dialog live and
    // double-answerable. If the send fails the request is already void anyway:
    // the runtime denies anything it does not hear back about.
    setAsks((q) => q.filter((x) => x.requestId !== requestId));
    try {
      await jarvis?.respondToPermission(requestId, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const hermes = status?.hermes ?? EMPTY_HERMES;
  const voice = status?.voice ?? EMPTY_VOICE;
  // Offer the restart only when it would do something. A live "Restart voice"
  // next to a working microphone is noise; next to a dead one it is the fix.
  const voiceBroken = voice.state === "failed" || voice.state === "stopped";
  const ask = currentRequest(asks);
  const refused = refusedCount(activity);
  const attention = attentionCount(command);

  return (
    <div className="flex h-full flex-col bg-[#0d0805]/85 backdrop-blur-xl text-slate-300">
      {/* Title bar — the only draggable region. */}
      <header className="drag flex items-center justify-between border-b border-[#4a2a12] px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold tracking-[0.3em] text-orange-300">JARVIS</span>
          <span className="text-[10px] text-slate-500">
            {facts.connected ? "connected" : "offline"}
          </span>
        </div>
        <div className="no-drag flex items-center gap-1">
          {/* Two ways in, because they answer different questions. "Activity" is
              the record of what Jarvis did; the attention badge is a problem
              waiting — a flagged MCP server, or a scheduler that will not fire —
              and it opens the tab that raised it rather than a landing page. */}
          {attention > 0 && (
            <button
              className="rounded border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200 hover:bg-amber-500/20"
              onClick={() => openPanel(attentionTab(command))}
              title="Something configured on this machine needs a look"
            >
              ⚠ {attention}
            </button>
          )}
          <button
            className="rounded px-2 py-0.5 text-[10px] text-slate-500 hover:bg-white/5 hover:text-slate-200"
            onClick={() => (panel ? setPanel(null) : openPanel("tasks"))}
            title="Scheduled jobs, connected servers, memory, skills, and the decision record"
          >
            Command
          </button>
          {/* Missions live in their own window, not in this panel stack: a mission
              outlives the sentence that started it, and this HUD hides on Escape.
              The count is only drawn when the runtime sent one — a "0" here would
              be a claim about a build that never mentioned missions at all. */}
          <button
            className="rounded px-2 py-0.5 text-[10px] text-slate-500 hover:bg-white/5 hover:text-slate-200"
            onClick={() => jarvis?.openMissionWindow()}
            title="Mission Control — give Jarvis an objective and watch it work"
          >
            Missions
            {status && status.missions.awaitingApproval > 0 ? (
              <span className="ml-1 text-sky-300">
                {status.missions.awaitingApproval} waiting
              </span>
            ) : status && status.missions.running > 0 ? (
              <span className="ml-1 text-orange-300">·</span>
            ) : null}
          </button>
          {/* Its own window for the same reason Missions has one, plus a second:
              deciding what Jarvis may keep about you is not something to do inside a
              panel that disappears when the HUD hides on Escape. */}
          <button
            className="rounded px-2 py-0.5 text-[10px] text-slate-500 hover:bg-white/5 hover:text-slate-200"
            onClick={() => jarvis?.openMemoryWindow()}
            title="What Jarvis remembers about you — edit it, or delete it"
          >
            Memory
          </button>
          <button
            className="rounded px-2 py-0.5 text-[10px] text-slate-500 hover:bg-white/5 hover:text-slate-200"
            onClick={() => (panel === "activity" ? setPanel(null) : openPanel("activity"))}
            title="What Jarvis has been allowing and refusing"
          >
            Activity
            {/* The count rides on the button because the panel is closed by
                default — a refusal nobody can see is not a record of one. */}
            {refused > 0 && <span className="ml-1 text-red-300">{refused}</span>}
          </button>
          <button
            className="rounded px-2 text-slate-500 hover:bg-white/5 hover:text-slate-200"
            onClick={() => jarvis?.hideWindow()}
            title="Hide — Jarvis keeps running in the tray"
          >
            ✕
          </button>
        </div>
      </header>

      <main className="relative flex flex-1 flex-col overflow-hidden">
        {/* The centrepiece. A defined region rather than a full-bleed backdrop
            behind the conversation: a live particle field under a paragraph of
            Hermes' output costs more in readability than it buys in atmosphere,
            and a canvas that is 40% of the panel is 40% of the fragment cost.
            Everything inside it is still fully responsive — the core reads its
            own box, and the particle budget follows it. */}
        <div className="relative h-[42%] min-h-[190px] shrink-0">
          <Suspense
            fallback={
              <div className="grid h-full w-full place-items-center bg-black/60">
                <Orb facts={facts} level={level} />
              </div>
            }
          >
            {/* `showLabel` off: the conversation's empty state below already says
                the same words, from the same capture fact, at a contrast that
                does not fight the particle field. Two captions is one too many. */}
            <NeuralCore ref={core} facts={facts} level={level} showLabel={false} />
          </Suspense>

          {/* Fade the bottom edge into the panel instead of cutting it off. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-[#0d0805] to-transparent" />
        </div>

        <div ref={scroller} className="relative mt-3 flex-1 space-y-3 overflow-y-auto px-5 pb-2">
          {turns.length === 0 && (
            <p className="pt-6 text-center text-xs text-slate-600">
              {/* The empty state should not promise a wake word that isn't
                  running. It reads the same capture fact the orb does. */}
              {voice.capturing
                ? `Say ${wakeWordPhrases(voice.wakeWord)
                    .map((p) => `“${p}”`)
                    .join(" or ")}, or type below.`
                : "Type below. Voice is not listening right now."}
            </p>
          )}
          {turns.map((t) => (
            <div
              key={t.id}
              className={t.role === "you" ? "text-right" : "text-left"}
            >
              <span
                className={`inline-block max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                  t.role === "you"
                    ? "bg-orange-500/10 text-orange-100"
                    : "bg-white/[0.04] text-slate-200"
                } ${t.pending ? "opacity-70" : ""}`}
              >
                {t.text}
              </span>
            </div>
          ))}
        </div>

        {error && (
          <p className="mx-5 mb-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        {panel && (
          <CommandCenter
            data={command}
            activity={activity}
            connected={facts.connected}
            tab={panel}
            onTab={setPanel}
            onClose={() => setPanel(null)}
          />
        )}

        {/* Last, so it paints over the conversation. One question at a time:
            a stack of dialogs is answered by clicking, not by reading. */}
        {ask && (
          <PermissionPrompt
            request={ask}
            onDecide={(id, d) => void decide(id, d)}
            disabled={!facts.connected}
          />
        )}
      </main>

      <footer className="border-t border-[#4a2a12] px-4 py-3">
        <div className="no-drag flex items-center gap-2">
          <input
            className="flex-1 rounded-full border border-[#4a2a12] bg-black/40 px-4 py-2 text-sm outline-none placeholder:text-slate-600 focus:border-orange-500/60"
            placeholder={facts.connected ? "Ask Jarvis…" : "Runtime not connected"}
            value={draft}
            disabled={!facts.connected}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            className="rounded-full bg-orange-500/20 px-4 py-2 text-sm text-orange-200 disabled:opacity-40"
            disabled={!canSubmit(facts, draft)}
            onClick={() => void send()}
          >
            Send
          </button>
        </div>

        <div className="no-drag mt-2 flex items-center justify-between text-[10px] text-slate-600">
          <span>
            Hermes: {hermes.state}
            {hermes.pid ? ` · pid ${hermes.pid}` : ""}
            {hermes.restartCount ? ` · ${hermes.restartCount} restarts` : ""}
            {" · "}
            {/* Voice reports capture, not just liveness: a running daemon with
                a muted or missing mic is not the same as one that hears you. */}
            Voice: {voice.capturing ? `listening · ${voice.wakeWord ?? "wake word"}` : voice.state}
            {voice.gaveUpReason ? ` · ${voice.gaveUpReason}` : ""}
          </span>
          <div className="flex gap-3">
            {voiceBroken && (
              <button
                className="hover:text-slate-300 disabled:opacity-40"
                disabled={!facts.connected}
                onClick={() => void jarvis?.restartVoice()}
              >
                Restart voice
              </button>
            )}
            <button
              className="hover:text-slate-300 disabled:opacity-40"
              disabled={!facts.connected}
              onClick={() => void jarvis?.setMuted(!facts.muted)}
            >
              {facts.muted ? "Enable mic" : "Disable mic"}
            </button>
            <button
              className="hover:text-slate-300 disabled:opacity-40"
              disabled={!facts.connected}
              onClick={() => void jarvis?.cancel()}
            >
              Cancel
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

// --- command center helpers ------------------------------------------------

/**
 * A bridge promise as a `Section`.
 *
 * `null` becomes a failure rather than an empty view, and that is the whole
 * reason this wrapper exists. `getMcp()` resolves to `null` when the runtime had
 * no answer — which is not the same fact as "no servers are configured", and
 * rendering it as the latter would be precisely the false all-clear
 * `command-model` is built to prevent.
 */
async function asSection<T>(p: Promise<T | null>): Promise<Section<T>> {
  try {
    const data = await p;
    if (data === null || data === undefined) {
      return { status: "failed", error: "the runtime had no answer for this" };
    }
    return { status: "ready", data };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Which tab the attention badge opens: whatever actually raised the count. */
function attentionTab(data: CommandData): CommandTabId {
  const flagged =
    data.mcp.status === "ready" && data.mcp.data.servers.some((s) => s.suspicious.length > 0);
  // MCP first when both are wrong: a planted server is somebody else's doing,
  // and a stopped scheduler is usually the user's own machine being a machine.
  return flagged ? "mcp" : "tasks";
}

// --- turn helpers ----------------------------------------------------------

function upsertPending(
  turns: Turn[],
  role: Turn["role"],
  text: string,
  pending: boolean,
  nextId: { current: number },
): Turn[] {
  const last = turns.at(-1);
  if (last?.pending && last.role === role) {
    return [...turns.slice(0, -1), { ...last, text, pending }];
  }
  return [...turns, { id: nextId.current++, role, text, pending }];
}

function appendPending(
  turns: Turn[],
  role: Turn["role"],
  chunk: string,
  nextId: { current: number },
): Turn[] {
  const last = turns.at(-1);
  if (last?.pending && last.role === role) {
    return [...turns.slice(0, -1), { ...last, text: last.text + chunk }];
  }
  return [...turns, { id: nextId.current++, role, text: chunk, pending: true }];
}
