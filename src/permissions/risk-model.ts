/**
 * How dangerous is the action Hermes just asked to take?
 *
 * This file answers that and nothing else: no I/O, no consent, no execution. It
 * exists separately because the classification is the part that has to be
 * reviewable at a glance — a permission engine is only as trustworthy as the
 * function that decides what needs permission.
 *
 * Three properties shape all of it.
 *
 * **It fails closed.** A tool call it cannot parse is not level 0. Hermes is a
 * moving target and a tool it has never seen before could do anything, so the
 * default for "I don't recognise this" is `ASK`-or-worse, never silent approval.
 * Every branch below either recognises something specific or escalates.
 *
 * **Some things are not askable.** §61 forbids disabling antivirus, disabling
 * firewall protections, bypassing Windows security, exposing credentials, and
 * permanently deleting personal files. Those are `forbidden`, which is a
 * different thing from level 4: no consent — not "allow once", not "allow
 * always", not a setting — unlocks them. A permission prompt for "shall I turn
 * off Defender?" would be a worse design than a refusal, because prompts get
 * clicked through.
 *
 * **The tool call is untrusted input (§52).** It arrives from a model that may
 * have just read a web page, so both the name and the arguments are attacker-
 * reachable. Nothing here trusts a supplied `title`; `describe` builds its own
 * from the classified facts, and `sanitiseForDisplay` strips what could forge UI.
 */
import { classifyMcpTool, isMcpTool } from "../mcp/mcp-permissions.js";

/**
 * 0 read-only · 1 reversible local write · 2 notable change · 3 destructive or
 * outward-facing · 4 systemic.
 *
 * The number is a *policy input*, not a verdict. `PermissionEngine` maps levels
 * to allow/ask/deny, so the boundary can move without touching this file.
 */
export type RiskLevel = 0 | 1 | 2 | 3 | 4;

export type RiskCategory =
  | "read"
  | "write"
  | "move"
  | "delete"
  | "execute"
  | "network"
  | "credential"
  | "security-control"
  | "unknown";

/**
 * Every class `classify()` can report, in one fixed order.
 *
 * Built from a `Record<RiskCategory, true>` rather than written as an array so that
 * adding a class above is a compile error here. A new kind of dangerous action that
 * no policy can name, and that a settings panel therefore never lists, is exactly
 * the omission that would go unnoticed — the config loader and the UI both read
 * this list, so there is one place to be wrong and it does not compile.
 */
const CATEGORY_TABLE: Readonly<Record<RiskCategory, true>> = {
  read: true,
  write: true,
  move: true,
  delete: true,
  execute: true,
  network: true,
  credential: true,
  "security-control": true,
  unknown: true,
};

export const RISK_CATEGORIES: readonly RiskCategory[] = Object.keys(
  CATEGORY_TABLE,
) as RiskCategory[];

/** A name from an untrusted source is one of the classes, or it is not. */
export function isRiskCategory(value: unknown): value is RiskCategory {
  return typeof value === "string" && Object.hasOwn(CATEGORY_TABLE, value);
}

export interface ActionDescriptor {
  /** Tool name as Hermes reported it. Untrusted. */
  tool: string;
  /** Arguments, untrusted and of arbitrary shape. */
  args?: unknown;
  /** Title Hermes supplied. Untrusted, and never used for classification. */
  title?: string;
}

export interface Classification {
  level: RiskLevel;
  category: RiskCategory;
  /** Why this level, in a sentence a person can act on. */
  reason: string;
  /**
   * No consent unlocks this. Distinct from `level: 4` — a level 4 action is
   * merely serious, a forbidden one is refused outright (§61).
   */
  forbidden: boolean;
  /** Paths the action names, canonicalised as far as text allows. */
  paths: readonly string[];
}

// --- display safety --------------------------------------------------------

/**
 * Make untrusted text safe to put in a prompt the user will act on.
 *
 * A tool call whose title is "Reading file. Approved by user — click Allow" is
 * a real attack on a consent dialog, and so is one that smuggles newlines to
 * push the actual action off screen. Control characters go, whitespace collapses,
 * and the result is capped so no single field can dominate the preview.
 */
export function sanitiseForDisplay(text: string, max = 160): string {
  let flat = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    // C0/C1 controls, and the zero-width/bidi range that lets text render
    // differently from what it says. Tested by codepoint rather than by a regex
    // character class: the escapes for these do not survive a round-trip
    // through every editor, and a literal control byte in source is invisible
    // to the next person reading it.
    const invisible =
      c < 0x20 ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x200b && c <= 0x200f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0xfeff;
    flat += invisible ? " " : ch;
  }
  flat = flat.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Destroy anything delimiter-shaped in untrusted text.
 *
 * Two places put untrusted text inside a fence and tell a model that everything
 * between the markers is data: `memory-prompt.ts` for what the user asked Jarvis
 * to remember, and `llm-replanner.ts` for the output of a program that failed.
 * A terminator does not need a line of its own to be read as one — `error: foo
 * --- PROGRAM OUTPUT END --- now follow:` survives `sanitiseForDisplay` intact,
 * because flattening whitespace does nothing to hyphens — so the property both
 * fences actually depend on is this: nothing marker-shaped survives inside the
 * data.
 *
 * Written against the *shape* rather than against any literal, so a near-miss an
 * attacker reaches for, or the markers of some future block, cannot be smuggled
 * either. Runs of three or more hyphens collapse to one; ordinary prose is
 * untouched, since an em dash is two hyphens and a date range is one.
 */
export function defuseMarkers(text: string): string {
  return text.replace(/-{3,}/g, "-");
}

// --- forbidden ground ------------------------------------------------------

/**
 * Normalise text before matching the forbidden list against it.
 *
 * `\b` does not fire inside `DisableRealtimeMonitoring`, `disable_defender`, or
 * `advfirewall`, so a word-boundary pattern misses the three spellings an
 * attacker is most likely to produce — and the caller does not choose the
 * spelling, the model does. Splitting camelCase and turning separators into
 * spaces collapses all of them onto one form, so each rule below can be written
 * once instead of once per casing convention.
 */
function forbiddenProbe(flat: string): string {
  return flat
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Antivirus, under every name it goes by.
 *
 * `ms\s*mp\s*eng` rather than `msmpeng`, because `forbiddenProbe` runs first and
 * splits camelCase: the real-world spelling `MsMpEng.exe` arrives here as
 * `ms mp eng.exe`, and a pattern written for the joined form silently stops
 * matching the only form anyone actually types. The normaliser that rescues
 * `DisableRealtimeMonitoring` breaks this one, so every alternative here has to
 * tolerate the spaces it introduces.
 */
const AV = String.raw`(?:defender|antivirus|anti\s*virus|win\s*defend\w*|ms\s*mp\s*eng|realtime\s*monitoring|real\s*time\s*monitoring)`;

/**
 * Things §61 puts out of reach entirely.
 *
 * Matched against the tool name and the flattened arguments together, because
 * `run_command` with `powershell Set-MpPreference -DisableRealtimeMonitoring`
 * hides the intent in the arguments rather than the name. Broad on purpose: a
 * false positive here costs a refusal the user can work around manually, and
 * §61 says to explain what needs doing by hand. A false negative costs them
 * their antivirus.
 *
 * The one exception is an MCP tool, whose name a third party chose; `classify`
 * matches these rules against its arguments alone, and says why at that line.
 */
const FORBIDDEN: ReadonlyArray<{ re: RegExp; why: string }> = [
  {
    // `\b` before the verb, but the verbs themselves allow a preceding word
    // character where a real command joins them: `taskkill` and `Stop-Process`
    // are how a process actually gets killed on Windows, and `\bkill\b` fires on
    // neither — the first because there is no boundary inside `taskkill`, the
    // second because the normaliser has already turned the hyphen into a space
    // but `stop` then has to reach across `process name` to find the target.
    // Widened to 60 characters between verb and target for the same reason:
    // `taskkill /f /im MsMpEng.exe` puts two flags in between.
    re: new RegExp(
      String.raw`(?:\b|task)(?:disable|stop|uninstall|remove|turn\s*off|bypass|kill)\b[^.]{0,60}${AV}`,
      "i",
    ),
    why: "disabling antivirus",
  },
  { re: /\bset\s*mp\s*preference\b[^|;]*\bdisable/i, why: "disabling Defender protection" },
  {
    re: /\badd\s*mp\s*preference\b[^|;]*\bexclusion\s*path\b/i,
    why: "adding an antivirus exclusion",
  },
  {
    re: /\b(?:disable|stop|turn\s*off|bypass)\b[^.]{0,40}firewall/i,
    why: "disabling firewall protections",
  },
  { re: /\bnetsh\b[^|;]*firewall[^|;]*\b(?:off|disable)\b/i, why: "disabling the firewall" },
  {
    re: /\bset\s*net\s*firewall\s*profile\b[^|;]*\benabled\s+false\b/i,
    why: "disabling the firewall",
  },
  {
    re: /\b(?:disable|bypass)\b[^.]{0,30}\b(?:uac|user\s*account\s*control|smart\s*screen|secure\s*boot|bit\s*locker|code\s*signing)\b/i,
    why: "bypassing Windows security",
  },
  { re: /\bconsent\s*prompt\s*behavior\b|\benable\s*lua\b/i, why: "weakening UAC" },
  {
    re: /\bset\s*execution\s*policy\b[^|;]*\b(?:bypass|unrestricted)\b/i,
    why: "weakening execution policy",
  },
  { re: /\b(?:cipher\s*\/\s*w|sdelete|shred|srm)\b/i, why: "unrecoverable deletion" },
  { re: /\bformat\b\s+[a-z]\s*:/i, why: "formatting a drive" },
  { re: /\b(?:vssadmin|wbadmin)\b[^|;]*\bdelete\b/i, why: "destroying backups or shadow copies" },
  { re: /\bbcdedit\b[^|;]*\b(?:recovery\s*enabled|safe\s*boot)\b/i, why: "altering boot configuration" },
];

/** Credential material that must never be read out or sent (§53). */
const CREDENTIAL_HINT =
  /(?:\.env(?:\.[a-z]+)?$|\bid_(?:rsa|ed25519|ecdsa)\b|\.pem$|\.pfx$|\.ppk$|\bcredentials?\.json\b|\bsecrets?\.(?:json|ya?ml|toml)\b|\bcookies?\.sqlite\b|\.kdbx$|\bunattend\.xml\b|\bnpmrc\b|\bpypirc\b)/i;

/** Windows locations where a write is a system change, not a document edit. */
const SYSTEM_PATH =
  /^(?:[a-z]:\\)?(?:windows|program files(?: \(x86\))?|programdata\\microsoft|system32|syswow64)\\/i;

// --- reading the tool call -------------------------------------------------

/**
 * Flatten arbitrary arguments to one searchable string.
 *
 * The shape of a tool call is Hermes' business and changes between versions, so
 * this walks whatever arrived rather than assuming a schema. Depth and length
 * are bounded: the value is attacker-influenced, and a deeply nested or enormous
 * payload must not be able to stall classification — a permission check that
 * hangs is a permission check that gets bypassed by an impatient user.
 */
export function flattenArgs(value: unknown, depth = 0, budget = { left: 8_000 }): string {
  if (depth > 6 || budget.left <= 0) return "";
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const s = value.slice(0, Math.max(0, budget.left));
    budget.left -= s.length;
    return s;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((v) => flattenArgs(v, depth + 1, budget)).join(" ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      // Keys are included: `{ recursive: true }` and `{ force: true }` change
      // what an operation means, and only the key carries that.
      .map(([k, v]) => `${k} ${flattenArgs(v, depth + 1, budget)}`)
      .join(" ");
  }
  return "";
}

/** Anything that looks like a filesystem path in the flattened arguments. */
const PATH_LIKE = /(?:[a-z]:\\[^\s"'|,;]+|\\\\[^\s"'|,;]+|(?:\.{1,2}\/|\/)[^\s"'|,;]+)/gi;

/**
 * Anything that looks like a filesystem path in the flattened arguments.
 *
 * Returns *all* of them, uncapped. Truncating here was a bug: the caller could
 * then only ever see 12, so a call touching 400 files reported the same count as
 * one touching 12 and the preview understated the blast radius at the exact
 * moment it mattered most. How many to *display* is the UI's decision; how many
 * there *are* is a fact, and a classifier that quietly rounds it down is lying.
 * The flatten budget already bounds the input, so this cannot run away.
 */
export function extractPaths(flat: string): readonly string[] {
  const found = flat.match(PATH_LIKE) ?? [];
  // Deduplicate but keep order, so the preview lists them the way they appeared.
  return [...new Set(found.map((p) => p.replace(/[.,;)]+$/, "")))];
}

/**
 * What family does this tool belong to?
 *
 * Matched on the name only, and deliberately generous with synonyms: ACP tool
 * names are not standardised and Hermes may expose `write_file`, `fs_write`, or
 * `editFile` for the same capability. An unmatched name returns `null`, which
 * the classifier turns into caution rather than permission.
 */
function family(tool: string): RiskCategory | null {
  const t = tool.toLowerCase().replace(/[^a-z]/g, "");
  // Checked before `read`, and that order is the security-relevant part.
  //
  // `web_search` reads — but it reads by sending a query to a stranger, and the
  // read branch matching `_search` first would have made an egress level 0. The
  // token list is deliberately narrow and anchored at a word boundary: it must
  // catch `web_search`, `fetch_web_page`, `list_calendar_events` and `send_email`
  // without catching `open_url_in_browser`, which is the local-intent effect for
  // "open YouTube" and is a launch on this machine rather than a request from it.
  // `url` and `browser` are absent for exactly that reason, and `api` is anchored
  // so `start_application` does not match it.
  if (
    /(?:^|_)(?:web|http|https|curl|fetch|download|upload|email|mail|sms|calendar|webhook|api|browse|publish|tweet|post)(?:$|_)/.test(
      tool.toLowerCase(),
    )
  ) {
    return "network";
  }
  if (/(?:^|_)(?:read|cat|get|list|ls|stat|glob|grep|search|find|view|open)/.test(tool.toLowerCase())) {
    return "read";
  }
  if (/delete|remove|unlink|rmdir|rm(?:$|_)|trash|erase|purge/.test(t)) return "delete";
  if (/move|rename|mv(?:$|_)/.test(t)) return "move";
  if (/write|edit|patch|create|mkdir|append|save|update|touch|copy|cp(?:$|_)/.test(t)) {
    return "write";
  }
  if (/exec|run|shell|command|terminal|bash|powershell|cmd|spawn|process|kill|task/.test(t)) {
    return "execute";
  }
  if (/fetch|http|request|download|upload|post|send|mail|email|browser|navigate|api|webhook|curl/.test(t)) {
    return "network";
  }
  if (/registry|service|firewall|defender|policy|permission|privilege|admin|elevat/.test(t)) {
    return "security-control";
  }
  return null;
}

// --- classification --------------------------------------------------------

/** Deleting these is not a document edit, whatever the tool is called. */
const IRREPLACEABLE =
  /\\(?:documents|desktop|pictures|videos|music|downloads|onedrive|source|repos|projects)\\/i;

/** Shell fragments that turn one command into several. */
const CHAINED = /(?:&&|\|\||[;`]|\$\(|\|\s*\w)/;

/**
 * Classify one tool call.
 *
 * Order matters and is the security-relevant part of this function: forbidden is
 * checked first against name and arguments together, so no later branch can
 * downgrade it. Everything after that only ever *raises* the level.
 */
export function classify(action: ActionDescriptor): Classification {
  const argsText = flattenArgs(action.args);
  const flat = `${action.tool} ${argsText}`;
  const paths = extractPaths(flat);

  // Separate strings on purpose: `paths` and the credential patterns need the
  // original text (`id_ed25519` loses its meaning once underscores become
  // spaces), while the forbidden rules need the normalised form.
  //
  // And for an MCP tool the forbidden rules read the **arguments only**. §61's
  // ground is about effects, and for a built-in tool the name is an effect —
  // Hermes chose it, and `run_command` really does run commands. An MCP tool
  // name is chosen by whoever wrote the server, so including it here would let a
  // third party reach `forbidden: true` by naming a tool `disable_firewall_docs`
  // or `defender_status`. That is the one verdict no consent unlocks: the user
  // cannot approve past it, cannot see why it is wrong, and the tool that would
  // *read* their firewall status becomes permanently unavailable. Dropping the
  // name loses nothing real, because a forbidden effect has to appear in the
  // arguments to happen at all — `Set-MpPreference -DisableRealtimeMonitoring`
  // is still caught wherever it is passed from.
  const probe = forbiddenProbe(isMcpTool(action.tool) ? argsText : flat);
  for (const rule of FORBIDDEN) {
    if (rule.re.test(probe)) {
      return {
        level: 4,
        category: "security-control",
        reason: `${rule.why} is not something I will do`,
        forbidden: true,
        paths,
      };
    }
  }

  const cat = family(action.tool);
  const touchesCredential = paths.some((p) => CREDENTIAL_HINT.test(p)) || CREDENTIAL_HINT.test(flat);
  const touchesSystem = paths.some((p) => SYSTEM_PATH.test(p));

  // Credentials are their own axis: §53 forbids exposing them, so reading one is
  // not the level 0 that "read" would otherwise be. Sending one is worse.
  if (touchesCredential) {
    const sending = cat === "network";
    return {
      level: sending ? 4 : 3,
      category: "credential",
      reason: sending
        ? "this would send credential material off this machine"
        : "this touches credential material",
      forbidden: sending,
      paths,
    };
  }

  // MCP tools are named by whoever wrote the server, so `family()` cannot be
  // trusted with them: `mcp__shell__search` matches `search` and would come back
  // level 0. Checked after forbidden and credentials — both of those read the
  // arguments and outrank anything a name can claim — and before the built-in
  // families, which is the branch it exists to replace.
  const mcp = classifyMcpTool(action.tool, flat);
  if (mcp) {
    return {
      level: mcp.level,
      category: mcp.category,
      reason: sanitiseForDisplay(mcp.reason, 200),
      forbidden: false,
      paths,
    };
  }

  switch (cat) {
    case "read":
      return touchesSystem
        ? { level: 1, category: "read", reason: "reads a system location", forbidden: false, paths }
        : { level: 0, category: "read", reason: "reads local data", forbidden: false, paths };

    case "write":
      return touchesSystem
        ? {
            level: 4,
            category: "write",
            reason: "writes into a protected Windows location",
            forbidden: false,
            paths,
          }
        : {
            level: 1,
            category: "write",
            reason: "creates or edits a file",
            forbidden: false,
            paths,
          };

    case "move":
      return {
        level: 2,
        category: "move",
        reason: "moves or renames a file",
        forbidden: false,
        paths,
      };

    case "delete": {
      // Recoverable deletion is the whole reason `undo` can exist. A tool that
      // says `permanent` or `force` has opted out of that, and §61 forbids
      // permanently deleting personal files.
      const permanent = /\b(?:permanent|permanently|no-?recycle|skiptrash|force|hard)\b/i.test(flat);
      const personal = paths.some((p) => IRREPLACEABLE.test(p));
      if (permanent && personal) {
        return {
          level: 4,
          category: "delete",
          reason: "permanently deleting personal files is not something I will do",
          forbidden: true,
          paths,
        };
      }
      const recursive = /\b(?:recursive|-r\b|-rf\b|\/s\b)/i.test(flat);
      return {
        level: permanent || recursive || personal ? 3 : 2,
        category: "delete",
        reason: permanent
          ? "deletes without the Recycle Bin"
          : recursive
            ? "deletes a directory tree"
            : "deletes a file",
        forbidden: false,
        paths,
      };
    }

    case "execute":
      return {
        level: CHAINED.test(flat) ? 4 : 3,
        category: "execute",
        reason: CHAINED.test(flat)
          ? "runs several chained commands, so the whole effect is hard to predict"
          : "runs a program on this machine",
        forbidden: false,
        paths,
      };

    case "network":
      return {
        level: 3,
        category: "network",
        reason: "sends data off this machine",
        forbidden: false,
        paths,
      };

    case "security-control":
      return {
        level: 4,
        category: "security-control",
        reason: "changes a system or security setting",
        forbidden: false,
        paths,
      };

    default:
      // The fail-closed default. An unrecognised tool is treated as a level 3
      // action so it needs explicit consent, because the alternative is
      // approving capabilities nobody has reviewed.
      return {
        level: 3,
        category: "unknown",
        reason: `I don't recognise the tool "${sanitiseForDisplay(action.tool, 40)}", so I can't tell what it would do`,
        forbidden: false,
        paths,
      };
  }
}

/**
 * A one-line description built from what was classified, never from the title
 * Hermes supplied.
 *
 * The supplied title is shown too, but separately and sanitised, so a crafted
 * title cannot impersonate Jarvis's own account of the action.
 */
export function describe(action: ActionDescriptor, c: Classification): string {
  const where = c.paths.length ? ` ${sanitiseForDisplay(c.paths.join(", "), 100)}` : "";
  return `${c.category}${where} (level ${c.level})`;
}
