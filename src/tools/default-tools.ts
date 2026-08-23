/**
 * The tools a mission may choose from, assembled in one place.
 *
 * Each adapter exports a list and knows nothing about the others; this is the
 * only file that decides which of those lists a *runtime* offers. It exists apart
 * from `jarvis-runtime.ts` for the reason `activity-model.ts` exists apart from
 * the HUD: the set of capabilities an autonomous loop has is worth being able to
 * assert on without starting a runtime, a pipe and a supervisor to find it out.
 *
 * Two properties this file is responsible for.
 *
 * **A capability absent is a capability not registered.** No adapter is included
 * with a stubbed dependency to keep the list looking full. `delete_file` appears
 * only when a `ReversibleFs` was handed in, because a delete Jarvis cannot take
 * back is not the tool the plan says it is (§43). A planner asks
 * `registry.list()` what exists and plans against the answer, so an absent tool
 * costs a worse plan rather than a step that fails at the last moment.
 *
 * **No new capability is invented here.** Everything below is an existing
 * executor, an existing path-safety check or an existing process runner, wrapped
 * in the one descriptor shape. If something in this list can reach the disk or the
 * shell, it could before, through the same guard.
 *
 * **A mock is registered only when it does something really checkable.** `send_email` and
 * the calendar tools have no account behind them, and they are here anyway — because
 * what they promise is a record in a local outbox, they really write one, and the
 * `simulated` flag travels with every result. `browse_click` is *not* here for the
 * mirror-image reason: a mocked click leaves a mission believing a form was
 * submitted, and no label follows that belief into the report's conclusion.
 */
import type { ReversibleFs } from "../permissions/reversible-fs.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { EpisodicStore } from "../memory/episodic-store.js";
import type { LearningQueue } from "../memory/learning.js";
import type { ProfileStore } from "../memory/profile-store.js";
import type { Retriever } from "../memory/retrieval.js";
import type { ProjectEntry } from "../context/project-registry.js";
import type { ProcessRunner } from "./process-run.js";
import type { SearchProvider } from "./net/search-provider.js";
import { ToolRegistry, type Tool } from "./registry.js";
import { browserTools } from "./adapters/browser.js";
import { commsTools, type MockCommsStore } from "./adapters/comms.js";
import { filesystemTools } from "./adapters/filesystem.js";
import { gitTools } from "./adapters/git.js";
import { localIntentTools, type LocalIntentDeps } from "./adapters/local-intent.js";
import { memoryTools } from "./adapters/memory.js";
import { projectTools } from "./adapters/project.js";
import { terminalTools } from "./adapters/terminal.js";
import { webTools } from "./adapters/web.js";

export interface DefaultToolDeps {
  /**
   * The local-intent bridge — the 25 intents Jarvis already routes.
   *
   * Optional, and its absence is the honest reading of a runtime that has no
   * executors wired: without it there is no `run_local_intent`, rather than one
   * that reports success for having done nothing.
   */
  readonly localIntents?: LocalIntentDeps;
  /** Read at call time, so a project cloned after boot is a valid target. */
  readonly projects?: () => readonly ProjectEntry[];
  /** The roots the user nominated, so "none found" and "none configured" differ. */
  readonly projectRoots?: () => readonly string[];
  readonly memory?: MemoryStore;
  /**
   * The Phase 16 memory layers, each optional and each gating its own tool.
   *
   * A `Retriever` with no vector index still ranks by keyword and says so, so its
   * absence here means something stronger: no retrieval layer was constructed at
   * all, and `get_relevant_context` must not exist to answer "nothing relevant" for
   * a store nobody read.
   */
  readonly retriever?: Retriever;
  readonly episodes?: EpisodicStore;
  readonly profile?: ProfileStore;
  /** Absent means no `save_memory_suggestion` — nothing to propose *to*. */
  readonly learning?: LearningQueue;
  /** Absent means no `delete_file` and no overwrite snapshot. */
  readonly reversible?: ReversibleFs;
  /** Shared by the terminal and git adapters. Injected whole by probes and tests. */
  readonly run?: ProcessRunner;
  readonly execPath?: string;
  readonly platform?: string;
  readonly gitPath?: string;
  /**
   * `host` or `host:port` entries from `webAllowHosts`, read at call time.
   *
   * A function rather than a list because the guard should see the current
   * configuration, and because a *list* handed in at construction would be a
   * snapshot a later config edit could not reach.
   */
  readonly webAllowHosts?: () => readonly string[];
  /** Where the search provider's key comes from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected whole by tests and probes, so no unit test needs the internet. */
  readonly search?: SearchProvider;
  readonly fetchImpl?: typeof fetch;
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  /**
   * Where the mock outbox and calendar are kept.
   *
   * Tests and probes hand in a store under `%TEMP%`; a real runtime writes beside
   * the mission log, where a person can open the file and see what was composed.
   */
  readonly commsStore?: MockCommsStore;
}

/**
 * Build the registry.
 *
 * Duplicate names throw, from `ToolRegistry.register` — deliberately, and at
 * construction rather than at call time: two tools answering to one name is a
 * mission calling something other than what the plan named, and the process
 * failing to start is a far better way to find that out than a step doing the
 * wrong thing in front of a user.
 */
export function buildToolRegistry(deps: DefaultToolDeps = {}): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of defaultTools(deps)) registry.register(tool);
  return registry;
}

/** The list, in the order the tool pane reads best. Sorted again by `list()`. */
export function defaultTools(deps: DefaultToolDeps = {}): readonly Tool[] {
  const out: Tool[] = [];

  if (deps.projects) {
    out.push(
      ...projectTools({
        projects: deps.projects,
        ...(deps.projectRoots ? { projectRoots: deps.projectRoots } : {}),
      }),
    );
  }

  out.push(
    ...terminalTools({
      ...(deps.run ? { run: deps.run } : {}),
      ...(deps.execPath === undefined ? {} : { execPath: deps.execPath }),
      ...(deps.platform === undefined ? {} : { platform: deps.platform }),
    }),
  );

  out.push(
    ...gitTools({
      ...(deps.run ? { run: deps.run } : {}),
      ...(deps.gitPath === undefined ? {} : { gitPath: deps.gitPath }),
    }),
  );

  out.push(...filesystemTools(deps.reversible ? { reversible: deps.reversible } : {}));

  // The network tools need no dependency to be real — `fetch` is a global and the
  // guard is in this repository — so they are always registered, and the one that
  // *can* be absent says so about itself: with no search key configured,
  // `web_search` reports `simulated` and answers on `example.invalid` (§43).
  const net = {
    ...(deps.webAllowHosts ? { allowHosts: deps.webAllowHosts } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  };
  out.push(...webTools({ ...net, ...(deps.search ? { search: deps.search } : {}), ...(deps.env ? { env: deps.env } : {}) }));
  out.push(...browserTools(net));

  // Email and calendar are mocked, loudly, and still write a file that can be
  // opened. `commsTools` needs no dependency either; what it does not have is an
  // account, which is a fact its summaries and its `simulated` flag carry.
  out.push(...commsTools(deps.commsStore ? { store: deps.commsStore } : {}));

  if (deps.memory) {
    out.push(
      ...memoryTools({
        store: deps.memory,
        ...(deps.retriever ? { retriever: deps.retriever } : {}),
        ...(deps.episodes ? { episodes: deps.episodes } : {}),
        ...(deps.profile ? { profile: deps.profile } : {}),
        ...(deps.learning ? { learning: deps.learning } : {}),
      }),
    );
  }
  if (deps.localIntents) out.push(...localIntentTools(deps.localIntents));

  return out;
}
