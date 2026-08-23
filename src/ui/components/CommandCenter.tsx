import { useEffect, useState } from "react";
import {
  toTaskRows,
  tasksBanner,
  tasksEmpty,
  toMcpRows,
  mcpEmpty,
  mcpBanner,
  toMemoryRows,
  hermesMemoryLine,
  memoryHeadroom,
  filterSkills,
  skillsSummary,
  sectionMessage,
  type CommandData,
  type CommandTabId,
  type Section,
} from "../command-model";
import { ActivityView } from "./ActivityView";
import type {
  ActivityEntry,
  McpView,
  MemoryView,
  SkillsView,
  TasksView,
} from "../../ipc/contract";

/**
 * The Command Center.
 *
 * Phases 8, 9 and 10 built four answers about an assistant that runs whether or
 * not anyone is looking at it — what it will do on a schedule, what is plugged
 * into it, what it remembers, and what it can do — and shipped all four over the
 * wire. This panel is where they became visible; before it, `get_tasks` had a
 * handler in main, a method in the preload bridge, and no caller anywhere.
 *
 * Every judgement lives in `command-model`, which is tested without a DOM,
 * including the ones that carry weight: that an unreadable config never renders
 * as "no servers", that a job over a dead scheduler never renders a countdown,
 * and that a flagged MCP entry sorts to the top. This file renders that and adds
 * nothing of its own.
 */
export function CommandCenter({
  data,
  activity,
  connected,
  onClose,
  tab,
  onTab,
}: {
  data: CommandData;
  activity: readonly ActivityEntry[];
  connected: boolean;
  onClose: () => void;
  /**
   * Which tab is showing. Controlled by `App`, not held here.
   *
   * It was local state seeded from an `initialTab` prop, which looked tidier and
   * was wrong: the header's attention badge opens the tab that raised the
   * warning, and with the panel already open a seeded `useState` ignores the new
   * value and leaves the user on whatever they were reading. A control that
   * silently does nothing is worse than one that isn't offered.
   */
  tab: CommandTabId;
  onTab: (tab: CommandTabId) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState("");

  // "next in 12 minutes" is only true for a minute. A panel left open on a second
  // monitor is the normal case for this window, so the countdown has to keep up
  // or it becomes the stale claim the whole model exists to avoid.
  useEffect(() => {
    if (tab !== "tasks") return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [tab]);

  if (tab === "activity") {
    return <ActivityView entries={activity} connected={connected} onClose={onClose} />;
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-[#0d0805]/95 backdrop-blur-sm">
      <div className="no-drag flex items-center justify-between border-b border-[#4a2a12] px-3 py-2">
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`rounded px-2 py-1 text-[10px] uppercase tracking-wider transition-colors ${
                tab === t.id
                  ? "bg-orange-500/15 text-orange-200"
                  : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
              }`}
              onClick={() => onTab(t.id)}
              title={t.hint}
            >
              {t.label}
              {badgeFor(t.id, data) > 0 && (
                <span className="ml-1 text-red-300">{badgeFor(t.id, data)}</span>
              )}
            </button>
          ))}
        </nav>
        <button
          className="rounded px-2 text-slate-500 hover:bg-white/5 hover:text-slate-200"
          onClick={onClose}
          aria-label="Close command center"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {tab === "tasks" && <TasksPanel section={data.tasks} connected={connected} now={now} />}
        {tab === "mcp" && <McpPanel section={data.mcp} connected={connected} />}
        {tab === "memory" && <MemoryPanel section={data.memory} connected={connected} now={now} />}
        {tab === "skills" && (
          <SkillsPanel
            section={data.skills}
            connected={connected}
            query={query}
            onQuery={setQuery}
          />
        )}
      </div>
    </div>
  );
}

const TABS: { id: CommandTabId; label: string; hint: string }[] = [
  { id: "tasks", label: "Scheduled", hint: "What Hermes will run without being asked" },
  { id: "mcp", label: "Connected", hint: "The MCP servers Hermes is configured with" },
  { id: "memory", label: "Memory", hint: "What Jarvis has been told to remember" },
  { id: "skills", label: "Skills", hint: "What Jarvis can actually do" },
  { id: "activity", label: "Activity", hint: "What Jarvis has allowed and refused" },
];

/** Per-tab attention counts. Only two tabs can carry a problem worth a badge. */
function badgeFor(id: CommandTabId, data: CommandData): number {
  if (id === "mcp" && data.mcp.status === "ready") {
    return data.mcp.data.servers.filter((s) => s.suspicious.length > 0).length;
  }
  if (id === "tasks" && data.tasks.status === "ready" && data.tasks.data.warning) return 1;
  return 0;
}

/** Loading and failure, in the panel's own words. Null once there is data. */
function Message<T>({ section, connected }: { section: Section<T>; connected: boolean }) {
  const text = sectionMessage(section, connected);
  if (text === null) return null;
  return <p className="pt-8 text-center text-xs text-slate-600">{text}</p>;
}

function Banner({ text, tone }: { text: string; tone: "warning" | "ok" }) {
  return (
    <p
      className={`mb-2 rounded border px-3 py-2 text-[11px] leading-relaxed ${
        tone === "warning"
          ? "border-amber-400/40 bg-amber-500/[0.07] text-amber-200"
          : "border-[#4a2a12] text-slate-500"
      }`}
    >
      {text}
    </p>
  );
}

function TasksPanel({
  section,
  connected,
  now,
}: {
  section: Section<TasksView>;
  connected: boolean;
  now: number;
}) {
  if (section.status !== "ready") return <Message section={section} connected={connected} />;
  const view = section.data;
  const rows = toTaskRows(view, now);
  const banner = tasksBanner(view);

  return (
    <>
      {banner && <Banner text={banner.text} tone={banner.tone} />}
      {rows.length === 0 ? (
        <p className="pt-8 text-center text-xs text-slate-600">{tasksEmpty(view)}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li
              key={r.key}
              className={`rounded-lg border-l-2 px-2 py-1.5 ${
                r.tone === "failed"
                  ? "border-red-400/70 bg-red-500/[0.07]"
                  : r.tone === "warning"
                    ? "border-amber-400/60 bg-amber-500/[0.05]"
                    : "border-slate-700/60"
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="truncate text-[12px] text-slate-200">{r.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-600">
                  {r.schedule}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px]">
                <span className={r.tone === "warning" ? "text-amber-300/80" : "text-slate-500"}>
                  {r.timing}
                </span>
                <span className="italic text-slate-600">{r.history}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 border-t border-[#4a2a12] pt-2 text-[10px] text-slate-600">
        {/* Said outright, because a list with no create button invites the
            question, and the answer is a design decision rather than a gap. */}
        Jarvis reads this list and never writes it. Ask it to schedule something and Hermes
        creates the job itself.
      </p>
    </>
  );
}

function McpPanel({
  section,
  connected,
}: {
  section: Section<McpView>;
  connected: boolean;
}) {
  if (section.status !== "ready") return <Message section={section} connected={connected} />;
  const view = section.data;
  const rows = toMcpRows(view);
  const banner = mcpBanner(view);

  return (
    <>
      {banner && <Banner text={banner} tone="warning" />}
      {rows.length === 0 ? (
        <p className="pt-8 text-center text-xs leading-relaxed text-slate-600">{mcpEmpty(view)}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li
              key={r.key}
              className={`rounded-lg border-l-2 px-2 py-1.5 ${
                r.tone === "flagged"
                  ? "border-red-400/70 bg-red-500/[0.07]"
                  : r.tone === "disabled"
                    ? "border-slate-800 opacity-60"
                    : "border-slate-700/60"
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="text-[12px] text-slate-200">{r.name}</span>
                {!r.enabled && <span className="text-[10px] text-slate-500">disabled</span>}
                <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-slate-600">
                  {r.origin}
                </span>
              </div>
              {(r.needs || r.filters) && (
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-600">
                  {/* Names only. The values are API keys Hermes resolves at spawn
                      time and this process never holds (§53). */}
                  {r.needs && <span>needs {r.needs}</span>}
                  {r.filters && <span>{r.filters}</span>}
                </div>
              )}
              {r.warnings.map((w, i) => (
                <p key={i} className="mt-1 text-[11px] leading-relaxed text-red-300">
                  {w}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 border-t border-[#4a2a12] pt-2 text-[10px] leading-relaxed text-slate-600">
        An MCP entry is a command Hermes runs with your environment. Jarvis reads this list and
        never adds to it — use `hermes mcp add`, which screens what it saves.
      </p>
    </>
  );
}

function MemoryPanel({
  section,
  connected,
  now,
}: {
  section: Section<MemoryView>;
  connected: boolean;
  now: number;
}) {
  if (section.status !== "ready") return <Message section={section} connected={connected} />;
  const view = section.data;
  const rows = toMemoryRows(view, now);

  return (
    <>
      <div className="mb-2 flex items-baseline justify-between text-[10px] text-slate-600">
        <span>{hermesMemoryLine(view)}</span>
        <span className="shrink-0 pl-2 font-mono">{memoryHeadroom(view)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="pt-8 text-center text-xs text-slate-600">
          Nothing yet. Say “Jarvis, remember that…” and it will appear here.
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.key} className="rounded-lg border-l-2 border-slate-700/60 px-2 py-1.5">
              <p className="text-[12px] leading-relaxed text-slate-200">{r.text}</p>
              <span className="text-[10px] text-slate-600">{r.when}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 border-t border-[#4a2a12] pt-2 text-[10px] leading-relaxed text-slate-600">
        {/* Explains an absence people notice: there is no delete button. Forgetting
            is spoken so the removal is something the user said, not something a
            window decided. */}
        Say “forget that” to remove one. Anything that looks like a password or key is refused
        rather than stored.
      </p>
    </>
  );
}

function SkillsPanel({
  section,
  connected,
  query,
  onQuery,
}: {
  section: Section<SkillsView>;
  connected: boolean;
  query: string;
  onQuery: (q: string) => void;
}) {
  if (section.status !== "ready") return <Message section={section} connected={connected} />;
  const view = section.data;
  const rows = filterSkills(view, query);

  return (
    <>
      <div className="mb-2 flex items-center gap-2">
        <input
          className="flex-1 rounded-full border border-[#4a2a12] bg-black/40 px-3 py-1 text-[11px] outline-none placeholder:text-slate-600 focus:border-orange-500/60"
          placeholder="Filter skills…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <span className="shrink-0 text-[10px] text-slate-600">{skillsSummary(view)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="pt-8 text-center text-xs text-slate-600">
          {view.skills.length === 0 ? "No skills are installed." : "Nothing matches that."}
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.key} className="rounded-lg border-l-2 border-slate-700/60 px-2 py-1.5">
              <div className="flex items-baseline gap-2">
                <span className="text-[12px] text-slate-200">{r.name}</span>
                <span className="text-[10px] text-slate-600">{r.category}</span>
                {r.source === "user" && (
                  <span className="ml-auto shrink-0 text-[10px] text-orange-400/70">yours</span>
                )}
              </div>
              {r.description && (
                <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{r.description}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
