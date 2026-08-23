/**
 * Web search, when there is a provider — and a mock that says so when there is not.
 *
 * There is no free search API worth pretending about: every one of them needs a
 * key, and a Jarvis with no key must still be able to run a mission that says
 * "look this up". §43 decides what happens then, and it is not a fabricated result
 * list. `mockSearchProvider` returns three entries on `example.invalid` — a domain
 * the DNS root guarantees will never resolve — with `MOCK` in every title, and the
 * tool that wraps it reports `simulated: true` so the label survives all the way to
 * the report and the UI.
 *
 * Two real providers, chosen because both answer with JSON over one request and
 * neither needs an SDK:
 *
 *  - **Brave** takes the key in `x-subscription-token` on a GET.
 *  - **Tavily** takes it in the POST body, which matters here: `webRequest` refuses
 *    to send an `authorization` header a caller supplied, and that refusal is not
 *    worth weakening for one provider.
 *
 * Both go out through `webRequest`, so a search is guarded, size-capped and
 * redirect-checked like any other fetch. That is belt and braces for a hosted API,
 * and it is free.
 */
import { redactSecrets } from "../../llm/provider.js";
import { webRequest, type WebRequest } from "./web-client.js";

export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export type SearchOutcome =
  | { readonly ok: true; readonly hits: readonly SearchHit[] }
  | { readonly ok: false; readonly reason: string };

export interface SearchCall {
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly allowHosts?: readonly string[];
}

export interface SearchProvider {
  /** Named on the wire and in the report, so "which search" is never a guess. */
  readonly name: string;
  /** True when nothing leaves this machine. Only the mock sets it. */
  readonly simulated: boolean;
  /** One line about how it was configured, with no key in it. */
  readonly note: string;
  search(query: string, limit: number, call: SearchCall): Promise<SearchOutcome>;
}

/** Where the keys come from. Documented in `.env.example`. */
export const SEARCH_ENV_KEYS = {
  brave: "BRAVE_SEARCH_API_KEY",
  tavily: "TAVILY_API_KEY",
} as const;

const MAX_QUERY = 400;

function clean(text: unknown, max: number): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** A hit is only a hit if it has a URL a later step could actually visit. */
function hitFrom(title: unknown, url: unknown, snippet: unknown): SearchHit | null {
  const href = clean(url, 500);
  if (!/^https?:\/\//i.test(href)) return null;
  return { title: clean(title, 200) || href, url: href, snippet: clean(snippet, 400) };
}

// --- the mock --------------------------------------------------------------

/**
 * What a search looks like with nothing configured.
 *
 * `example.invalid` is reserved by RFC 2606 precisely so that it cannot resolve, so
 * a step that tries to follow one of these gets a refusal rather than a stranger's
 * server. The titles say MOCK because a report is read by someone who did not watch
 * the run.
 */
export function mockSearchProvider(): SearchProvider {
  return {
    name: "mock",
    simulated: true,
    note: `no search provider configured (${SEARCH_ENV_KEYS.brave} or ${SEARCH_ENV_KEYS.tavily})`,
    async search(query: string, limit: number): Promise<SearchOutcome> {
      const q = clean(query, MAX_QUERY);
      const hits: SearchHit[] = [1, 2, 3].slice(0, Math.max(1, Math.min(limit, 3))).map((n) => ({
        title: `MOCK result ${n} for "${q}"`,
        url: `https://example.invalid/mock/${n}?q=${encodeURIComponent(q)}`,
        snippet:
          "This is a mock search result. No search provider is configured, so nothing " +
          "was sent anywhere and this text was written by Jarvis, not found on the web.",
      }));
      return { ok: true, hits };
    },
  };
}

// --- Brave -----------------------------------------------------------------

function braveProvider(key: string): SearchProvider {
  return {
    name: "brave",
    simulated: false,
    note: `Brave Search, keyed from ${SEARCH_ENV_KEYS.brave}`,
    async search(query: string, limit: number, call: SearchCall): Promise<SearchOutcome> {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", clean(query, MAX_QUERY));
      url.searchParams.set("count", String(Math.max(1, Math.min(limit, 10))));
      const result = await request(
        {
          url: url.toString(),
          method: "GET",
          headers: { "x-subscription-token": key, accept: "application/json" },
          timeoutMs: call.timeoutMs,
          ...(call.fetchImpl ? { fetchImpl: call.fetchImpl } : {}),
          ...(call.resolve ? { resolve: call.resolve } : {}),
          ...(call.allowHosts ? { allowHosts: call.allowHosts } : {}),
        },
        key,
      );
      if (!result.ok) return result;
      const web = (result.json as { web?: { results?: unknown } }).web;
      const rows = Array.isArray(web?.results) ? web.results : [];
      return { ok: true, hits: collect(rows, limit, (row) => hitFrom(row.title, row.url, row.description)) };
    },
  };
}

// --- Tavily ----------------------------------------------------------------

function tavilyProvider(key: string): SearchProvider {
  return {
    name: "tavily",
    simulated: false,
    note: `Tavily, keyed from ${SEARCH_ENV_KEYS.tavily}`,
    async search(query: string, limit: number, call: SearchCall): Promise<SearchOutcome> {
      const result = await request(
        {
          url: "https://api.tavily.com/search",
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          // The key goes in the body because `webRequest` will not send an
          // `authorization` header on a caller's say-so, and that rule is worth
          // more than the convenience of matching Tavily's documented example.
          body: JSON.stringify({
            api_key: key,
            query: clean(query, MAX_QUERY),
            max_results: Math.max(1, Math.min(limit, 10)),
            search_depth: "basic",
          }),
          timeoutMs: call.timeoutMs,
          ...(call.fetchImpl ? { fetchImpl: call.fetchImpl } : {}),
          ...(call.resolve ? { resolve: call.resolve } : {}),
          ...(call.allowHosts ? { allowHosts: call.allowHosts } : {}),
        },
        key,
      );
      if (!result.ok) return result;
      const rows = (result.json as { results?: unknown }).results;
      return {
        ok: true,
        hits: collect(Array.isArray(rows) ? rows : [], limit, (row) =>
          hitFrom(row.title, row.url, row.content),
        ),
      };
    },
  };
}

// --- shared plumbing -------------------------------------------------------

type Row = Readonly<Record<string, unknown>>;

function collect(rows: readonly unknown[], limit: number, read: (row: Row) => SearchHit | null): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const hit = read(row as Row);
    if (hit) hits.push(hit);
    if (hits.length >= limit) break;
  }
  return hits;
}

type Parsed = { readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly reason: string };

/**
 * One request to a search API, with the key scrubbed from anything that comes back.
 *
 * The reason string reaches a step's error, a log line and possibly a replanner
 * prompt, and a provider that echoes the key into its own error message is a real
 * thing that happens — `probe:llm` asserts the same behaviour for the model key.
 */
async function request(req: WebRequest, key: string): Promise<Parsed> {
  const result = await webRequest(req);
  if (!result.ok) return { ok: false, reason: redactSecrets(result.reason, [key]) };
  try {
    return { ok: true, json: JSON.parse(result.text) };
  } catch {
    return {
      ok: false,
      reason: `the search provider answered ${result.status} with something that is not JSON`,
    };
  }
}

/**
 * Pick a provider from the environment, or return the mock.
 *
 * Never null: a caller asking for search always gets something it can call, and
 * what it must check is `simulated`. Returning null would mean every call site
 * reimplementing the "no provider" case, and one of them would get it wrong by
 * saying nothing at all.
 */
export function createSearchProvider(env: Readonly<Record<string, string | undefined>>): SearchProvider {
  const brave = (env[SEARCH_ENV_KEYS.brave] ?? "").trim();
  if (brave !== "") return braveProvider(brave);
  const tavily = (env[SEARCH_ENV_KEYS.tavily] ?? "").trim();
  if (tavily !== "") return tavilyProvider(tavily);
  return mockSearchProvider();
}


