/**
 * The queue between "Jarvis noticed something" and "Jarvis did something".
 *
 * It stores suggestions and it starts nothing. That sentence is the whole point of
 * the file: `take()` hands a suggestion back to its caller and removes it, and the
 * only caller is the runtime handling a request the user's own window sent. There is
 * no method here that runs a mission, and there is no timer.
 *
 * Bounded, expiring, and it remembers refusals. The last of those is the part that
 * makes proactivity tolerable rather than irritating: a declined suggestion is
 * recorded by fingerprint, and the rule that produced it stays quiet for a month.
 * Without that, "the last build failed" would be re-offered every time the world was
 * assembled, which is how a helpful assistant becomes one the user learns to ignore.
 *
 * Both refusals happen before anything is stored, because a queued suggestion is
 * already a durable record:
 *
 *  - **Credential-shaped text** is refused outright. A suggestion's evidence quotes
 *    program output (a mission's conclusion, a job's error), and program output is
 *    where a token turns up. Refused rather than redacted, as `screenMemory` does it:
 *    a suggestion whose reason has a hole in it is a suggestion nobody can check.
 *  - **Anything the user already declined**, or anything already queued.
 *
 * Storage is the same discipline as every other store here: one JSON file, written
 * temp-and-rename, re-screened on read because the file is editable by hand, and an
 * unreadable file becomes an empty queue plus a log line — never a crash, and the bad
 * file is left where it is because it is the only copy of whatever it holds.
 */
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { defuseMarkers, sanitiseForDisplay } from "../permissions/risk-model.js";
import { redactSecrets } from "../context/window-facts.js";
import type { RuleName, Suggestion } from "./proactive.js";

/** Where the world's own state lives. Beside memory, not inside it: different lifetime. */
export function worldDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(base, "Jarvis", "world");
}

export function proactiveFilePath(): string {
  return join(worldDir(), "proposals.json");
}

export interface ProactiveProposal {
  readonly id: string;
  readonly at: number;
  readonly rule: RuleName;
  readonly objective: string;
  readonly because: readonly string[];
  readonly entityId: string;
  readonly fingerprint: string;
}

interface Declined {
  readonly fingerprint: string;
  readonly at: number;
}

/**
 * Caps and expiry.
 *
 * Six pending, because a suggestion is a heavier thing to read than a remembered
 * fact and four is what one assembly can produce. Two days of life, because every
 * rule here is about a *current* situation — "the last build failed" stops being news
 * once the user has been working for two days — and a stale suggestion the user
 * accepts is the worst outcome available. A month of silence after a decline: long
 * enough to be an answer, short enough that it is not permanent.
 */
export const MAX_PROACTIVE = 6;
export const PROACTIVE_TTL_MS = 2 * 24 * 60 * 60 * 1000;
export const DECLINE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_OBJECTIVE = 160;
const MAX_BECAUSE = 200;
const MAX_BECAUSE_LINES = 5;

export type ProposeResult =
  | { readonly ok: true; readonly proposal: ProactiveProposal }
  | { readonly ok: false; readonly reason: string };

export type TakeResult =
  | { readonly ok: true; readonly proposal: ProactiveProposal }
  | { readonly ok: false; readonly reason: string };

export interface ProactiveQueueOptions {
  path?: string;
  now?(): number;
  onError?(msg: string): void;
}

const RULES: readonly RuleName[] = ["left-failing", "job-failing", "focused-untouched"];

function isRule(value: unknown): value is RuleName {
  return typeof value === "string" && (RULES as readonly string[]).includes(value);
}

function clean(text: string, max: number): string {
  return defuseMarkers(sanitiseForDisplay(text, max));
}

/**
 * Whether a suggestion looks like it is carrying a credential.
 *
 * Applied to the raw text *and* to the cleaned text, because each order on its own
 * misses something. Raw first is the load-bearing half: `clean` collapses a run of
 * hyphens, and `-----BEGIN OPENSSH PRIVATE KEY-----` is exactly what the private-key
 * pattern recognises — defusing the fence first and then looking for a secret is
 * looking for a signature the defusing has erased. `episodic-store.ts` states the same
 * order for the same reason. Cleaned second, because flattening can join two harmless
 * fragments across a newline into one that does match.
 */
function secretShaped(objective: string, because: readonly string[]): boolean {
  return redactSecrets(`${objective} ${because.join(" ")}`).redacted;
}

const SECRET_REFUSAL =
  "the evidence for that looks like it contains a password, key or token, " +
  "so it is not being suggested or stored";

/**
 * The queue. Nothing in here runs anything.
 */
export class ProactiveQueue {
  private readonly path: string;
  private readonly now: () => number;
  private readonly onError: (msg: string) => void;
  private proposals: ProactiveProposal[];
  private refused: Declined[];

  constructor(opts: ProactiveQueueOptions = {}) {
    this.path = opts.path ?? proactiveFilePath();
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError ?? (() => {});
    const read = this.read();
    this.proposals = read.proposals;
    this.refused = read.declined;
    reserveProactiveIds(this.proposals);
  }

  /** Pending, newest first, expired ones dropped on the way out. */
  list(): readonly ProactiveProposal[] {
    if (this.expire()) this.write();
    return this.proposals.slice().reverse();
  }

  count(): number {
    return this.list().length;
  }

  /** Fingerprints the user has declined and the rules must stay quiet about. */
  declined(): readonly string[] {
    if (this.expire()) this.write();
    return this.refused.map((d) => d.fingerprint);
  }

  /**
   * Offer a suggestion, or say why it cannot be offered.
   *
   * The reason travels back to the caller rather than being logged and dropped: the
   * caller is the runtime, and "that was declined a week ago" is the answer to why the
   * world model is not saying anything, which is otherwise indistinguishable from a
   * broken world model.
   */
  propose(suggestion: Suggestion, at?: number): ProposeResult {
    // Before a character is removed. See `secretShaped`.
    if (secretShaped(suggestion.objective, suggestion.because)) {
      return { ok: false, reason: SECRET_REFUSAL };
    }

    const objective = clean(suggestion.objective, MAX_OBJECTIVE);
    if (!objective) return { ok: false, reason: "a suggestion has to say what it would do" };

    const because = suggestion.because
      .map((line) => clean(line, MAX_BECAUSE))
      .filter((line) => line !== "")
      .slice(0, MAX_BECAUSE_LINES);
    if (because.length === 0) {
      return { ok: false, reason: "a suggestion has to say what led to it" };
    }

    // And again over what is actually about to be stored, evidence included. The
    // objective is built from the registry and is nearly always clean; the evidence is
    // where a mission's conclusion or a job's error arrives, and that is program output.
    if (secretShaped(objective, because)) return { ok: false, reason: SECRET_REFUSAL };

    const fingerprint = clean(suggestion.fingerprint, 120);
    if (!fingerprint) return { ok: false, reason: "a suggestion has to be identifiable" };

    this.expire();
    if (this.refused.some((d) => d.fingerprint === fingerprint)) {
      return { ok: false, reason: "you declined that one, so it is staying quiet" };
    }
    if (this.proposals.some((p) => p.fingerprint === fingerprint)) {
      return { ok: false, reason: "that is already waiting for an answer" };
    }

    const proposal: ProactiveProposal = {
      id: nextProactiveId(),
      at: at ?? this.now(),
      rule: suggestion.rule,
      objective,
      because,
      entityId: clean(suggestion.entityId, 120),
      fingerprint,
    };
    this.proposals.push(proposal);
    // Oldest out first, as the learning queue does it: a full queue must not be able
    // to block the newest suggestion, which is the one the user has context for.
    while (this.proposals.length > MAX_PROACTIVE) this.proposals.shift();
    this.write();
    return { ok: true, proposal };
  }

  /**
   * Hand a suggestion back and remove it, because the user asked for it.
   *
   * Named `take` rather than `accept` deliberately. `accept` would suggest this
   * commits something, and it commits nothing: it returns an objective and forgets it
   * was ever suggested. Whether a mission then runs is decided one layer up, by the
   * same code path a typed objective goes through — which is what keeps "Jarvis
   * suggested it" and "the user ran it" two separate events in the record.
   */
  take(id: string): TakeResult {
    this.expire();
    const at = this.proposals.findIndex((p) => p.id === id);
    if (at === -1) return { ok: false, reason: "there is no suggestion with that id" };
    const proposal = this.proposals[at]!;
    this.proposals.splice(at, 1);
    this.write();
    return { ok: true, proposal };
  }

  /** Decline one. It goes, and its fingerprint stays quiet for `DECLINE_TTL_MS`. */
  decline(id: string): TakeResult {
    this.expire();
    const at = this.proposals.findIndex((p) => p.id === id);
    if (at === -1) return { ok: false, reason: "there is no suggestion with that id" };
    const proposal = this.proposals[at]!;
    this.proposals.splice(at, 1);
    this.refused = this.refused.filter((d) => d.fingerprint !== proposal.fingerprint);
    this.refused.push({ fingerprint: proposal.fingerprint, at: this.now() });
    while (this.refused.length > MAX_DECLINED) this.refused.shift();
    this.write();
    return { ok: true, proposal };
  }

  /** Everything, including the declines. Used by "forget everything" and by tests. */
  clear(): number {
    const gone = this.proposals.length + this.refused.length;
    if (gone === 0) return 0;
    this.proposals = [];
    this.refused = [];
    this.write();
    return gone;
  }

  /** Drops expired proposals and expired declines. True when something went. */
  private expire(): boolean {
    const now = this.now();
    const before = this.proposals.length + this.refused.length;
    this.proposals = this.proposals.filter((p) => now - p.at < PROACTIVE_TTL_MS);
    this.refused = this.refused.filter((d) => now - d.at < DECLINE_TTL_MS);
    return this.proposals.length + this.refused.length !== before;
  }

  private read(): { proposals: ProactiveProposal[]; declined: Declined[] } {
    if (!existsSync(this.path)) return { proposals: [], declined: [] };
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("expected a JSON object");
      }
      const o = parsed as Record<string, unknown>;
      const proposals = Array.isArray(o.proposals)
        ? o.proposals.flatMap((raw) => parseProposal(raw))
        : [];
      const declined = Array.isArray(o.declined)
        ? o.declined.flatMap((raw): Declined[] => {
            if (typeof raw !== "object" || raw === null) return [];
            const d = raw as Record<string, unknown>;
            const fingerprint = typeof d.fingerprint === "string" ? clean(d.fingerprint, 120) : "";
            if (!fingerprint) return [];
            return [{ fingerprint, at: typeof d.at === "number" ? d.at : 0 }];
          })
        : [];
      return { proposals, declined: declined.slice(-MAX_DECLINED) };
    } catch (err) {
      this.onError(`ignoring unreadable suggestion queue at ${this.path}: ${err}`);
      return { proposals: [], declined: [] };
    }
  }

  private write(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    const body = { proposals: this.proposals, declined: this.refused };
    writeFileSync(tmp, JSON.stringify(body, null, 2), "utf8");
    renameSync(tmp, this.path);
  }
}

/**
 * How many declines are kept.
 *
 * Bounded like everything else, and bounded generously: a decline is forty bytes and
 * forgetting one means a suggestion the user already refused comes back.
 */
export const MAX_DECLINED = 200;

/**
 * A row off disk, re-screened.
 *
 * Same reasoning as the episode store: this file was written by this class, and it is
 * also a plain JSON file in a directory a person can open. Re-screening on read is
 * what stops a hand-edited objective — or one a synced backup restored — reaching the
 * planner without ever passing the checks `propose` applies.
 */
function parseProposal(raw: unknown): ProactiveProposal[] {
  if (typeof raw !== "object" || raw === null) return [];
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.objective !== "string") return [];
  if (!isRule(o.rule)) return [];
  const rawBecause = Array.isArray(o.because)
    ? o.because.filter((line): line is string => typeof line === "string")
    : [];
  // Raw first, for the reason `secretShaped` gives: a hand-edited row can hold a key
  // header whose signature `clean` would collapse before anything looked for it.
  if (secretShaped(o.objective, rawBecause)) return [];
  const objective = clean(o.objective, MAX_OBJECTIVE);
  const because = rawBecause
    .map((line) => clean(line, MAX_BECAUSE))
    .filter((line) => line !== "")
    .slice(0, MAX_BECAUSE_LINES);
  const fingerprint = typeof o.fingerprint === "string" ? clean(o.fingerprint, 120) : "";
  if (!objective || because.length === 0 || !fingerprint) return [];
  if (secretShaped(objective, because)) return [];
  return [
    {
      id: o.id,
      at: typeof o.at === "number" ? o.at : 0,
      rule: o.rule,
      objective,
      because,
      entityId: typeof o.entityId === "string" ? clean(o.entityId, 120) : "",
      fingerprint,
    },
  ];
}

let proactiveCounter = 0;

/** `w<base36>` — `w` for world, as episodes use `e` and missions `m`. */
function nextProactiveId(): string {
  proactiveCounter += 1;
  return `w${proactiveCounter.toString(36)}`;
}

function reserveProactiveIds(proposals: readonly ProactiveProposal[]): void {
  for (const p of proposals) {
    const m = /^w([0-9a-z]+)$/.exec(p.id);
    if (!m) continue;
    const n = parseInt(m[1]!, 36);
    if (Number.isFinite(n) && n > proactiveCounter) proactiveCounter = n;
  }
}
