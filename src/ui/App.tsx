import { useEffect, useRef, useState } from "react";
import { Orb } from "./components/Orb";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { ActivityView } from "./components/ActivityView";
import { canSubmit, wakeWordPhrase, type HudFacts } from "./hud-model";
import { currentRequest, type PermissionRequestEvent } from "./permission-model";
import { appendEntry, mergeBacklog, refusedCount } from "./activity-model";
import type { ActivityEntry, RuntimeStatus, ServerEvent } from "../ipc/contract";

/** The preload bridge. Absent only if the page is opened outside Electron. */
const jarvis = window.jarvis;

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
  const [showActivity, setShowActivity] = useState(false);
  const nextId = useRef(1);
  const scroller = useRef<HTMLDivElement>(null);

  const facts: HudFacts = {
    connected: linked && status !== null,
    state: status?.state ?? "idle",
    muted: status?.muted ?? false,
    listening: status?.listening ?? false,
    hermesState: status?.hermes.state ?? "unknown",
    ...(status
      ? {
          voiceState: status.voice.state,
          capturing: status.voice.capturing,
          wakeWord: status.voice.wakeWord,
        }
      : {}),
  };

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

    const offLink = jarvis.onLink((up) => {
      setLinked(up);
      // Decisions taken while detached are only in the runtime's log, so a
      // reconnect has to go and ask rather than resume appending.
      if (up) loadActivity();
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

  return (
    <div className="flex h-full flex-col bg-[#05070d]/85 backdrop-blur-xl text-slate-300">
      {/* Title bar — the only draggable region. */}
      <header className="drag flex items-center justify-between border-b border-[#12304a] px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold tracking-[0.3em] text-cyan-300">JARVIS</span>
          <span className="text-[10px] text-slate-500">
            {facts.connected ? "connected" : "offline"}
          </span>
        </div>
        <div className="no-drag flex items-center gap-1">
          <button
            className="rounded px-2 py-0.5 text-[10px] text-slate-500 hover:bg-white/5 hover:text-slate-200"
            onClick={() => setShowActivity((v) => !v)}
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
        <div className="pt-6">
          <Orb facts={facts} level={level} />
        </div>

        <div ref={scroller} className="mt-4 flex-1 space-y-3 overflow-y-auto px-5 pb-2">
          {turns.length === 0 && (
            <p className="pt-6 text-center text-xs text-slate-600">
              {/* The empty state should not promise a wake word that isn't
                  running. It reads the same capture fact the orb does. */}
              {voice.capturing
                ? `Say “${wakeWordPhrase(voice.wakeWord)}”, or type below.`
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
                    ? "bg-cyan-500/10 text-cyan-100"
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

        {showActivity && (
          <ActivityView
            entries={activity}
            connected={facts.connected}
            onClose={() => setShowActivity(false)}
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

      <footer className="border-t border-[#12304a] px-4 py-3">
        <div className="no-drag flex items-center gap-2">
          <input
            className="flex-1 rounded-full border border-[#12304a] bg-black/40 px-4 py-2 text-sm outline-none placeholder:text-slate-600 focus:border-cyan-500/60"
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
            className="rounded-full bg-cyan-500/20 px-4 py-2 text-sm text-cyan-200 disabled:opacity-40"
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
