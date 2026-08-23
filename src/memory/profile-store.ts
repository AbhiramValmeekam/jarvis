/**
 * The handful of things about the user that are worth stating as fields.
 *
 * Everything else Jarvis remembers is a sentence. This is not: "the user's editor
 * is VS Code" is a *slot with one occupant*, and holding it as free text means the
 * store can end up with three memories naming three editors and no way to know
 * which is current. So the profile is keyed, single-valued, and overwritten in
 * place, and the previous value is gone rather than outvoted.
 *
 * Three rules, and each one is a refusal:
 *
 *  1. **The keys are a fixed vocabulary.** An unknown key is rejected, not stored.
 *     Missions propose profile facts (`learning.ts`), and a store that accepted any
 *     key would let an autonomous loop — or a page of text it read — invent
 *     dimensions of the user to fill in. What may be known about a person here is a
 *     decision made in this file, in advance, by a human.
 *  2. **Nothing is inferred.** `source` is `stated` (the user said so) or
 *     `confirmed` (the user accepted a proposal). There is no `inferred` value to
 *     write, which is the mechanical form of "never silently infer or store
 *     sensitive information": a guess has nowhere to be recorded.
 *  3. **Credential-shaped values are refused, not redacted.** Same as
 *     `screenMemory`, and for the same reason — a profile field reading
 *     `[redacted]` would look answered and be useless, and the user would believe
 *     Jarvis had it.
 */
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { defuseMarkers, sanitiseForDisplay } from "../permissions/risk-model.js";
import { redactSecrets } from "../context/window-facts.js";
import { memoryDir } from "./vector-index.js";

/** How a value got here. There is deliberately no third option. */
export type ProfileSource = "stated" | "confirmed";

export interface ProfileFact {
  readonly key: ProfileKey;
  readonly value: string;
  readonly at: number;
  readonly source: ProfileSource;
}

export function profileFilePath(): string {
  return join(memoryDir(), "profile.json");
}
/**
 * The vocabulary, with the prompt line each field becomes.
 *
 * The list is short on purpose, and what it leaves out is the point: no address, no
 * employer, no phone number, no birthday, nothing about anyone other than the
 * person at the keyboard. Those are the fields an assistant is tempted to collect
 * and has no use for, and every one of them would be a durable copy of personal
 * data in a plain file for the sake of a nicer sentence.
 *
 * `label` is what a screen shows. `hint` is what the Memory page puts under the
 * input, so a person filling this in knows what it is for. `max` is short: these
 * are field values, not notes.
 */
export const PROFILE_FIELDS = {
  name: {
    label: "What to call you",
    hint: "The name Jarvis uses when it addresses you",
    max: 60,
  },
  role: {
    label: "What you do",
    hint: "One line — it sets the register of an explanation, not its content",
    max: 120,
  },
  timezone: {
    label: "Time zone",
    hint: "An IANA name like Europe/London, so a scheduled thing lands where you are",
    max: 60,
  },
  workingHours: {
    label: "Working hours",
    hint: "Like 09:00–18:00 — used to decide when not to interrupt",
    max: 60,
  },
  editor: {
    label: "Editor",
    hint: "Which editor a coding step should assume",
    max: 60,
  },
  shell: {
    label: "Shell",
    hint: "The shell you actually use, so commands are written for it",
    max: 40,
  },
  browser: {
    label: "Browser",
    hint: "Which browser 'open that page' means",
    max: 40,
  },
  focus: {
    label: "Current focus",
    hint: "The project or goal that is live right now",
    max: 160,
  },
} as const;

export type ProfileKey = keyof typeof PROFILE_FIELDS;

export function isProfileKey(key: string): key is ProfileKey {
  return Object.prototype.hasOwnProperty.call(PROFILE_FIELDS, key);
}

/** The keys in display order, with their labels. For the settings page and tools. */
export function profileKeys(): readonly {
  key: ProfileKey;
  label: string;
  hint: string;
  max: number;
}[] {
  return (Object.keys(PROFILE_FIELDS) as ProfileKey[]).map((key) => ({
    key,
    ...PROFILE_FIELDS[key],
  }));
}
export type ProfileScreening =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Decide whether a value may occupy a field.
 *
 * The order matters: redaction is checked on the raw text, before flattening, so a
 * token broken up by a zero-width character cannot pass the pattern check and then
 * be reassembled by the cleanup.
 */
export function screenProfileValue(key: string, raw: string): ProfileScreening {
  if (!isProfileKey(key)) {
    return { ok: false, reason: `${key} is not something Jarvis keeps about you` };
  }
  const field = PROFILE_FIELDS[key];
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return { ok: false, reason: "there was nothing to save" };
  if (trimmed.length > field.max) {
    return {
      ok: false,
      reason: `${field.label} is capped at ${field.max} characters and that is ${trimmed.length}`,
    };
  }
  if (redactSecrets(trimmed).redacted) {
    return {
      ok: false,
      reason:
        "that looks like it contains a password, key or token, so I did not save it — " +
        "no field here is a place to keep one",
    };
  }
  const value = defuseMarkers(sanitiseForDisplay(trimmed, field.max));
  if (!value) return { ok: false, reason: "there was nothing left after cleaning that up" };
  return { ok: true, value };
}

export type ProfileWrite =
  | { readonly ok: true; readonly fact: ProfileFact; readonly replaced?: ProfileFact }
  | { readonly ok: false; readonly reason: string };

export interface ProfileStoreOptions {
  path?: string;
  now?(): number;
  onError?(msg: string): void;
}
/**
 * The store: eight slots, atomic writes, and a refusal path that is reported.
 *
 * A `Map` rather than an array, because "one value per key" is the invariant the
 * whole file exists to hold and a list would let two rows claim the same key after
 * a hand-edit.
 */
export class ProfileStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly onError: (msg: string) => void;
  private facts: Map<ProfileKey, ProfileFact>;

  constructor(opts: ProfileStoreOptions = {}) {
    this.path = opts.path ?? profileFilePath();
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError ?? (() => {});
    this.facts = this.read();
  }

  /** Everything known, in the vocabulary's own order rather than write order. */
  list(): readonly ProfileFact[] {
    return (Object.keys(PROFILE_FIELDS) as ProfileKey[]).flatMap((key) => {
      const fact = this.facts.get(key);
      return fact ? [fact] : [];
    });
  }

  get(key: string): ProfileFact | undefined {
    return isProfileKey(key) ? this.facts.get(key) : undefined;
  }

  count(): number {
    return this.facts.size;
  }

  set(key: string, value: string, source: ProfileSource): ProfileWrite {
    const screening = screenProfileValue(key, value);
    if (!screening.ok) return { ok: false, reason: screening.reason };
    const typed = key as ProfileKey;
    const replaced = this.facts.get(typed);
    const fact: ProfileFact = { key: typed, value: screening.value, at: this.now(), source };
    this.facts.set(typed, fact);
    this.write();
    return { ok: true, fact, ...(replaced ? { replaced } : {}) };
  }

  forget(key: string): ProfileFact | null {
    if (!isProfileKey(key)) return null;
    const had = this.facts.get(key);
    if (!had) return null;
    this.facts.delete(key);
    this.write();
    return had;
  }

  clear(): number {
    const gone = this.facts.size;
    if (gone === 0) return 0;
    this.facts = new Map();
    this.write();
    return gone;
  }
  /**
   * The profile as lines for a prompt or a plan, or `[]`.
   *
   * Rendered as `Label: value`, which reads as a field and not as a sentence — a
   * plain sentence in a prompt block is the thing an instruction can hide inside.
   * The block these go into is fenced by the caller (`memory-prompt.ts`), and the
   * values were marker-defused on the way in, so neither the label nor the value
   * can close that fence.
   */
  promptLines(): readonly string[] {
    return this.list().map((f) => `${PROFILE_FIELDS[f.key].label}: ${f.value}`);
  }

  private read(): Map<ProfileKey, ProfileFact> {
    const out = new Map<ProfileKey, ProfileFact>();
    if (!existsSync(this.path)) return out;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected a JSON object");
      }
      for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
        if (!isProfileKey(key)) continue;
        if (typeof raw !== "object" || raw === null) continue;
        const o = raw as Record<string, unknown>;
        if (typeof o.value !== "string") continue;
        // Re-screened rather than trusted. The file is editable by hand, and a
        // value typed into it directly never passed `set`. A row that fails is
        // dropped — repairing it would put a half-corrected fact about the user
        // into every prompt.
        const screening = screenProfileValue(key, o.value);
        if (!screening.ok) {
          this.onError(`dropping profile ${key} from ${this.path}: ${screening.reason}`);
          continue;
        }
        out.set(key, {
          key,
          value: screening.value,
          at: typeof o.at === "number" ? o.at : 0,
          source: o.source === "confirmed" ? "confirmed" : "stated",
        });
      }
      return out;
    } catch (err) {
      this.onError(`ignoring unreadable profile at ${this.path}: ${err}`);
      return new Map();
    }
  }

  private write(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const body: Record<string, ProfileFact> = {};
    for (const fact of this.list()) body[fact.key] = fact;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2), "utf8");
    renameSync(tmp, this.path);
  }
}
