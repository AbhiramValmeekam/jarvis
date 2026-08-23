/**
 * The Memory page — what Jarvis knows about you, and how you take it away.
 *
 * Its own window on `#/memory`, the same bundle and the same preload bridge as the
 * HUD and Mission Control. Four layers are shown because Jarvis keeps four and
 * confusing them is the mistake this page exists to prevent: memories you dictated,
 * eight profile fields, a history of what happened, and a queue of things Jarvis is
 * *offering* to remember and has not.
 *
 * Every judgement — what similarity search may be called, what "off" means, which
 * outcomes read as good, what deleting everything would delete — is in
 * `memory-model.ts`, tested without a DOM. This file is the arrangement.
 *
 * What the page cannot do is as deliberate as what it can. There is no way here to
 * write an inferred value, no way to invent a suggestion, and no way to accept one
 * the runtime did not queue; every write goes through the same store method that
 * dictation does, behind the same screen, and a refusal comes back as a sentence
 * this page shows rather than an error it hides.
 */
import { useEffect, useState } from "react";
import {
  applyResult,
  confirmsForgetEverything,
  CONFIRM_PHRASE,
  dismissNotice,
  embedderLook,
  emptyMessage,
  emptyScreen,
  enabledLook,
  episodeLine,
  failedToLoad,
  forgetEverythingSummary,
  loaded,
  proposalLine,
  storeLine,
  toEntryRows,
  toEpisodeRows,
  toProfileRows,
  toProposalRows,
  type EpisodeTone,
  type MemoryScreen,
} from "../memory-model";
import { hermesMemoryLine } from "../command-model";
import type { MemoryWriteResult, RuntimeStatus } from "../../ipc/contract";

/** The preload bridge. Absent only if the page is opened outside Electron. */
const jarvis = window.jarvis;

const CARD = "rounded-lg border border-[#4a2a12] bg-black/30 p-4";
const LABEL = "text-[10px] uppercase tracking-[0.2em] text-slate-500";
const INPUT =
  "w-full rounded border border-[#4a2a12] bg-black/40 px-3 py-2 text-sm text-slate-100 " +
  "placeholder:text-slate-600 focus:border-orange-500/60 focus:outline-none";
const BUTTON =
  "rounded border border-[#1c4463] bg-white/[0.03] px-3 py-1.5 text-xs text-slate-200 " +
  "hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-40";
const DANGER =
  "rounded border border-red-500/40 bg-red-500/[0.07] px-3 py-1.5 text-xs text-red-200 " +
  "hover:bg-red-500/[0.14] disabled:cursor-not-allowed disabled:opacity-40";

const EPISODE_TONE: Record<EpisodeTone, string> = {
  good: "border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-200",
  bad: "border-red-500/40 bg-red-500/[0.06] text-red-200",
  waiting: "border-sky-400/50 bg-sky-500/[0.08] text-sky-200",
  muted: "border-slate-800 bg-white/[0.01] text-slate-400",
};

export default function Memory() {
  const [screen, setScreen] = useState<MemoryScreen>(emptyScreen);
  const [linked, setLinked] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [profileDraft, setProfileDraft] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const now = Date.now();

  useEffect(() => {
    if (!jarvis) return;

    const refresh = (): void => {
      void jarvis
        .getMemory()
        .then((v) => {
          setLinked(true);
          setScreen((s) => (v ? loaded(s, v) : failedToLoad(s, "the runtime returned nothing")));
        })
        .catch((err: unknown) => {
          setScreen((s) => failedToLoad(s, describe(err)));
        });
    };
    refresh();

    // Status only, to know whether the link is up. This page has no live feed of
    // its own: a memory changes when someone changes it, and the write that did so
    // answers with the new view.
    void jarvis.getStatus().then((s: RuntimeStatus | null) => setLinked(s !== null));
    const offLink = jarvis.onLink((up) => {
      setLinked(up);
      if (up) refresh();
    });
    return offLink;
  }, []);

  const view = screen.view;
  const connected = linked;
  const message = emptyMessage(screen, connected);

  /** One write, and the view it answered with. Every button goes through here. */
  async function write(run: () => Promise<MemoryWriteResult | null>): Promise<void> {
    if (!jarvis || busy) return;
    setBusy(true);
    try {
      const result = await run();
      setScreen((s) => applyResult(s, result));
    } catch (err) {
      setScreen((s) => failedToLoad(s, describe(err)));
    } finally {
      setBusy(false);
    }
  }

  const rows = view ? toEntryRows(view, now) : [];
  const profile = view ? toProfileRows(view, now) : [];
  const episodes = view ? toEpisodeRows(view, now) : [];
  const proposals = view ? toProposalRows(view, now) : [];
  const enabled = view ? enabledLook(view) : null;
  const embedder = view ? embedderLook(view) : null;

  return (
    <div className="min-h-screen bg-[#0d0805] px-6 py-5 text-slate-200">
      <header className="mb-5 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-lg font-medium tracking-wide text-slate-100">Memory</h1>
          <p className="mt-1 text-xs text-slate-500">
            What Jarvis keeps about you. Everything here is editable and deletable, and
            nothing here was inferred.
          </p>
        </div>
        <span className={`text-xs ${connected ? "text-emerald-300/80" : "text-red-300/80"}`}>
          {connected ? "Connected" : "Not connected"}
        </span>
      </header>

      {screen.notice && (
        <div
          className={`mb-4 flex items-start justify-between gap-4 rounded border px-3 py-2 text-xs ${
            screen.notice.tone === "ok"
              ? "border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-200"
              : "border-amber-500/40 bg-amber-500/[0.07] text-amber-200"
          }`}
        >
          <span>{screen.notice.text}</span>
          <button
            className="shrink-0 text-slate-400 hover:text-slate-200"
            onClick={() => setScreen(dismissNotice)}
          >
            dismiss
          </button>
        </div>
      )}

      {message && <p className="mb-4 text-sm text-slate-400">{message}</p>}

      {view && enabled && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            {/* --- the switch ------------------------------------------------ */}
            <section className={CARD}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className={LABEL}>The switch</p>
                  <p
                    className={`mt-1 text-sm ${
                      enabled.on ? "text-emerald-200" : "text-amber-200"
                    }`}
                  >
                    {enabled.label}
                  </p>
                </div>
                <button
                  className={BUTTON}
                  disabled={busy || !connected}
                  onClick={() =>
                    void write(() => jarvis!.setMemoryEnabled(!enabled.on))
                  }
                >
                  {enabled.on ? "Switch memory off" : "Switch memory on"}
                </button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">{enabled.detail}</p>
            </section>

            {/* --- memories -------------------------------------------------- */}
            <section className={CARD}>
              <div className="flex items-baseline justify-between gap-4">
                <p className={LABEL}>Memories</p>
                <span className="text-[11px] text-slate-500">{storeLine(view)}</span>
              </div>

              <form
                className="mt-3 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const text = draft.trim();
                  if (!text) return;
                  setDraft("");
                  void write(() => jarvis!.remember(text));
                }}
              >
                <input
                  className={INPUT}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Something worth remembering — a preference, a place, a way you work"
                  aria-label="A new memory"
                />
                <button className={BUTTON} disabled={busy || !draft.trim() || !connected}>
                  Save
                </button>
              </form>
              <p className="mt-2 text-[11px] text-slate-500">
                Anything that looks like a password, key or token is refused rather than
                saved with the secret blanked out — a memory that reads
                <span className="text-slate-400"> [redacted]</span> would look answered and
                be useless.
              </p>

              <ul className="mt-3 space-y-2">
                {rows.length === 0 && (
                  <li className="text-xs text-slate-500">Nothing saved yet.</li>
                )}
                {rows.map((row) => (
                  <li
                    key={row.id}
                    className="rounded border border-slate-800 bg-white/[0.015] px-3 py-2"
                  >
                    {editing?.id === row.id ? (
                      <form
                        className="flex gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const text = editing.text.trim();
                          if (!text) return;
                          setEditing(null);
                          void write(() => jarvis!.editMemory(row.id, text));
                        }}
                      >
                        <input
                          className={INPUT}
                          autoFocus
                          value={editing.text}
                          onChange={(e) => setEditing({ id: row.id, text: e.target.value })}
                          aria-label="Edit this memory"
                        />
                        <button className={BUTTON} disabled={busy}>
                          Save
                        </button>
                        <button type="button" className={BUTTON} onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <>
                        <p className="text-sm leading-relaxed text-slate-200">{row.text}</p>
                        <div className="mt-1.5 flex items-center gap-3 text-[11px] text-slate-500">
                          <span>{row.when}</span>
                          {row.edited && <span className="text-slate-400">{row.edited}</span>}
                          <button
                            className="ml-auto text-slate-400 hover:text-slate-200"
                            disabled={busy}
                            onClick={() => setEditing({ id: row.id, text: row.text })}
                          >
                            edit
                          </button>
                          <button
                            className="text-red-300/80 hover:text-red-200"
                            disabled={busy}
                            onClick={() => void write(() => jarvis!.forgetMemory(row.id))}
                          >
                            forget
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            {/* --- suggestions ----------------------------------------------- */}
            <section className={CARD}>
              <p className={LABEL}>Offered, not kept</p>
              <p className="mt-1 text-xs text-slate-400">{proposalLine(view)}</p>
              <ul className="mt-3 space-y-2">
                {proposals.map((p) => (
                  <li
                    key={p.id}
                    className="rounded border border-sky-500/30 bg-sky-500/[0.05] px-3 py-2"
                  >
                    <p className="text-sm leading-relaxed text-slate-100">{p.text}</p>
                    <p className="mt-1 text-[11px] text-sky-200/80">{p.target}</p>
                    {/* Provenance, so a suggestion can be checked rather than guessed
                        at. This is a statement about which mission and which step —
                        never an account of a model's reasoning. */}
                    <p className="mt-1 text-[11px] text-slate-500">
                      Because: {p.why} · {p.when}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        className={BUTTON}
                        disabled={busy || !connected}
                        onClick={() =>
                          void write(() => jarvis!.resolveLearning(p.id, "accept"))
                        }
                      >
                        Remember this
                      </button>
                      <button
                        className={BUTTON}
                        disabled={busy || !connected}
                        onClick={() =>
                          void write(() => jarvis!.resolveLearning(p.id, "reject"))
                        }
                      >
                        No thanks
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {/* --- episodes -------------------------------------------------- */}
            <section className={CARD}>
              <div className="flex items-baseline justify-between gap-4">
                <p className={LABEL}>What happened</p>
                <span className="text-[11px] text-slate-500">{episodeLine(view)}</span>
              </div>
              <ul className="mt-3 space-y-2">
                {episodes.map((e) => (
                  <li key={e.id} className={`rounded border px-3 py-2 ${EPISODE_TONE[e.tone]}`}>
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-sm leading-snug">{e.title}</p>
                      <span className="shrink-0 text-[11px] uppercase tracking-wider opacity-80">
                        {e.outcome}
                      </span>
                    </div>
                    {e.detail && (
                      <p className="mt-1 text-xs leading-relaxed text-slate-300/90">{e.detail}</p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-400/90">
                      <span>{e.when}</span>
                      {e.duration && <span>{e.duration}</span>}
                      {e.tools && <span>tools: {e.tools}</span>}
                      <button
                        className="ml-auto text-red-300/80 hover:text-red-200"
                        disabled={busy}
                        onClick={() => void write(() => jarvis!.forgetEpisode(e.id))}
                      >
                        forget
                      </button>
                    </div>
                    {e.redacted && (
                      <p className="mt-1 text-[11px] text-amber-200/90">{e.redacted}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {/* --- right column ------------------------------------------------ */}
          <div className="space-y-4">
            {/* --- profile --------------------------------------------------- */}
            <section className={CARD}>
              <p className={LABEL}>About you</p>
              <p className="mt-1 text-xs text-slate-400">
                Eight fields, and only these eight. No address, no employer, no phone
                number, no birthday — a shorter list is the whole point of having one.
              </p>
              <div className="mt-3 space-y-3">
                {profile.map((f) => {
                  const draftValue = profileDraft[f.key];
                  const value = draftValue ?? f.value;
                  const dirty = draftValue !== undefined && draftValue !== f.value;
                  return (
                    <div key={f.key}>
                      <label
                        className="block text-[11px] text-slate-300"
                        htmlFor={`profile-${f.key}`}
                      >
                        {f.label}
                      </label>
                      <div className="mt-1 flex gap-2">
                        <input
                          id={`profile-${f.key}`}
                          className={INPUT}
                          value={value}
                          maxLength={f.max}
                          placeholder={f.hint}
                          onChange={(e) =>
                            setProfileDraft((d) => ({ ...d, [f.key]: e.target.value }))
                          }
                        />
                        <button
                          className={BUTTON}
                          disabled={busy || !dirty || !connected}
                          onClick={() => {
                            const typed = (profileDraft[f.key] ?? "").trim();
                            setProfileDraft((d) => {
                              const next = { ...d };
                              delete next[f.key];
                              return next;
                            });
                            // An emptied field clears it. `undefined`, not "" —
                            // absent is what the runtime reads as "clear this".
                            void write(() =>
                              jarvis!.setProfile(f.key, typed === "" ? undefined : typed),
                            );
                          }}
                        >
                          Save
                        </button>
                      </div>
                      <p className="mt-1 text-[11px] text-slate-500">
                        {f.provenance ?? "not set"}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* --- similarity ------------------------------------------------ */}
            <section className={CARD}>
              <p className={LABEL}>Finding things</p>
              {embedder ? (
                <>
                  <p
                    className={`mt-1 text-sm ${
                      embedder.semantic ? "text-emerald-200" : "text-slate-200"
                    }`}
                  >
                    {embedder.label}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">
                    {embedder.detail}
                  </p>
                  <p className="mt-2 font-mono text-[11px] text-slate-500">{embedder.reason}</p>
                </>
              ) : (
                <p className="mt-1 text-xs text-slate-400">
                  No similarity index in this run — retrieval is keyword and recency only.
                </p>
              )}
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                Whatever is retrieved reaches a plan as a citation, fenced as data. A
                memory is never read as an instruction, however it is worded.
              </p>
            </section>

            {/* --- Hermes' own store ----------------------------------------- */}
            <section className={CARD}>
              <p className={LABEL}>Hermes</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                {hermesMemoryLine(view)}
              </p>
            </section>

            {/* --- forget everything ----------------------------------------- */}
            <section className="rounded-lg border border-red-500/30 bg-red-500/[0.04] p-4">
              <p className={LABEL}>Forget everything</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-300">
                {forgetEverythingSummary(view)}
              </p>
              <p className="mt-2 text-[11px] text-slate-400">
                Type <span className="font-mono text-slate-200">{CONFIRM_PHRASE}</span> to
                confirm.
              </p>
              <div className="mt-2 flex gap-2">
                <input
                  className={INPUT}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={CONFIRM_PHRASE}
                  aria-label={`Type ${CONFIRM_PHRASE} to confirm`}
                />
                <button
                  className={DANGER}
                  disabled={busy || !connected || !confirmsForgetEverything(confirm)}
                  onClick={() => {
                    setConfirm("");
                    void write(() => jarvis!.forgetEverything(CONFIRM_PHRASE));
                  }}
                >
                  Forget it all
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
