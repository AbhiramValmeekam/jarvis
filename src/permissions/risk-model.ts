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

/** Antivirus, under every name it goes by. */
const AV = String.raw`(?:defender|antivirus|anti\s*virus|win\s*defend\w*|msmpeng|realtime\s*monitoring)`;

/**
 * Things §61 puts out of reach entirely.
 *
 * Matched against the tool name and the flattened arguments together, because
 * `run_command` with `powershell Set-MpPreference -DisableRealtimeMonitoring`
 * hides the intent in the arguments rather than the name. Broad on purpose: a
 * false positive here costs a refusal the user can work around manually, and
 * §61 says to explain what needs doing by hand. A false negative costs them
 * their antivirus.
 */
const FORBIDDEN: ReadonlyArray<{ re: RegExp; why: string }> = [
  {
    re: new RegExp(
      String.raw`\b(?:disable|stop|uninstall|remove|turn\s*off|bypass|kill)\b[^.]{0,40}${AV}`,
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
  const flat = `${action.tool} ${flattenArgs(action.args)}`;
  const paths = extractPaths(flat);

  // Separate strings on purpose: `paths` and the credential patterns need the
  // original text (`id_ed25519` loses its meaning once underscores become
  // spaces), while the forbidden rules need the normalised form.
  const probe = forbiddenProbe(flat);
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
