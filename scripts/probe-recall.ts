/**
 * Phase 16 gate: does what Jarvis knows survive, rank honestly, and stay unwritten
 * until a person says so?
 *
 * The unit suites prove each of the five stores against a temp file and a fixed
 * clock, and `tests/retrieval.test.ts` proves the arithmetic. Three claims sit
 * outside what any of that can reach, and they are the ones this phase is really
 * making:
 *
 *  1. **Durability across a real process boundary.** A second store over the same
 *     path in the same process shares a warm array and a module-level id counter, so
 *     "it survives a restart" is a weaker claim in a test than it sounds. This spawns
 *     an actual child `node` to do every write — episode, profile field, queued
 *     suggestion and vector — and reads all four back cold.
 *  2. **The learning door, watched from outside.** "`propose` writes nothing to the
 *     store" is a claim about code. Here it is an observation: `memory.json`'s size
 *     and mtime are recorded before the proposal and compared after, and only
 *     `resolve_learning` — a request the user's own window sent, over a real pipe —
 *     moves them.
 *  3. **The off switch, through the whole stack.** Not `Retriever` in isolation but a
 *     live runtime: switch it off, ask for the view, and the profile must be gone
 *     from what a plan would see while still sitting in the file.
 *
 * The vector index gets its own check for the reason the file has no text in it: a
 * memory the user deleted must not survive in the sidecar, so "no text on disk" is
 * asserted against the real bytes rather than against the writer's intent.
 *
 * **What it does to your machine.** Everything it writes is under the system temp
 * directory: the memory store, the episode log, the profile, the suggestion queue and
 * the vector sidecar. It fingerprints the real `%LOCALAPPDATA%\Jarvis` memory files
 * before and after and fails if a byte moved. It binds a probe-only pipe rather than
 * the Jarvis one, but `start()` still publishes the shared runtime token and `stop()`
 * revokes it, so it refuses to run beside a live Jarvis. Hermes is a `FakeAdapter`
 * and is never asked anything. No network: with nothing configured the embedder is
 * the local lexical one, and the check below reads its own report to say so.
 *
 *   npx tsx scripts/probe-recall.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MemoryStore, memoryFilePath } from "../src/memory/memory-store.js";
import { EpisodicStore } from "../src/memory/episodic-store.js";
import { ProfileStore } from "../src/memory/profile-store.js";
import { LearningQueue } from "../src/memory/learning.js";
import { VectorIndex, memoryDir } from "../src/memory/vector-index.js";
import { Retriever } from "../src/memory/retrieval.js";
import { JarvisRuntime } from "../src/runtime/jarvis-runtime.js";
import { PipeClient } from "../src/ipc/pipe-client.js";
import { readToken } from "../src/ipc/token.js";
import { FakeAdapter } from "../tests/helpers/fake-adapter.js";
import { refuseIfRuntimeLive } from "./runtime-guard.js";
import type { MemoryView, MemoryWriteResult } from "../src/ipc/contract.js";

const here = dirname(fileURLToPath(import.meta.url));

const results: { name: string; verdict: string; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, verdict: ok ? "PASS" : "FAIL", detail });
}

function pipePath(name: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `/tmp/${name}.sock`;
}

/** A scratch directory on real disk. Never `%LOCALAPPDATA%\Jarvis`. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "jarvis-probe-recall-"));
}

/** Size and mtime of one file, or "absent". */
function stamp(path: string): string {
  if (!existsSync(path)) return "absent";
  const s = statSync(path);
  return `${s.size}:${s.mtimeMs}`;
}

/** Every memory file in a directory, so "nothing was written" is checkable. */
function fingerprint(dir: string): string {
  if (!existsSync(dir)) return "absent";
  return readdirSync(dir)
    .sort()
    .map((f) => `${f}:${stamp(join(dir, f))}`)
    .join("|");
}

const FACT = "the portal deploys from the release branch, never from main";

// --- every layer written by a different process ------------------------------

/**
 * Write to all five stores from a *child* process, then read them back here.
 *
 * The point of the child is that a fresh process has no memory of this one: no warm
 * arrays, and — the part a same-process test cannot reach — no inherited id counters.
 * There are three of those now, in three files, and a collision in any of them means
 * `forget` or `accept` acts on the wrong row: silently, and only after a boot.
 */
function writeInChildProcess(dir: string): {
  pid: number;
  memoryId: string;
  episodeId: string;
  proposalId: string;
  indexed: number;
} {
  const url = (file: string): string =>
    JSON.stringify(pathToFileURL(resolve(here, `../src/memory/${file}`)).href);
  const source = [
    `import { MemoryStore } from ${url("memory-store.ts")};`,
    `import { EpisodicStore } from ${url("episodic-store.ts")};`,
    `import { ProfileStore } from ${url("profile-store.ts")};`,
    `import { LearningQueue } from ${url("learning.ts")};`,
    `import { VectorIndex } from ${url("vector-index.ts")};`,
    `const dir = process.argv[1];`,
    `const j = (n) => dir + "/" + n;`,
    `const memory = new MemoryStore({ path: j("memory.json") });`,
    `const episodes = new EpisodicStore({ path: j("episodes.json") });`,
    `const profile = new ProfileStore({ path: j("profile.json") });`,
    `const learning = new LearningQueue({ memory, profile, path: j("proposals.json") });`,
    `const vectors = new VectorIndex({ path: j("vectors.json") });`,
    `const m = memory.remember(process.argv[2]);`,
    `const e = episodes.record({ kind: "mission", title: "prepared the portal release",`,
    `  outcome: "completed", tools: ["run_command"], durationMs: 4200 });`,
    `profile.set("shell", "bash", "stated");`,
    `const p = learning.propose({ kind: "profile", key: "editor", text: "vscode",`,
    `  why: "every file in mission m3 was opened in it" });`,
    `const report = await vectors.sync(`,
    `  memory.entriesList().map((x) => ({ id: x.id, text: x.text, at: x.at })));`,
    `process.stdout.write(JSON.stringify({`,
    `  pid: process.pid,`,
    `  memoryId: m.entry?.id ?? "",`,
    `  episodeId: e.id,`,
    `  proposalId: p.ok ? p.proposal.id : "",`,
    `  indexed: report.total,`,
    `}));`,
  ].join("\n");

  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source, dir, FACT],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out) as ReturnType<typeof writeInChildProcess>;
}

async function probeRestart(): Promise<void> {
  const dir = scratch();
  try {
    const child = writeInChildProcess(dir);
    check(
      "another process wrote all five files",
      ["memory.json", "episodes.json", "profile.json", "proposals.json", "vectors.json"].every(
        (f) => existsSync(join(dir, f)),
      ),
      `child pid ${child.pid}, ${child.indexed} row(s) indexed`,
    );

    // The restart: every store opened cold over the files that process left behind.
    const memory = new MemoryStore({ path: join(dir, "memory.json") });
    const episodes = new EpisodicStore({ path: join(dir, "episodes.json") });
    const profile = new ProfileStore({ path: join(dir, "profile.json") });
    const learning = new LearningQueue({ memory, profile, path: join(dir, "proposals.json") });

    check(
      "the episode survives with its id, its tools and its duration",
      episodes.count() === 1 &&
        episodes.list()[0]?.id === child.episodeId &&
        episodes.list()[0]?.tools?.includes("run_command") === true &&
        episodes.list()[0]?.durationMs === 4200,
      episodes.list()[0]?.title ?? "(nothing)",
    );
    check(
      "the profile field survives, and still says the user stated it",
      profile.get("shell")?.value === "bash" && profile.get("shell")?.source === "stated",
      `${profile.count()} field(s) filled in`,
    );
    // The load-bearing half of the learning design, across a boot: a suggestion is
    // still a suggestion tomorrow, and the field it names is still empty.
    check(
      "the queued suggestion survives, and is still only a suggestion",
      learning.count() === 1 &&
        learning.list()[0]?.id === child.proposalId &&
        profile.get("editor") === undefined,
      learning.list()[0]?.text ?? "(nothing)",
    );

    const secondEpisode = episodes.record({
      kind: "note",
      title: "a second thing happened",
      outcome: "completed",
    });
    const secondProposal = learning.propose({
      kind: "memory",
      text: "the release notes live under docs",
      why: "mission m4 read the tree",
    });
    check(
      "fresh ids in both queues do not collide with the ones on disk",
      secondEpisode.id !== child.episodeId &&
        secondProposal.ok &&
        secondProposal.proposal.id !== child.proposalId,
      `${child.episodeId} then ${secondEpisode.id}; ${child.proposalId} then ${
        secondProposal.ok ? secondProposal.proposal.id : "?"
      }`,
    );

    // The cache is the whole reason vectors are on disk. A cold index that has to
    // re-embed is one that costs a model round trip on every restart.
    const vectorFile = join(dir, "vectors.json");
    const before = stamp(vectorFile);
    const vectors = new VectorIndex({ path: vectorFile });
    const hits = await vectors.search("portal deployment");
    check(
      "the index is usable cold, without re-embedding anything",
      vectors.size() === 1 && hits[0]?.id === child.memoryId,
      `${vectors.size()} row(s); best hit ${hits[0]?.id ?? "none"} at ${
        hits[0] ? Math.round(hits[0].score * 100) / 100 : 0
      }`,
    );
    check("and searching it wrote nothing back", stamp(vectorFile) === before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the sidecar holds no text ----------------------------------------------

/**
 * A memory the user deleted must not survive in the index.
 *
 * The mechanism is that the file holds an id, a hash and a vector — never the words.
 * That is a claim about `write()`, so here it is an observation of the bytes: the
 * text goes in, the file is read back as a string, and the words must not be in it.
 */
async function probeSidecar(): Promise<void> {
  const dir = scratch();
  const path = join(dir, "vectors.json");
  try {
    const secretish = "the staging box is 10.0.0.7 and the portal deploys from release";
    const index = new VectorIndex({ path });
    await index.sync([{ id: "m1", text: secretish, at: 1 }]);
    const bytes = readFileSync(path, "utf8");
    check(
      "the sidecar records an id and a hash, and none of the words",
      bytes.includes("m1") &&
        !bytes.includes("staging") &&
        !bytes.includes("10.0.0.7") &&
        !bytes.includes("portal"),
      `${bytes.length} bytes for one row`,
    );

    // Deleting the memory means syncing without it, which is the only way the store
    // ever tells the index anything. The row has to go, not merely stop being found.
    await index.sync([]);
    check(
      "and a row removed from the store is removed from the file",
      index.size() === 0 && !readFileSync(path, "utf8").includes("m1"),
      `${index.size()} row(s) left`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- ranking, over real files rather than a harness -------------------------

/**
 * What a mission would actually be told, and what the row says about how it got there.
 *
 * `tests/retrieval.test.ts` proves the arithmetic. What it cannot show is the claim
 * this phase makes on screen: with nothing configured, the thing behind similarity is
 * the local lexical embedder, and every row carries the method that found it — so a
 * word-hash near-match cannot be presented as a model's understanding (§43).
 */
async function probeRanking(): Promise<void> {
  const dir = scratch();
  try {
    const now = 1_700_000_000_000;
    const memory = new MemoryStore({ path: join(dir, "memory.json"), now: () => now });
    const episodes = new EpisodicStore({ path: join(dir, "episodes.json"), now: () => now });
    const profile = new ProfileStore({ path: join(dir, "profile.json"), now: () => now });
    const vectors = new VectorIndex({ path: join(dir, "vectors.json") });
    memory.remember(FACT);
    memory.remember("the tax return is due in January");
    episodes.record({ kind: "mission", title: "deployed the portal", outcome: "completed" });
    profile.set("name", "Ada", "stated");

    let enabled = true;
    const retriever = new Retriever({
      memory,
      episodes,
      profile,
      vectors,
      now: () => now,
      enabled: () => enabled,
    });

    const synced = await retriever.sync();
    check(
      "the index covers memories and episodes both, off the real stores",
      synced?.total === 3 && synced?.degraded !== true,
      `${synced?.added ?? 0} added, ${synced?.total ?? 0} total, by ${synced?.embedder ?? "nothing"}`,
    );

    const got = await retriever.retrieve("get the portal ready to ship");
    const methods = got.facts.map((f) => f.method);
    check(
      "the objective retrieved something, and counted what it looked at",
      got.enabled && got.facts.length > 0 && got.considered === 4,
      `${got.facts.length} of ${got.considered}: ${got.facts
        .map((f) => `${f.source}/${f.method}`)
        .join(" ")}`,
    );
    check(
      "the profile is carried first, labelled as carried rather than as matched",
      got.facts[0]?.source === "profile" &&
        got.facts[0]?.method === "profile" &&
        got.facts[0]?.score === 1,
      got.facts[0]?.summary ?? "(nothing)",
    );
    // By text rather than by id: memory ids come off a counter this process has
    // already advanced, and hard-coding `m1` would be a check on probe ordering.
    const fact = got.facts.find((f) => f.source === "memory" && f.summary === FACT);
    check(
      "the remembered fact is there, and the row says which layer found it",
      fact !== undefined && (fact.method === "keyword" || fact.method === "both"),
      `${fact?.id ?? "not retrieved"} by ${fact?.method ?? "nothing"}`,
    );
    check(
      "every method label is one of the five the contract names",
      methods.every((m) => ["keyword", "vector", "both", "profile", "recent"].includes(m)),
      methods.join(", "),
    );
    // The §43 line for this phase. With nothing configured the embedder is the local
    // word hash, and it must say so rather than letting a screen say "semantic".
    check(
      "with no model configured, similarity does not claim to be semantic",
      got.semantic === false && /lexical/.test(got.embedder ?? ""),
      `${got.embedder ?? "no index"} (semantic: ${got.semantic})`,
    );

    // Off is off, and off includes the profile: a user who switched memory off and
    // then heard Jarvis use their name would be right to say the switch does nothing.
    enabled = false;
    const off = await retriever.retrieve("get the portal ready to ship");
    check(
      "switched off, nothing is retrieved and the result says why it is empty",
      off.enabled === false && off.facts.length === 0,
      `${off.facts.length} fact(s), enabled ${off.enabled}`,
    );
    check(
      "and nothing was deleted to achieve that",
      readFileSync(join(dir, "profile.json"), "utf8").includes("Ada") &&
        memory.entriesList().length === 2,
      `${memory.entriesList().length} memories and the profile still on disk`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the learning door, watched from outside ---------------------------------

/**
 * "Proposing writes nothing" as an observation rather than a claim about code.
 *
 * `memory.json`'s size and mtime are recorded, a proposal is made, and the file has
 * to be the same file — byte length and modification time both. Then `accept`, which
 * is the only door, and it must move exactly that file.
 */
function probeLearningDoor(): void {
  const dir = scratch();
  const memoryPath = join(dir, "memory.json");
  const profilePath = join(dir, "profile.json");
  try {
    const memory = new MemoryStore({ path: memoryPath });
    const profile = new ProfileStore({ path: profilePath });
    const learning = new LearningQueue({ memory, profile, path: join(dir, "proposals.json") });
    memory.remember("the portal is the thing with the release branch");

    const beforeMemory = stamp(memoryPath);
    const beforeProfile = stamp(profilePath);
    const offered = learning.propose({
      kind: "memory",
      text: "npm ci is needed after a fresh clone of the portal",
      why: "mission m7 failed on a stale lockfile and then this fixed it",
    });
    check(
      "a mission can offer something, and gets an id back for it",
      offered.ok && learning.count() === 1,
      offered.ok ? offered.proposal.id : offered.reason,
    );
    check(
      "and the memory file did not move — not its size, not its mtime",
      stamp(memoryPath) === beforeMemory && stamp(profilePath) === beforeProfile,
      `${beforeMemory} still ${stamp(memoryPath)}`,
    );
    check(
      "the offered text is nowhere in the store it was offered to",
      !readFileSync(memoryPath, "utf8").includes("npm ci"),
    );

    // The door itself. Nothing but this reaches a store, and it is only ever called
    // from the `resolve_learning` request the user's own window sends.
    const accepted = offered.ok ? learning.accept(offered.proposal.id) : null;
    check(
      "accepting it is what writes it, and the queue empties",
      accepted?.ok === true && learning.count() === 0,
      accepted?.ok ? accepted.speech : (accepted?.reason ?? "nothing to accept"),
    );
    check(
      "the memory file moved this time, and now holds the text",
      stamp(memoryPath) !== beforeMemory && readFileSync(memoryPath, "utf8").includes("npm ci"),
      stamp(memoryPath),
    );

    // A profile acceptance has to be distinguishable from something the user typed.
    // `confirmed` is that distinction, and it is the only other value there is.
    const field = learning.propose({
      kind: "profile",
      key: "shell",
      text: "pwsh",
      why: "every command in mission m7 was written for it",
    });
    const tookIt = field.ok ? learning.accept(field.proposal.id) : null;
    check(
      "an accepted profile field is recorded as confirmed, not as stated",
      tookIt?.ok === true &&
        profile.get("shell")?.value === "pwsh" &&
        profile.get("shell")?.source === "confirmed",
      `${profile.get("shell")?.value ?? "unset"} / ${profile.get("shell")?.source ?? "-"}`,
    );

    // Two refusals that happen before the queue, so an unacceptable suggestion is
    // never a row the user has to read and decline.
    const secret = learning.propose({
      kind: "memory",
      text: "the deploy key is sk-proj-abc123def456ghi789jkl012mno345",
      why: "mission m8 read it out of the environment",
    });
    check(
      "a credential-shaped suggestion is refused before it is even offered",
      !secret.ok && /password, key or token/.test(secret.ok ? "" : secret.reason),
      secret.ok ? "it was queued" : secret.reason,
    );
    const transient = learning.propose({
      kind: "memory",
      text: "the portal build is running right now",
      why: "mission m9 watched it start",
    });
    check(
      "and so is something that is only true at the moment it was written",
      !transient.ok,
      transient.ok ? "it was queued" : transient.reason,
    );
    check(
      "neither of them left anything anywhere",
      !readFileSync(memoryPath, "utf8").includes("sk-proj") &&
        !readFileSync(join(dir, "proposals.json"), "utf8").includes("sk-proj") &&
        learning.count() === 0,
      `${learning.count()} suggestion(s) queued`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the whole stack, over a real pipe --------------------------------------

/** Seed a suggestion the runtime will find at boot, so `resolve_learning` has one. */
function seedProposal(dir: string, memoryPath: string): string {
  const memory = new MemoryStore({ path: memoryPath });
  const profile = new ProfileStore({ path: join(dir, "profile.json") });
  const learning = new LearningQueue({ memory, profile, path: join(dir, "proposals.json") });
  const offered = learning.propose({
    kind: "profile",
    key: "editor",
    text: "neovim",
    why: "mission m2 opened every file in it",
  });
  return offered.ok ? offered.proposal.id : "";
}

/**
 * The requests the Memory page actually sends, answered by a real runtime.
 *
 * A live process on a probe-only pipe, `FakeAdapter` behind Hermes, and every memory
 * file under `%TEMP%` via the `memoryPath` and `memoryDir` seams. `start()` publishes
 * the shared runtime token, which is why this refuses to run beside a live Jarvis.
 */
async function probeRuntime(): Promise<void> {
  await refuseIfRuntimeLive();

  const dir = scratch();
  const memoryPath = join(dir, "memory.json");
  const proposalId = seedProposal(dir, memoryPath);

  const realDir = memoryDir();
  const realStore = memoryFilePath();
  const realBefore = fingerprint(realDir);
  const realStoreBefore = stamp(realStore);

  const pipeName = pipePath(`jarvis-probe-recall-${process.pid}`);
  FakeAdapter.reset();
  const runtime = new JarvisRuntime({
    pipeName,
    lazyHermes: true,
    createAdapter: () => new FakeAdapter(),
    voice: { enabled: false },
    memoryPath,
    memoryDir: dir,
  });

  try {
    await runtime.start();
    const ui = new PipeClient({
      pipeName,
      token: readToken() ?? undefined,
      clientName: "probe-recall",
      autoReconnect: false,
    });
    await ui.connectAndAuthenticate();

    /** A memory write, or the reason it was refused. Refusals are not wire errors. */
    const write = async (req: Record<string, unknown>): Promise<MemoryWriteResult> =>
      (await ui.request(req as never)) as MemoryWriteResult;

    const view = (await ui.request({ type: "get_memory" } as never)) as MemoryView;
    check(
      "the window is told what is behind similarity, and that it is not semantic",
      view.embedder !== null && view.embedder.semantic === false,
      `${view.embedder?.name ?? "none"}, ${view.embedder?.dims ?? 0} dims`,
    );
    check(
      "all eight profile fields travel, including the empty ones",
      view.profile.length === 8 && view.profile.filter((f) => f.value !== undefined).length === 0,
      `${view.profile.map((f) => f.key).join(", ")}`,
    );
    check(
      "the seeded suggestion is waiting, and says where it came from",
      view.proposals.length === 1 &&
        view.proposals[0]?.id === proposalId &&
        (view.proposals[0]?.why.length ?? 0) > 0,
      view.proposals[0]?.why ?? "(none)",
    );

    // §53 through the whole stack: the page can send anything, and the store decides.
    const refused = await write({
      type: "remember",
      text: "the deploy token is ghp_1234567890abcdefghijklmnopqrstuvwxyz",
    });
    check(
      "a credential typed into the page is refused, and told so as a refusal",
      refused.saved === false && /password, key or token/.test(refused.speech),
      refused.speech,
    );
    check(
      "and no part of it reached the store",
      refused.memory.entries.length === 0 &&
        (!existsSync(memoryPath) || !readFileSync(memoryPath, "utf8").includes("ghp_")),
      `${refused.memory.entries.length} entries`,
    );

    const saved = await write({ type: "remember", text: FACT });
    check(
      "an ordinary memory typed into the page is saved, and lands on real disk",
      saved.saved && saved.memory.entries.length === 1 && readFileSync(memoryPath, "utf8").includes("release branch"),
      saved.speech,
    );

    const stated = await write({ type: "set_profile", key: "name", value: "Ada" });
    check(
      "a profile field the user typed is recorded as stated",
      stated.saved && stated.memory.profile.find((f) => f.key === "name")?.source === "stated",
      stated.memory.profile.find((f) => f.key === "name")?.value ?? "unset",
    );
    let ninth = "it was accepted";
    try {
      await write({ type: "set_profile", key: "homeAddress", value: "12 Baker Street" });
    } catch (err) {
      ninth = err instanceof Error ? err.message : String(err);
    }
    check(
      "a ninth field cannot be invented over the wire",
      /not a profile field/.test(ninth) &&
        !readFileSync(join(dir, "profile.json"), "utf8").includes("Baker"),
      ninth,
    );

    // The door, over the pipe the user's own window uses. Until this request, the
    // suggestion had been on disk for the whole run and had written nothing.
    const accepted = await write({ type: "resolve_learning", proposalId, decision: "accept" });
    check(
      "accepting a suggestion is what writes it, and marks it confirmed",
      accepted.saved &&
        accepted.memory.proposals.length === 0 &&
        accepted.memory.profile.find((f) => f.key === "editor")?.source === "confirmed",
      accepted.speech,
    );

    /** What a plan would be told, through this runtime's own registry. */
    const askAPlan = async (): Promise<{ enabled: boolean; total: number; summary: string }> => {
      const prepared = runtime.tools.prepare("get_relevant_context", {
        objective: "get the portal ready to ship",
      });
      if (!prepared.ok) return { enabled: true, total: -1, summary: prepared.reason };
      const run = await runtime.tools.invoke(prepared, {
        roots: [dir],
        now: () => Date.now(),
        log: () => {},
      });
      const data = (run.data ?? {}) as { enabled?: boolean; total?: number };
      return {
        enabled: data.enabled !== false,
        total: typeof data.total === "number" ? data.total : -1,
        summary: run.summary,
      };
    };

    const onView = await askAPlan();
    check(
      "with memory on, a plan is told what the user said and who they are",
      onView.enabled && onView.total > 0,
      onView.summary,
    );

    const beforeOff = fingerprint(dir);
    const off = await write({ type: "set_memory_enabled", enabled: false });
    check(
      "the switch reports itself as off, and as a session override rather than the file",
      off.saved && off.memory.enabled === false && off.memory.enabledIsSession === true,
      off.speech,
    );
    const offView = await askAPlan();
    check(
      "and a plan is then told nothing — not the memories, and not the profile either",
      offView.enabled === false && offView.total === 0,
      offView.summary,
    );
    check(
      "while every file is exactly where it was: a switch, not a delete",
      fingerprint(dir) === beforeOff &&
        off.memory.entries.length === 1 &&
        off.memory.profile.filter((f) => f.value !== undefined).length === 2,
      `${off.memory.entries.length} memory and ${
        off.memory.profile.filter((f) => f.value !== undefined).length
      } profile fields still there`,
    );
    await write({ type: "set_memory_enabled", enabled: true });

    // The one irreversible bulk delete in the subsystem, and the phrase is the guard.
    let mistyped = "it went through";
    try {
      await write({ type: "forget_everything", confirm: "yes" });
    } catch (err) {
      mistyped = err instanceof Error ? err.message : String(err);
    }
    check(
      "forgetting everything refuses anything but the exact phrase",
      /forget everything/.test(mistyped) && existsSync(memoryPath),
      mistyped,
    );

    const gone = await write({ type: "forget_everything", confirm: "forget everything" });
    check(
      "the phrase clears every layer, and reports what it really deleted",
      gone.saved &&
        gone.counts?.memories === 1 &&
        gone.counts?.profile === 2 &&
        gone.memory.entries.length === 0 &&
        gone.memory.profile.every((f) => f.value === undefined),
      JSON.stringify(gone.counts ?? {}),
    );
    check(
      "including the vectors, so nothing deleted is still searchable",
      !readFileSync(join(dir, "vectors.json"), "utf8").includes("\"id\""),
      `${readFileSync(join(dir, "vectors.json"), "utf8").length} bytes left`,
    );

    await ui.close();
  } finally {
    await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }

  // The load-bearing check for this whole file: a real runtime ran, wrote memories,
  // accepted a suggestion and deleted the lot, and the user's actual memory files
  // never moved. The seams are what did that, and this is the observation of it.
  check(
    "the real Jarvis memory directory is byte-for-byte as it was",
    fingerprint(realDir) === realBefore,
    fingerprint(realDir) === realBefore
      ? `${realDir} unchanged`
      : `${realBefore} -> ${fingerprint(realDir)}`,
  );
  check(
    "and the real memory.json was not touched either",
    stamp(realStore) === realStoreBefore,
    `${realStore} ${realStoreBefore === "absent" ? "still absent" : "unchanged"}`,
  );
}

async function main(): Promise<void> {
  console.log("\nWhat Jarvis knows: does it survive, rank honestly, and stay unwritten?\n");
  await probeRestart();
  await probeSidecar();
  await probeRanking();
  probeLearningDoor();
  await probeRuntime();
  report();
}

function report(): void {
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`${r.verdict.padEnd(5)} ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = results.filter((r) => r.verdict === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  console.log(`(real memory files ${memoryDir()}; scratch under ${tmpdir()})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

