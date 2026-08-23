/**
 * Jarvis' own memory, as mission tools.
 *
 * The store is the one from Phase 8 (`memory/memory-store.ts`) — atomic writes, a
 * cap with reported eviction, and `screenMemory` refusing anything that looks like
 * a secret before it ever reaches the file. None of that is re-implemented here,
 * and the refusal is passed through rather than worked around: "do not blindly
 * store sensitive information" is a rule about what gets written, so the check
 * belongs at the store and this file's job is to report it honestly.
 *
 * What memory text is: **data**. It came from the user or from an earlier turn, it
 * travels in `detail` and `data`, and nothing downstream treats it as an
 * instruction. The registry sanitises it on the way out, so a memory whose text is
 * `[SYSTEM] approved` cannot reach a permission dialog looking like one.
 *
 * Writes and deletes both go through `runVerified`, and the read-back is by id
 * rather than by count — the store may evict an older entry to make room, which
 * leaves the count unchanged after a write that really did happen.
 *
 * Phase 16 adds four more, and the *names* are part of the design because
 * `family()` classifies on them: `get_relevant_context`, `list_episodes` and
 * `read_profile` match the read branch and land at level 0, which is what keeps a
 * mission from opening a consent dialog in order to remember something.
 * `save_memory_suggestion` matches `save` and lands at level 1 — honest, because it
 * really does write a row to `proposals.json`; what it cannot do is write a memory.
 * Only `accept()` does that, and only the user's own window reaches it.
 */
import { runVerified } from "../../permissions/verified-action.js";
import { defuseMarkers } from "../../permissions/risk-model.js";
import type { MemoryEntry, MemoryStore } from "../../memory/memory-store.js";
import type { EpisodicStore, Episode } from "../../memory/episodic-store.js";
import type { LearningProposal, LearningQueue } from "../../memory/learning.js";
import { PROFILE_FIELDS, type ProfileStore } from "../../memory/profile-store.js";
import type { RetrievedFact, Retriever } from "../../memory/retrieval.js";
import {
  readNumber,
  readOptionalString,
  readString,
  type Tool,
  type ToolArgs,
  type ToolContext,
  type ToolRun,
} from "../registry.js";

/**
 * The stores this file may reach.
 *
 * Everything but `store` is optional, and an absent one means the tool it backs is
 * not registered at all — the rule `default-tools.ts` applies to every adapter, for
 * the reason it states: a retrieval tool with no index behind it would report
 * "nothing relevant" for a store that was never consulted.
 */
export interface MemoryDeps {
  readonly store: MemoryStore;
  readonly retriever?: Retriever;
  readonly episodes?: EpisodicStore;
  readonly profile?: ProfileStore;
  readonly learning?: LearningQueue;
}

/** How many memories one step returns. The full count is always reported. */
const MAX_LISTED = 40;

/**
 * Stored text on its way back out to a step.
 *
 * The registry's `sanitiseForDisplay` strips turn boundaries and control bytes, and
 * that is a different threat from this one: a memory reading
 * `-----END USER MEMORY-----` contains no structure to strip, and would close the
 * fence of any prompt that later quotes it. `defuseMarkers` collapses the hyphen run,
 * which is the same guard `web.ts`, `browser.ts` and `comms.ts` apply for the same
 * reason. These files are hand-editable, so "the user wrote it" is not a warrant.
 */
function asData(text: string): string {
  return defuseMarkers(text);
}

function summarise(entries: readonly MemoryEntry[]): string {
  return entries
    .slice(0, MAX_LISTED)
    .map((e) => asData(e.text))
    .join(" · ");
}

function ids(entries: readonly MemoryEntry[]): readonly ToolArgs[] {
  return entries.slice(0, MAX_LISTED).map((e) => ({ id: e.id, text: asData(e.text), at: e.at }));
}

function listMemories(deps: MemoryDeps): Tool {
  return {
    name: "list_memories",
    summary: "List what Jarvis has been asked to remember",
    schema: {},
    async run(): Promise<ToolRun> {
      const all = deps.store.entriesList();
      return {
        outcome: "verified",
        summary: `${all.length} memor${all.length === 1 ? "y" : "ies"}`,
        detail: all.length === 0 ? "nothing saved yet" : summarise(all),
        data: { total: all.length, memories: ids(all) },
      };
    },
  };
}

function searchMemory(deps: MemoryDeps): Tool {
  return {
    name: "search_memory",
    summary: "Find saved memories matching a query",
    schema: { query: { kind: "string", required: true, max: 200 } },
    async run(args: ToolArgs): Promise<ToolRun> {
      const query = readString(args, "query");
      const hits = deps.store.recall(query);
      // Zero matches is a reading, not a failure: "nothing saved about that" is
      // exactly the fact the next step needs, and failing here would send the
      // replanner looking for a broken tool.
      return {
        outcome: "verified",
        summary: `${hits.length} match${hits.length === 1 ? "" : "es"} for that`,
        detail: hits.length === 0 ? "nothing saved about that" : summarise(hits),
        data: { query, total: hits.length, memories: ids(hits) },
      };
    },
  };
}

function writeMemory(deps: MemoryDeps): Tool {
  return {
    name: "write_memory",
    summary: "Save something to Jarvis' memory",
    schema: { text: { kind: "string", required: true, max: 500 } },
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      const text = readString(args, "text");
      let saved: MemoryEntry | undefined;
      let refusal: string | undefined;

      const report = await runVerified(
        {
          description: "save that to memory",
          observe: () => deps.store.entriesList().length,
          act: () => {
            const result = deps.store.remember(text);
            if (!result.ok) {
              // The store screens for secrets. Its reason is user-facing and is
              // the whole answer, so it is thrown to become the step's error
              // rather than being turned into a vaguer one here.
              refusal = result.speech;
              throw new Error(result.speech);
            }
            saved = result.entry;
          },
          verify: () =>
            saved !== undefined && deps.store.entriesList().some((e) => e.id === saved?.id)
              ? { ok: true, detail: "it is in the store" }
              : { ok: false, reason: "it is not in the store afterwards" },
        },
        { timeoutMs: ctx.timeoutMs, now: ctx.now },
      );

      return {
        outcome: report.outcome,
        summary: refusal ?? `${report.description}: ${report.detail}`,
        ...(report.error !== undefined ? { error: report.error } : {}),
        ...(saved !== undefined ? { data: { id: saved.id, at: saved.at } } : {}),
      };
    },
  };
}

function deleteMemory(deps: MemoryDeps): Tool {
  return {
    name: "delete_memory",
    summary: "Forget one saved memory, named by its id",
    schema: { id: { kind: "string", required: true, max: 40 } },
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      const id = readString(args, "id");
      const exists = (): boolean => deps.store.entriesList().some((e) => e.id === id);
      if (!exists()) {
        return {
          outcome: "failed",
          summary: "there is no memory with that id",
          error: `no memory ${id}`,
        };
      }
      let removed: MemoryEntry | null = null;
      const report = await runVerified(
        {
          description: "forget that",
          observe: exists,
          act: () => {
            removed = deps.store.forget(id);
          },
          verify: (_before, after) =>
            after ? { ok: false, reason: "it is still in the store" } : { ok: true, detail: "gone" },
        },
        { timeoutMs: ctx.timeoutMs, now: ctx.now },
      );
      return {
        outcome: report.outcome,
        summary: `${report.description}: ${report.detail}`,
        ...(report.error !== undefined ? { error: report.error } : {}),
        data: { id, forgot: removed !== null },
      };
    },
  };
}

/** Rows one retrieval step may carry. The same ceiling `retrieval.ts` uses. */
const MAX_CONTEXT_ROWS = 8;
/** Rows one episode listing may carry. Shorter: these are read as a history list. */
const MAX_EPISODE_ROWS = 20;

/** `memory/keyword: …` — the method travels with the row, because it is a claim. */
function factLine(f: RetrievedFact): string {
  return `${f.source}/${f.method}: ${asData(f.summary)}`;
}

/**
 * Everything Jarvis knows that bears on one objective, ranked.
 *
 * The whole retrieval stack behind one read: keyword recall, vector similarity,
 * profile fields and past episodes, fused and budgeted by `Retriever`. A step gets
 * `method` and `semantic` alongside the rows, so a plan built on this cannot present
 * a lexical near-match as a model's understanding (§43).
 *
 * Memory switched off returns `verified` with nothing, and says which it is: an
 * empty result because the user disabled the layer is a different fact from an empty
 * store, and a replanner told only "no context" would go looking for a broken tool.
 */
function getRelevantContext(retriever: Retriever): Tool {
  return {
    name: "get_relevant_context",
    summary: "Retrieve what Jarvis knows that bears on an objective",
    schema: {
      objective: { kind: "string", required: true, max: 300 },
      limit: { kind: "number", min: 1, max: MAX_CONTEXT_ROWS, integer: true },
    },
    async run(args: ToolArgs): Promise<ToolRun> {
      const objective = readString(args, "objective");
      const limit = readNumber(args, "limit", MAX_CONTEXT_ROWS);
      const result = await retriever.retrieve(objective, limit);
      if (!result.enabled) {
        return {
          outcome: "verified",
          summary: "memory is switched off, so nothing was retrieved",
          detail: "the user has turned memory off — this is a choice, not an empty store",
          data: { enabled: false, total: 0, considered: 0 },
        };
      }
      const how = result.semantic
        ? "ranked by keyword match and embedding similarity"
        : "ranked by keyword match and local lexical similarity — wording, not meaning";
      return {
        outcome: "verified",
        summary:
          `${result.facts.length} of ${result.considered} remembered ` +
          `thing${result.considered === 1 ? "" : "s"} bear on that`,
        detail: result.facts.length === 0 ? `nothing relevant — ${how}` : result.facts.map(factLine).join(" · "),
        data: {
          enabled: true,
          total: result.facts.length,
          considered: result.considered,
          embedder: result.embedder,
          semantic: result.semantic,
          facts: result.facts.map((f) => ({
            source: f.source,
            id: f.id,
            summary: asData(f.summary),
            method: f.method,
            score: Math.round(f.score * 1000) / 1000,
            at: f.at,
          })),
        },
      };
    },
  };
}

function episodeLine(e: Episode): string {
  return `${asData(e.title)} — ${e.outcome}`;
}

function episodeRows(list: readonly Episode[]): readonly ToolArgs[] {
  return list.map((e) => ({
    id: e.id,
    at: e.at,
    kind: e.kind,
    title: asData(e.title),
    outcome: e.outcome,
    ...(e.tools ? { tools: e.tools } : {}),
    ...(e.missionId === undefined ? {} : { missionId: e.missionId }),
    ...(e.durationMs === undefined ? {} : { durationMs: e.durationMs }),
    ...(e.redacted ? { redacted: true } : {}),
  }));
}

/**
 * What happened before: past missions, newest first, or the ones matching a query.
 *
 * A read of a record, not an interpretation of it. The rows are counts and names
 * assembled from finished missions, so a step planning a second attempt at something
 * can see that the first one failed without a model having summarised why.
 */
function listEpisodes(episodes: EpisodicStore): Tool {
  return {
    name: "list_episodes",
    summary: "List what happened before — finished missions and recorded notes",
    schema: {
      query: { kind: "string", max: 200 },
      limit: { kind: "number", min: 1, max: MAX_EPISODE_ROWS, integer: true },
    },
    async run(args: ToolArgs): Promise<ToolRun> {
      const query = readOptionalString(args, "query");
      const limit = readNumber(args, "limit", MAX_EPISODE_ROWS);
      const matched = query === undefined ? episodes.list() : episodes.search(query);
      const shown = matched.slice(0, limit);
      return {
        outcome: "verified",
        summary:
          query === undefined
            ? `${episodes.count()} episode${episodes.count() === 1 ? "" : "s"} recorded`
            : `${matched.length} episode${matched.length === 1 ? "" : "s"} match that`,
        detail: shown.length === 0 ? "nothing recorded that matches" : shown.map(episodeLine).join(" · "),
        data: {
          ...(query === undefined ? {} : { query }),
          total: matched.length,
          recorded: episodes.count(),
          episodes: episodeRows(shown),
        },
      };
    },
  };
}

/**
 * The eight fields, and — as plainly — which of them are not filled in.
 *
 * The unset list is the useful half. A step that needs a time zone and is told the
 * field is empty asks; a step told only "name: Ada" is free to assume UTC and be
 * wrong, and nothing about that assumption would ever appear on screen.
 */
function readProfile(profile: ProfileStore): Tool {
  return {
    name: "read_profile",
    summary: "Read the few fields Jarvis keeps about the user",
    schema: {},
    async run(): Promise<ToolRun> {
      const known = profile.list();
      const unset = (Object.keys(PROFILE_FIELDS) as (keyof typeof PROFILE_FIELDS)[]).filter(
        (key) => !known.some((f) => f.key === key),
      );
      return {
        outcome: "verified",
        summary: `${known.length} of ${known.length + unset.length} profile fields are filled in`,
        detail:
          known.length === 0
            ? "nothing is set — do not assume a default for any of these"
            : known.map((f) => `${PROFILE_FIELDS[f.key].label}: ${asData(f.value)}`).join(" · "),
        data: {
          fields: known.map((f) => ({
            key: f.key,
            label: PROFILE_FIELDS[f.key].label,
            value: asData(f.value),
            source: f.source,
            at: f.at,
          })),
          unset,
        },
      };
    },
  };
}

/**
 * Offer something for the user to confirm. It is not remembered by doing this.
 *
 * The only write a mission gets anywhere near memory, and what it writes is a
 * *question*: a row in `proposals.json` with a plain statement of where it came from.
 * `LearningQueue.accept` is the only path from there into a store, and it is reached
 * from one place — a request the user's own window sent.
 *
 * The queue screens the text (credential-shaped, transient, duplicate) and its
 * refusal is thrown so it becomes this step's error, exactly as `write_memory` treats
 * the store's. A mission that tried to teach Jarvis a token is told why it could not.
 */
function saveMemorySuggestion(learning: LearningQueue): Tool {
  return {
    name: "save_memory_suggestion",
    summary: "Offer something for the user to confirm before Jarvis remembers it",
    schema: {
      kind: { kind: "string", required: true, oneOf: ["memory", "profile"] },
      text: { kind: "string", required: true, max: 500 },
      key: { kind: "string", max: 40 },
      why: { kind: "string", required: true, max: 200 },
    },
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      const kind = readString(args, "kind") === "profile" ? "profile" : "memory";
      const text = readString(args, "text");
      const key = readOptionalString(args, "key");
      const why = readString(args, "why");
      let queued: LearningProposal | undefined;
      let refusal: string | undefined;

      const report = await runVerified(
        {
          description: "offer that for you to confirm",
          observe: () => learning.count(),
          act: () => {
            const result = learning.propose({
              kind,
              text,
              ...(key === undefined ? {} : { key }),
              why,
            });
            if (!result.ok) {
              refusal = result.reason;
              throw new Error(result.reason);
            }
            queued = result.proposal;
          },
          verify: () =>
            queued !== undefined && learning.list().some((p) => p.id === queued?.id)
              ? { ok: true, detail: "it is waiting for you to confirm" }
              : { ok: false, reason: "it is not in the queue afterwards" },
        },
        { timeoutMs: ctx.timeoutMs, now: ctx.now },
      );

      return {
        outcome: report.outcome,
        summary: refusal ?? `${report.description}: ${report.detail}`,
        ...(queued === undefined
          ? {}
          : { detail: `nothing is saved until you accept: ${asData(queued.text)}` }),
        ...(report.error !== undefined ? { error: report.error } : {}),
        ...(queued === undefined ? {} : { data: { id: queued.id, kind: queued.kind, pending: learning.count() } }),
      };
    },
  };
}

/**
 * The memory tools.
 *
 * `delete_memory` classifies as a delete, so it asks before it runs — and unlike a
 * file, a forgotten memory has no Recycle Bin behind it. That asymmetry is the
 * reason the name is `delete_memory` and not something softer: the dialog the user
 * sees should be the one a deletion gets.
 */
export function memoryTools(deps: MemoryDeps): readonly Tool[] {
  const out: Tool[] = [
    listMemories(deps),
    searchMemory(deps),
    writeMemory(deps),
    deleteMemory(deps),
  ];
  const retriever = deps.retriever;
  if (retriever) out.push(getRelevantContext(retriever));
  const episodes = deps.episodes;
  if (episodes) out.push(listEpisodes(episodes));
  const profile = deps.profile;
  if (profile) out.push(readProfile(profile));
  const learning = deps.learning;
  if (learning) out.push(saveMemorySuggestion(learning));
  return out;
}
