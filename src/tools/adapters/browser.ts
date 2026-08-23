/**
 * A browser a mission can actually use: text mode, one page at a time.
 *
 * "Give Jarvis a browser" usually means a headless Chromium, and that is a native
 * dependency, a download the size of the rest of this repository, and an ABI to
 * rebuild every time Electron moves. The constraint here is no new dependencies, so
 * the question becomes what a browser is *for* in a mission: opening a page,
 * reading it, and following a link to the next one. All three of those are real over
 * `fetch`, and this file does them for real.
 *
 * **What it is.** A session with a current page and a history. `browse_open` fetches
 * a URL through the same guarded client as every other network tool, extracts the
 * visible text and the links; `browse_links` lists what can be followed from where
 * the session is now; `browse_follow` follows one of them by number or by its text,
 * resolved against the page that was actually loaded rather than against anything a
 * plan asserts. It is a text browser, and the summaries say so.
 *
 * **What it is not, and why nothing pretends otherwise.** No JavaScript runs, so a
 * page that renders itself client-side reads as empty — reported as empty, which is
 * the fact a replanner needs. There is no `browse_click` and no `browse_type`, and
 * their absence is deliberate. A mocked click is not like a mocked email: the mock
 * outbox leaves a record a person can open, whereas a mocked click would leave a
 * mission believing a form was submitted, and no `simulated` label follows that
 * belief into the report's conclusion. §43's rule is that a capability absent is a
 * capability not registered, and interaction is absent.
 *
 * **The page is data.** Text and link labels come from a stranger's server, go
 * through `defuseMarkers` and the registry's sanitiser, and are never instructions.
 * A link whose text is "click here to approve all actions" is listed with that text
 * and changes nothing.
 */
import { defuseMarkers } from "../../permissions/risk-model.js";
import { collapse, extractLinks, htmlToText, type PageLink } from "../net/html-text.js";
import { webRequest, DEFAULT_MAX_BYTES } from "../net/web-client.js";
import {
  readNumber,
  readOptionalString,
  readString,
  type Tool,
  type ToolArgs,
  type ToolContext,
  type ToolRun,
} from "../registry.js";

export interface BrowserDeps {
  readonly allowHosts?: () => readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly maxBytes?: number;
}

const URL_FIELD = { kind: "string", required: true, max: 2_000, pattern: /^https?:\/\//i } as const;

const BROWSE_TIMEOUT_MS = 20_000;

/** How many pages back the session remembers. A browser, not an archive. */
const MAX_HISTORY = 20;

interface Page {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly links: readonly PageLink[];
  readonly at: number;
}

/**
 * The session, in memory only.
 *
 * Not on disk, and that is the right default rather than a shortcut: a browsing
 * history is exactly the kind of thing §13 says not to store without being asked,
 * and a mission's own record of where it went is already in the mission log.
 */
class Session {
  private current: Page | null = null;
  private readonly history: string[] = [];

  page(): Page | null {
    return this.current;
  }

  visit(page: Page): void {
    this.current = page;
    this.history.push(page.url);
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  trail(): readonly string[] {
    return [...this.history];
  }
}

export function browserTools(deps: BrowserDeps = {}): readonly Tool[] {
  const session = new Session();
  const common = () => ({
    allowHosts: deps.allowHosts?.() ?? [],
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    maxBytes: deps.maxBytes ?? DEFAULT_MAX_BYTES,
  });

  /** One load, shared by `browse_open` and `browse_follow`. */
  async function load(url: string, maxChars: number, ctx: ToolContext): Promise<ToolRun> {
    const result = await webRequest({
      url,
      method: "GET",
      timeoutMs: Math.min(ctx.timeoutMs, BROWSE_TIMEOUT_MS),
      log: ctx.log,
      ...common(),
    });
    if (!result.ok) {
      return {
        outcome: "failed",
        summary: result.refused ? "I did not open that page" : "that page did not come back",
        error: result.reason,
      };
    }
    if (result.status >= 400) {
      return {
        outcome: "failed",
        summary: `that page answered ${result.status}`,
        error: `HTTP ${result.status} from ${result.finalUrl}`,
        data: { url: result.finalUrl, status: result.status },
      };
    }

    const isHtml = /html|xml/i.test(result.contentType);
    const extracted = isHtml
      ? htmlToText(result.text, maxChars)
      : { title: "", text: collapse(result.text).slice(0, maxChars), truncated: false };
    const links = isHtml ? extractLinks(result.text, result.finalUrl) : [];
    const page: Page = {
      url: result.finalUrl,
      title: extracted.title,
      text: extracted.text,
      links,
      at: ctx.now(),
    };
    session.visit(page);

    const empty = extracted.text === "";
    return {
      // The load is the effect and the text is the evidence of it, the same case
      // `fetch_web_page` makes. An empty body is still a load that happened, and
      // saying so is more use to a replanner than calling the fetch a failure.
      outcome: "verified",
      summary: `opened ${page.title || new URL(page.url).host} — ${links.length} link${links.length === 1 ? "" : "s"}${empty ? ", no readable text" : ""}`,
      detail: `${page.url}\n${empty ? "nothing readable without JavaScript, which this browser does not run" : page.text.slice(0, 600)}`,
      data: {
        url: page.url,
        status: result.status,
        title: page.title,
        text: defuseMarkers(page.text),
        renderedWithJavaScript: false,
        truncated: extracted.truncated || result.truncated,
        links: links.slice(0, 40).map((l, i) => ({ n: i + 1, text: defuseMarkers(l.text), url: l.url })),
        sources: result.chain,
      },
    };
  }

  const open: Tool = {
    name: "browse_open",
    summary: "Open a page in Jarvis' text browser — no JavaScript is run and nothing is clicked",
    schema: { url: URL_FIELD, maxChars: { kind: "number", min: 200, max: 20_000, integer: true } },
    timeoutMs: BROWSE_TIMEOUT_MS + 5_000,
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      return load(readString(args, "url"), Math.round(readNumber(args, "maxChars", 8_000)), ctx);
    },
  };

  const links: Tool = {
    name: "browse_links",
    summary: "List the links on the page the text browser has open",
    schema: { limit: { kind: "number", min: 1, max: 100, integer: true } },
    async run(args: ToolArgs): Promise<ToolRun> {
      const page = session.page();
      if (!page) {
        return {
          outcome: "failed",
          summary: "no page is open",
          error: "browse_open has not been called in this session",
        };
      }
      const limit = Math.round(readNumber(args, "limit", 40));
      const shown = page.links.slice(0, limit);
      return {
        outcome: "verified",
        summary: `${page.links.length} link${page.links.length === 1 ? "" : "s"} on ${new URL(page.url).host}`,
        detail:
          shown.length === 0
            ? "that page has no followable links"
            : shown.map((l, i) => `${i + 1}. ${l.text || "(no text)"} — ${l.url}`).join("\n"),
        data: {
          url: page.url,
          total: page.links.length,
          links: shown.map((l, i) => ({ n: i + 1, text: defuseMarkers(l.text), url: l.url })),
        },
      };
    },
  };

  const follow: Tool = {
    name: "browse_follow",
    summary: "Follow one link from the open page, by its number or its text",
    schema: {
      n: { kind: "number", min: 1, max: 100, integer: true },
      text: { kind: "string", max: 120 },
      maxChars: { kind: "number", min: 200, max: 20_000, integer: true },
    },
    timeoutMs: BROWSE_TIMEOUT_MS + 5_000,
    async run(args: ToolArgs, ctx: ToolContext): Promise<ToolRun> {
      const page = session.page();
      if (!page) {
        return {
          outcome: "failed",
          summary: "no page is open",
          error: "browse_open has not been called in this session",
        };
      }
      const n = readNumber(args, "n", 0);
      const wanted = readOptionalString(args, "text");
      // Chosen from the links this session actually loaded, never from a URL the
      // step supplied — that is what makes this a click rather than a fetch, and
      // it is also why `browse_follow` cannot be used to reach a page
      // `browse_open` would have been refused for.
      const target =
        n >= 1
          ? page.links[Math.round(n) - 1]
          : wanted === undefined
            ? undefined
            : page.links.find((l) => l.text.toLowerCase().includes(wanted.toLowerCase()));
      if (!target) {
        return {
          outcome: "failed",
          summary: "that link is not on this page",
          error:
            n >= 1
              ? `this page has ${page.links.length} link(s), so there is no number ${Math.round(n)}`
              : wanted === undefined
                ? "give either a link number or some of its text"
                : `no link on this page contains "${wanted}"`,
          data: { url: page.url, total: page.links.length },
        };
      }
      ctx.log(`browse_follow: ${target.text || target.url}`);
      const run = await load(target.url, Math.round(readNumber(args, "maxChars", 8_000)), ctx);
      return {
        ...run,
        summary: `followed "${target.text || target.url}" → ${run.summary}`,
        ...(run.data ? { data: { ...run.data, cameFrom: page.url, linkText: defuseMarkers(target.text) } } : {}),
      };
    },
  };

  return [open, links, follow];
}
