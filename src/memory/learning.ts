/**
 * Learning, with the confirmation step that makes it honest.
 *
 * An assistant that notices things and writes them down by itself is one bad
 * inference away from a durable false belief about its user — and the user has no
 * way to find out, because nothing announced it. So nothing in Jarvis learns
 * silently. What a mission can do is *propose*: put a candidate fact in a queue,
 * with a plain statement of where it came from, and wait. A proposal becomes a
 * memory or a profile field when the person accepts it, and never otherwise.
 *
 * That is the whole design, and the queue is what implements it. `accept()` is the
 * only path from here into `MemoryStore` or `ProfileStore`, and it is reached from
 * exactly one place: a request the user's own window sent.
 *
 * Two refusals happen *before* anything reaches the queue, because a proposal is
 * already a durable record and a queue full of things that could never be accepted
 * is a queue nobody reads:
 *
 *  - **Credential-shaped text** is refused by the same screens the stores use.
 *  - **Text that is only true right now** is refused outright — "the build is
 *    running", "meeting at 3 today". This is the mechanical form of "do not blindly
 *    store temporary information": a memory that was true on Tuesday and is read on
 *    Friday is not a memory, it is a false statement with a timestamp.
 */
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { defuseMarkers, sanitiseForDisplay } from "../permissions/risk-model.js";
import { memoryDir } from "./vector-index.js";
import { screenMemory, type MemoryStore } from "./memory-store.js";
import {
  isProfileKey,
  screenProfileValue,
  type ProfileKey,
  type ProfileStore,
} from "./profile-store.js";

export type ProposalKind = "memory" | "profile";

export interface LearningProposal {
  readonly id: string;
  readonly at: number;
  readonly kind: ProposalKind;
  /** The candidate memory sentence, or the candidate value of a profile field. */
  readonly text: string;
  /** Set only for `profile` proposals, and always a known field. */
  readonly key?: ProfileKey;
  /** Where this came from, in words a person can check. Never a model's reasoning. */
  readonly why: string;
  readonly missionId?: string;
}
export function proposalFilePath(): string {
  return join(memoryDir(), "proposals.json");
}

/**
 * Caps and expiry.
 *
 * Twelve is a number a person will actually read to the bottom of; a hundred
 * pending suggestions is a notification the user has learned to dismiss, which is
 * the failure mode this whole mechanism exists to avoid. Fourteen days because a
 * suggestion nobody accepted in a fortnight is one they declined by not answering,
 * and expiring it is more honest than keeping it queued forever.
 */
export const MAX_PROPOSALS = 12;
export const PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Phrases that make a sentence true only at the moment it was written.
 *
 * Word-boundary matched rather than substring, so "currently" is caught and
 * "concurrently" is not. The list is short and deliberately blunt: a false negative
 * here means a proposal a person can still decline, while a false positive only
 * means one useful fact has to be typed in by hand.
 */
const TRANSIENT = new RegExp(
  "\\b(" +
    [
      "today", "tonight", "tomorrow", "yesterday", "this morning", "this afternoon",
      "this evening", "this week", "next week", "last night", "right now", "for now",
      "at the moment", "currently", "just now", "temporar\\w+", "in a minute",
      "in an hour", "any minute",
    ].join("|") +
    ")\\b",
  "i",
);

export type ProposeResult =
  | { readonly ok: true; readonly proposal: LearningProposal }
  | { readonly ok: false; readonly reason: string };

export interface ProposalInput {
  readonly kind: ProposalKind;
  readonly text: string;
  readonly key?: string;
  readonly why: string;
  readonly missionId?: string;
  readonly at?: number;
}

export interface LearningDeps {
  readonly memory: MemoryStore;
  readonly profile: ProfileStore;
  path?: string;
  now?(): number;
  onError?(msg: string): void;
}
export type AcceptResult =
  | { readonly ok: true; readonly proposal: LearningProposal; readonly speech: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The queue. Bounded, expiring, and the only door from a suggestion to a store.
 *
 * It owns both target stores because acceptance has to be one operation: writing
 * the fact and dropping the proposal cannot be two requests, or a crash between
 * them would leave a suggestion the user has already answered.
 */
export class LearningQueue {
  private readonly path: string;
  private readonly now: () => number;
  private readonly onError: (msg: string) => void;
  private readonly memory: MemoryStore;
  private readonly profile: ProfileStore;
  private proposals: LearningProposal[];

  constructor(deps: LearningDeps) {
    this.path = deps.path ?? proposalFilePath();
    this.now = deps.now ?? (() => Date.now());
    this.onError = deps.onError ?? (() => {});
    this.memory = deps.memory;
    this.profile = deps.profile;
    this.proposals = this.read();
    reserveProposalIds(this.proposals);
  }

  /** Pending proposals, newest first, expired ones already dropped. */
  list(): readonly LearningProposal[] {
    const before = this.proposals.length;
    const cutoff = this.now() - PROPOSAL_TTL_MS;
    this.proposals = this.proposals.filter((p) => p.at >= cutoff);
    if (this.proposals.length !== before) this.write();
    return this.proposals.slice().reverse();
  }

  count(): number {
    return this.list().length;
  }
  /**
   * Offer a candidate fact, or say why it cannot be offered.
   *
   * Screened here rather than at acceptance so the refusal reaches whoever
   * proposed — a mission step that tried to teach Jarvis a token gets that as its
   * result, instead of the user finding an unacceptable row in a list.
   */
  propose(input: ProposalInput): ProposeResult {
    const why = defuseMarkers(sanitiseForDisplay(input.why, 200));
    if (!why) return { ok: false, reason: "a proposal has to say where it came from" };

    let text: string;
    let key: ProfileKey | undefined;
    if (input.kind === "profile") {
      if (!input.key || !isProfileKey(input.key)) {
        return { ok: false, reason: `${input.key ?? "that"} is not a field Jarvis keeps` };
      }
      const screening = screenProfileValue(input.key, input.text);
      if (!screening.ok) return { ok: false, reason: screening.reason };
      text = screening.value;
      key = input.key;
    } else {
      const screening = screenMemory(input.text);
      if (!screening.ok) return { ok: false, reason: screening.reason };
      text = defuseMarkers(sanitiseForDisplay(screening.text, 500));
      if (!text) return { ok: false, reason: "there was nothing left after cleaning that up" };
    }

    if (TRANSIENT.test(text)) {
      return {
        ok: false,
        reason:
          "that reads as true only right now, so it is not worth remembering — " +
          "say it again as something that stays true and I will offer to keep it",
      };
    }

    const already = this.list().some(
      (p) => p.kind === input.kind && p.key === key && p.text.toLowerCase() === text.toLowerCase(),
    );
    if (already) return { ok: false, reason: "that is already waiting to be confirmed" };
    if (input.kind === "memory"
        && this.memory.entriesList().some((e) => e.text.toLowerCase() === text.toLowerCase())) {
      return { ok: false, reason: "that is already saved" };
    }

    const proposal: LearningProposal = {
      id: nextProposalId(),
      at: input.at ?? this.now(),
      kind: input.kind,
      text,
      ...(key ? { key } : {}),
      why,
      ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
    };
    this.proposals.push(proposal);
    // Oldest out first. A full queue must not be able to block a newer suggestion,
    // because the newest is the one the user has context for.
    while (this.proposals.length > MAX_PROPOSALS) this.proposals.shift();
    this.write();
    return { ok: true, proposal };
  }
  /**
   * Commit one proposal, because the user said so.
   *
   * The write is screened *again* by the store it lands in. Belt and braces on
   * purpose: the queue file is editable by hand, and a proposal is the one piece of
   * text in this subsystem that was composed by machinery rather than dictated.
   *
   * A refused write leaves the proposal in place. There is nothing useful the user
   * can do about a rejection they cannot see, and dropping it would make the reason
   * disappear along with the row.
   */
  accept(id: string): AcceptResult {
    const at = this.proposals.findIndex((p) => p.id === id);
    if (at === -1) return { ok: false, reason: "there is no suggestion with that id" };
    const proposal = this.proposals[at]!;

    if (proposal.kind === "profile") {
      const key = proposal.key;
      if (!key) return { ok: false, reason: "that suggestion names no field" };
      const write = this.profile.set(key, proposal.text, "confirmed");
      if (!write.ok) return { ok: false, reason: write.reason };
      this.proposals.splice(at, 1);
      this.write();
      return { ok: true, proposal, speech: `Saved — I have that as your ${key}.` };
    }

    const write = this.memory.remember(proposal.text);
    if (!write.ok) return { ok: false, reason: write.speech };
    this.proposals.splice(at, 1);
    this.write();
    return { ok: true, proposal, speech: write.speech };
  }

  /** Decline one. It goes, and nothing is written anywhere. */
  reject(id: string): LearningProposal | null {
    const at = this.proposals.findIndex((p) => p.id === id);
    if (at === -1) return null;
    const gone = this.proposals.splice(at, 1)[0] ?? null;
    this.write();
    return gone;
  }

  clear(): number {
    const gone = this.proposals.length;
    if (gone === 0) return 0;
    this.proposals = [];
    this.write();
    return gone;
  }
  private read(): LearningProposal[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
      return parsed.flatMap((raw) => {
        if (typeof raw !== "object" || raw === null) return [];
        const o = raw as Record<string, unknown>;
        if (typeof o.id !== "string" || typeof o.text !== "string") return [];
        const kind: ProposalKind = o.kind === "profile" ? "profile" : "memory";
        const key = typeof o.key === "string" && isProfileKey(o.key) ? o.key : undefined;
        if (kind === "profile" && !key) return [];
        const text = defuseMarkers(sanitiseForDisplay(o.text, 500));
        const why = defuseMarkers(sanitiseForDisplay(typeof o.why === "string" ? o.why : "", 200));
        if (!text || !why) return [];
        return [
          {
            id: o.id,
            at: typeof o.at === "number" ? o.at : 0,
            kind,
            text,
            ...(key ? { key } : {}),
            why,
            ...(typeof o.missionId === "string" ? { missionId: o.missionId } : {}),
          },
        ];
      });
    } catch (err) {
      this.onError(`ignoring unreadable suggestion queue at ${this.path}: ${err}`);
      return [];
    }
  }

  private write(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.proposals, null, 2), "utf8");
    renameSync(tmp, this.path);
  }
}

let proposalCounter = 0;

function nextProposalId(): string {
  proposalCounter += 1;
  return `p${proposalCounter.toString(36)}`;
}

function reserveProposalIds(list: readonly LearningProposal[]): void {
  for (const p of list) {
    const m = /^p([0-9a-z]+)$/.exec(p.id);
    if (!m) continue;
    const n = parseInt(m[1]!, 36);
    if (Number.isFinite(n) && n > proposalCounter) proposalCounter = n;
  }
}
/**
 * A mission's steps, as this file needs to see them.
 *
 * Structural rather than an import of `Mission`: memory does not depend on the
 * mission layer, and a `Mission` satisfies this shape without being named here. The
 * dependency runs the other way — the runtime hands a finished mission in.
 */
export interface LessonStep {
  readonly title: string;
  readonly tool: string;
  readonly status: string;
  readonly origin: string;
  readonly error?: string;
}

export interface LessonMission {
  readonly id: string;
  readonly objective: string;
  readonly state: string;
  readonly steps: readonly LessonStep[];
}

/** At most this many suggestions from one mission. One mission is one lesson, usually. */
const MAX_LESSONS = 2;

/**
 * What a finished mission is entitled to suggest.
 *
 * Exactly one pattern qualifies, and it is the only one in the mission record that
 * is an observation rather than an interpretation: **a step failed, a corrective
 * step the replanner added then succeeded, and the mission went on to complete.**
 * That sequence happened, it is written down, and the fact it supports — this needed
 * that first — is the kind of thing worth not rediscovering next week.
 *
 * Everything else a mission "learns" is inference. A mission that failed suggests
 * nothing: what would be proposed is a theory about why, and a theory the user
 * confirms once becomes a fact Jarvis then plans against. That is how a wrong guess
 * turns into a durable wrong belief, and it is exactly what §43 rules out.
 */
export function lessonsFromMission(mission: LessonMission): readonly ProposalInput[] {
  if (mission.state !== "completed") return [];
  const fixes = mission.steps.filter((s) => s.origin === "replan" && s.status === "done");
  if (fixes.length === 0) return [];
  const broke = mission.steps.filter((s) => s.status === "failed" || s.error !== undefined);
  if (broke.length === 0) return [];

  const subject = short(mission.objective, 120);
  const out: ProposalInput[] = [];
  for (const fix of fixes.slice(0, MAX_LESSONS)) {
    const failed = broke[0]!;
    out.push({
      kind: "memory",
      text: `When working on ${subject}: ${short(fix.title, 90)} is needed before ${short(failed.title, 90)} will work.`,
      why: `mission ${mission.id}: ${short(failed.title, 60)} failed, then ${short(fix.title, 60)} verified`,
      missionId: mission.id,
    });
  }
  return out;
}

function short(text: string, max: number): string {
  const flat = sanitiseForDisplay(text, max + 20).trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
