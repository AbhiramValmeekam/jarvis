/**
 * Email and calendar, mocked on purpose and labelled everywhere.
 *
 * There is no mail account and no calendar account on this machine that Jarvis has
 * been given. §43 says what to do about that, and it is not to write a tool that
 * returns "sent!" — it is to write a tool that really does something observable,
 * says plainly that the something is local, and never claims the message left the
 * building.
 *
 * So these three tools are real writes to a real file under
 * `%LOCALAPPDATA%\Jarvis\mock\`, verified by reading the record back off disk.
 * Nothing is invented: a mission that "sent" an email can be shown the outbox
 * entry, with the time it was written and the address it was addressed to, and the
 * report says `simulated` beside it. That is a mock adapter (§43), not a pretend
 * success — the difference is that the artefact exists and can be inspected.
 *
 * Three decisions worth stating.
 *
 * **`verified`, with `simulated: true`.** A mock that returned `unchecked` would
 * stall every plan with a step after it, because `statusForOutcome()` maps
 * `unconfirmed` and `unchecked` to `unverified` and an unverified step satisfies no
 * dependency. The honest reading is that the *promised* effect — a record in the
 * local outbox — did happen and was checked, and the flag carries the rest of the
 * truth to the wire, the report and the UI, where a person reads it.
 *
 * **These classify as network.** `send_email`, `list_calendar_events` and
 * `create_calendar_event` all match the egress branch in `risk-model.ts`, so they
 * are level 3 and go through the permission engine even though nothing leaves this
 * machine yet. That is deliberate: the day a real provider is wired in behind these
 * names, the consent path is already the one that was tested, rather than a new one
 * written in a hurry.
 *
 * **A draft is not a place to keep a secret.** The body goes through
 * `redactSecrets` before it is written, exactly as a mission log does. An outbox is
 * a record of what was composed, not a credential store, and a mission that pasted
 * a token into an email would otherwise leave it on disk in plain text.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redactSecrets } from "../../context/window-facts.js";
import { defuseMarkers, sanitiseForDisplay } from "../../permissions/risk-model.js";
import { runVerified } from "../../permissions/verified-action.js";
import {
  readNumber,
  readString,
  type Tool,
  type ToolArgs,
  type ToolContext,
  type ToolRun,
} from "../registry.js";

export interface MockEmail {
  readonly id: string;
  readonly at: number;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** True when `redactSecrets` removed something on the way in. */
  readonly redacted: boolean;
}

export interface MockEvent {
  readonly id: string;
  readonly at: number;
  readonly title: string;
  readonly startsAt: number;
  readonly minutes: number;
}

/**
 * `%LOCALAPPDATA%\Jarvis\mock` — beside `missions\`, resolved the same way.
 *
 * One Jarvis data directory per machine, and a name that tells anyone who opens the
 * folder what they are looking at before they read a single record.
 */
export function mockCommsDir(): string {
  const base =
    process.env.LOCALAPPDATA ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "Jarvis", "mock");
}

/** Newest kept per file. An always-on process must not grow a file forever. */
const MAX_RECORDS = 200;

const MAX_BYTES = 512 * 1024;

/**
 * Read a list back, treating the file as untrusted input.
 *
 * Same posture as `cron-store.ts` and `mission-store.ts`: a corrupt or unreadable
 * file yields an empty list rather than an exception, and is left on disk for a
 * person to look at. This runs inside an always-on process, so a bad file must cost
 * a reading and not the runtime.
 */
function readList<T>(path: string, valid: (row: Record<string, unknown>) => T | null): readonly T[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  if (raw.length > MAX_BYTES) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: T[] = [];
  for (const row of parsed) {
    if (row === null || typeof row !== "object") continue;
    const one = valid(row as Record<string, unknown>);
    if (one) out.push(one);
  }
  return out;
}

/** Temp file plus `rename`, as every other store in this repository does. */
function writeList(path: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(rows.slice(-MAX_RECORDS), null, 2), "utf8");
  renameSync(temp, path);
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.slice(0, max) : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validEmail(row: Record<string, unknown>): MockEmail | null {
  const id = str(row["id"], 40);
  const to = str(row["to"], 200);
  const subject = str(row["subject"], 200);
  const at = num(row["at"]);
  if (id === null || to === null || subject === null || at === null) return null;
  return {
    id,
    at,
    to,
    subject,
    body: str(row["body"], 4_000) ?? "",
    redacted: row["redacted"] === true,
  };
}

function validEvent(row: Record<string, unknown>): MockEvent | null {
  const id = str(row["id"], 40);
  const title = str(row["title"], 200);
  const at = num(row["at"]);
  const startsAt = num(row["startsAt"]);
  const minutes = num(row["minutes"]);
  if (id === null || title === null || at === null || startsAt === null) return null;
  return { id, at, title, startsAt, minutes: minutes ?? 30 };
}

// --- the store -------------------------------------------------------------

/**
 * The two files, behind an interface a test can replace.
 *
 * Every read goes to disk rather than to a cached list, because the read *is* the
 * verification: a `send_email` that returned a record from memory would be checking
 * its own claim, which is the exact mistake `verified-action.ts` exists to prevent.
 */
export interface MockCommsStore {
  emails(): readonly MockEmail[];
  addEmail(email: MockEmail): void;
  events(): readonly MockEvent[];
  addEvent(event: MockEvent): void;
}

export function fileCommsStore(dir: string = mockCommsDir()): MockCommsStore {
  const outbox = join(dir, "outbox.json");
  const calendar = join(dir, "calendar.json");
  return {
    emails: () => readList(outbox, validEmail),
    addEmail: (email) => writeList(outbox, [...readList(outbox, validEmail), email]),
    events: () => readList(calendar, validEvent),
    addEvent: (event) =>
      writeList(
        calendar,
        [...readList(calendar, validEvent), event].sort((a, b) => a.startsAt - b.startsAt),
      ),
  };
}

export interface CommsDeps {
  /** Defaults to the files under `%LOCALAPPDATA%`. Tests hand in a temp directory. */
  readonly store?: MockCommsStore;
}

// --- the tools -------------------------------------------------------------

/** Loud enough to survive a screenshot, short enough to fit a summary line. */
const MOCK = "MOCK";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sendEmail(store: MockCommsStore): Tool {
  return {
    name: "send_email",
    summary: `Compose an email — ${MOCK}: no mail account is connected, so it is written to a local outbox and not sent`,
    simulated: true,
    schema: {
      to: { kind: "string", required: true, max: 200, pattern: EMAIL_SHAPE },
      subject: { kind: "string", required: true, max: 200 },
      body: { kind: "string", required: true, max: 4_000 },
    },
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      const to = readString(args, "to");
      const subject = readString(args, "subject");
      const cleaned = redactSecrets(readString(args, "body"));
      const id = randomUUID().slice(0, 8);
      const record: MockEmail = {
        id,
        at: ctx.now(),
        to,
        subject,
        body: cleaned.text,
        redacted: cleaned.redacted,
      };

      const report = await runVerified(
        {
          description: `write that email to the ${MOCK} outbox`,
          observe: () => store.emails().length,
          act: () => store.addEmail(record),
          // Read back by id off disk. A count would move on eviction and stay
          // still on a rewrite, so it is the wrong thing to compare.
          verify: () =>
            store.emails().some((e) => e.id === id)
              ? { ok: true, detail: "it is in the outbox" }
              : { ok: false, reason: "the outbox does not contain it afterwards" },
        },
        { timeoutMs: ctx.timeoutMs, now: ctx.now },
      );

      ctx.log(`send_email (${MOCK}): queued ${id} to ${to}`);
      // When the check did not confirm the write, what a person needs to read is
      // the verifier's sentence, not the sentence that assumed it worked.
      const written = report.outcome === "verified";
      return {
        outcome: report.outcome,
        summary: written
          ? `${MOCK}: nothing was sent — email to ${to} written to the local outbox`
          : `${MOCK}: the outbox was not written, so nothing was composed either`,
        detail: written
          ? `${subject}${cleaned.redacted ? " · a secret in the body was redacted before writing" : ""}`
          : report.detail,
        ...(report.error !== undefined ? { error: report.error } : {}),
        simulated: true,
        data: { id, to, subject, at: record.at, sent: false, outbox: written, redacted: cleaned.redacted },
      };
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function listEvents(store: MockCommsStore): Tool {
  return {
    name: "list_calendar_events",
    summary: `List calendar events — ${MOCK}: no calendar is connected, so this reads the local one Jarvis wrote`,
    simulated: true,
    schema: { days: { kind: "number", min: 1, max: 90, integer: true } },
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      const days = Math.round(readNumber(args, "days", 7));
      const from = ctx.now();
      const until = from + days * DAY_MS;
      const all = store.events();
      const window = all.filter((e) => e.startsAt >= from - DAY_MS && e.startsAt <= until);
      // An empty calendar is a reading. Failing here would send the replanner
      // after a broken tool when the answer is simply "nothing is scheduled".
      return {
        outcome: "verified",
        summary: `${MOCK}: ${window.length} event${window.length === 1 ? "" : "s"} in the next ${days} day${days === 1 ? "" : "s"} (local calendar)`,
        detail:
          window.length === 0
            ? `nothing scheduled — this is Jarvis' local ${MOCK} calendar, not a connected one`
            : window.map((e) => `${new Date(e.startsAt).toISOString()} · ${e.title}`).join("\n"),
        simulated: true,
        data: {
          days,
          total: all.length,
          events: window.map((e) => ({
            id: e.id,
            // Two different threats, so two guards. `defuseMarkers` keeps a title
            // from closing a fence in a prompt that quotes it; `sanitiseForDisplay`
            // keeps a newline or a bidi override out of what is, after all, a label
            // on a card. The registry sanitises `summary` and `detail` on the way
            // out but cannot know the shape of `data`, so a field that a person
            // reads has to be cleaned by the tool that put it there.
            title: sanitiseForDisplay(defuseMarkers(e.title), 200),
            startsAt: e.startsAt,
            minutes: e.minutes,
          })),
        },
      };
    },
  };
}

/** ISO 8601 to the minute, which is what a plan can be asked to produce. */
const ISO_START = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function createEvent(store: MockCommsStore): Tool {
  return {
    name: "create_calendar_event",
    summary: `Add a calendar event — ${MOCK}: no calendar is connected, so it is written to Jarvis' local one`,
    simulated: true,
    schema: {
      title: { kind: "string", required: true, max: 200 },
      start: { kind: "string", required: true, max: 40, pattern: ISO_START },
      minutes: { kind: "number", min: 5, max: 24 * 60, integer: true },
    },
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      const title = readString(args, "title");
      const start = readString(args, "start");
      const startsAt = Date.parse(start);
      if (!Number.isFinite(startsAt)) {
        // The pattern accepts the shape; only a real parse can reject a 13th month.
        // An in-range overflow like 31 February is *not* rejected — V8 rolls it
        // forward — so the detail below prints the instant that was actually
        // stored, which is where a reader sees it landed on 3 March.
        return {
          outcome: "failed",
          summary: "that start time is not a date I can read",
          error: `could not parse ${start} as a date and time`,
        };
      }
      const minutes = Math.round(readNumber(args, "minutes", 30));
      const id = randomUUID().slice(0, 8);
      const record: MockEvent = { id, at: ctx.now(), title, startsAt, minutes };

      const report = await runVerified(
        {
          description: `add that to the ${MOCK} calendar`,
          observe: () => store.events().length,
          act: () => store.addEvent(record),
          verify: () =>
            store.events().some((e) => e.id === id)
              ? { ok: true, detail: "it is in the calendar file" }
              : { ok: false, reason: "the calendar does not contain it afterwards" },
        },
        { timeoutMs: ctx.timeoutMs, now: ctx.now },
      );

      const added = report.outcome === "verified";
      return {
        outcome: report.outcome,
        summary: added
          ? `${MOCK}: "${title}" added to Jarvis' local calendar, not to a real one`
          : `${MOCK}: "${title}" was not added to Jarvis' local calendar`,
        detail: added ? `${new Date(startsAt).toISOString()} for ${minutes} minutes` : report.detail,
        ...(report.error !== undefined ? { error: report.error } : {}),
        simulated: true,
        data: { id, title, startsAt, minutes, calendar: "local-mock" },
      };
    },
  };
}

/**
 * The comms tools, all three labelled and all three real writes.
 *
 * Every field is required or numeric: an email with no recipient is not a draft
 * worth keeping, and a plan that omitted one should be told so rather than have a
 * default invented on its behalf.
 */
export function commsTools(deps: CommsDeps = {}): readonly Tool[] {
  const store = deps.store ?? fileCommsStore();
  return [sendEmail(store), listEvents(store), createEvent(store)];
}
