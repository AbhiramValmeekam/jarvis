/**
 * The one way a mission reaches the internet, and the guard in front of it.
 *
 * `fetch` is a global in Node 22, so the HTTP part of this file is four lines. The
 * rest is the part that matters: an autonomous loop planning its own steps from a
 * model's output must not be able to turn "look this up" into a request to
 * something that only this machine can reach.
 *
 * What is refused before a socket is opened, and why each one is here:
 *
 *  1. **Anything that is not http(s).** `file:`, `data:` and `ftp:` are not
 *     network reads; `file:` in particular would be the filesystem sandbox
 *     bypassed by way of a URL.
 *  2. **Credentials in the URL.** `https://user:pass@host` would send them, and
 *     §53 says a credential Jarvis holds is a credential Jarvis does not spend.
 *  3. **Loopback, private, link-local and carrier-NAT addresses.** The cloud
 *     metadata endpoint at `169.254.169.254` is the reason this list is not
 *     "localhost"; a router admin page at `192.168.1.1` is the reason it is not
 *     just the metadata endpoint. Hostnames are resolved and *every* address they
 *     answer with is checked, because `internal.example.com` resolving to `10.0.0.5`
 *     is the same request as asking for `10.0.0.5`.
 *  4. **Infrastructure ports.** Redis, Postgres, MySQL, Mongo, Docker and friends
 *     will happily read an HTTP request as a command; a request Jarvis cannot
 *     usefully make is one it should not be able to attempt.
 *  5. **Every redirect, again.** `redirect: "manual"`, and each `Location` goes
 *     back through the same guard. A public host answering 302 to
 *     `http://169.254.169.254/` is the whole reason this cannot be left to `fetch`.
 *
 * One limit stated rather than hidden: the check resolves DNS and then lets
 * `fetch` resolve it again, so a name that answers with a public address for the
 * first lookup and a private one for the second (DNS rebinding) is not closed off
 * by this file. Closing it needs the connection pinned to the address that was
 * checked, which `fetch` gives no way to do. What is closed off is every case that
 * does not require an attacker to control the DNS answers for a name Jarvis was
 * already asked to visit.
 *
 * Reaching a private address is possible, and only deliberately: `allowHosts`
 * carries the `host:port` entries a user put in `webAllowHosts`, and nothing a
 * plan or a model says can add to it.
 */
import { lookup } from "node:dns/promises";

export type WebMethod = "GET" | "HEAD" | "POST";

export interface WebRequest {
  readonly url: string;
  readonly method?: WebMethod;
  readonly headers?: Readonly<Record<string, string>>;
  /** Sent only for POST, and counted against the same size ceiling. */
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxBytes?: number;
  /** `host` or `host:port` a user allowed past the private-address guard. */
  readonly allowHosts?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  /** Injected by tests so no unit test needs a resolver. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly log?: (line: string) => void;
}

export interface WebResponse {
  readonly ok: true;
  readonly status: number;
  /** Where the bytes actually came from, after any redirects. */
  readonly finalUrl: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly text: string;
  /** Every URL in the chain, first to last, for the sources a report shows. */
  readonly chain: readonly string[];
}

export interface WebRefusal {
  readonly ok: false;
  /** True when this machine never sent anything — a guard, not a failure. */
  readonly refused: boolean;
  readonly reason: string;
  readonly status?: number;
  readonly finalUrl?: string;
}

export type WebResult = WebResponse | WebRefusal;

/** Body ceiling. A page bigger than this is truncated, never buffered whole. */
export const DEFAULT_MAX_BYTES = 512 * 1024;

/** How many `Location` hops to follow before calling it a loop. */
const MAX_REDIRECTS = 3;

/**
 * Content types worth handing to a later step.
 *
 * A mission step reads text. An image or a zip would arrive as replacement
 * characters and a size, which is a worse answer than saying what it was.
 */
const TEXTUAL = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|javascript|x-ndjson)|[^;]*\+json)/i;

/**
 * Ports where an HTTP request is a protocol confusion attack rather than a fetch.
 *
 * Not exhaustive and not trying to be: these are the ones a hosted service is
 * likely to have listening on a private network, which is exactly what an SSRF is
 * aimed at.
 */
const BLOCKED_PORTS = new Set([
  22, 23, 25, 110, 135, 137, 138, 139, 143, 445, 465, 587, 993, 995, 1433, 1521,
  2049, 2375, 2376, 3306, 3389, 5432, 5984, 6379, 7000, 7001, 8020, 9042, 9160,
  9200, 9300, 11211, 27017, 27018, 50070,
]);

// --- addresses -------------------------------------------------------------

/** An IPv4 literal, as four numbers, or null if it is not one. */
function ipv4(host: string): readonly number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

/**
 * Is this address one only this machine or this network can reach?
 *
 * Written as explicit ranges rather than a library because the ranges are the
 * security decision and belong where they can be read. IPv4-mapped IPv6
 * (`::ffff:10.0.0.1`) is unwrapped first — it is the same address wearing a
 * different notation, and treating the two differently is how a check like this
 * gets bypassed.
 */
export function isPrivateAddress(raw: string): boolean {
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone >= 0) host = host.slice(0, zone);

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped) return isPrivateAddress(mapped[1]!);
  // `::ffff:a00:1` — the same mapping written in hex.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hexMapped) {
    const high = Number.parseInt(hexMapped[1]!, 16);
    const low = Number.parseInt(hexMapped[2]!, 16);
    return isPrivateAddress(
      `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`,
    );
  }

  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = [v4[0]!, v4[1]!];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, and the metadata endpoint
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true; // 192.0.0/24 and the doc ranges
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (host === "::" || host === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // unique local
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // link-local
  if (/^ff[0-9a-f]{2}:/.test(host)) return true; // multicast
  return false;
}

// --- the guard -------------------------------------------------------------

/** Names that only mean something inside one network. */
const INTERNAL_SUFFIX = /\.(?:local|localhost|internal|intranet|lan|home|home\.arpa|corp|test|localdomain)$/i;

export type UrlVerdict =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: string };

function allowed(url: URL, allow: readonly string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const withPort = url.port === "" ? host : `${host}:${url.port}`;
  return allow.some((entry) => {
    const want = entry.trim().toLowerCase();
    return want === host || want === withPort;
  });
}

/**
 * Decide whether one URL may be requested at all.
 *
 * `resolve` is separate from the fetch so this can be asserted without a network:
 * tests hand it a function that answers `10.0.0.5` for a public-looking name,
 * which is the DNS side of an SSRF and cannot be demonstrated any other way.
 */
export async function checkUrl(
  raw: string,
  allow: readonly string[] = [],
  resolve: (host: string) => Promise<readonly string[]> = resolveHost,
): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "that is not a URL I can parse" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `${url.protocol.replace(":", "")} is not a web request; I only make http and https ones` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "that URL carries a username or password, and I will not send one" };
  }

  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  const permitted = allowed(url, allow);
  if (BLOCKED_PORTS.has(port)) {
    return { ok: false, reason: `port ${port} is not a web port — an HTTP request there is not a page fetch` };
  }

  const host = url.hostname.toLowerCase();
  if (permitted) return { ok: true, url };

  if (host === "localhost" || INTERNAL_SUFFIX.test(host)) {
    return { ok: false, reason: `${host} is a name only this network can resolve; add it to webAllowHosts if you meant it` };
  }
  if (!host.includes(".") && !host.includes(":")) {
    return { ok: false, reason: `${host} has no domain, so it is an internal name; add it to webAllowHosts if you meant it` };
  }
  if (isPrivateAddress(host)) {
    return { ok: false, reason: `${host} is a private or loopback address; add it to webAllowHosts if you meant it` };
  }

  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    return { ok: false, reason: `I could not resolve ${host}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (addresses.length === 0) return { ok: false, reason: `${host} resolved to no addresses` };
  const priv = addresses.find((a) => isPrivateAddress(a));
  if (priv !== undefined) {
    return { ok: false, reason: `${host} resolves to ${priv}, which is inside this network` };
  }
  return { ok: true, url };
}

async function resolveHost(host: string): Promise<readonly string[]> {
  const answers = await lookup(host, { all: true });
  return answers.map((a) => a.address);
}

// --- the request -----------------------------------------------------------

/**
 * Headers Jarvis sends, and the ones it refuses to be told to send.
 *
 * A caller may add an `accept` or an `x-`; it may not set a `cookie`, an
 * `authorization` or a `host`. The first two would be credentials travelling on a
 * plan's say-so, and the third is how a request to a public address gets routed to
 * a private virtual host.
 */
const FORBIDDEN_HEADERS = new Set(["cookie", "authorization", "proxy-authorization", "host", "referer"]);

const UA = "Jarvis/0.1 (+local assistant; one user, no crawling)";

function safeHeaders(supplied: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = { "user-agent": UA, accept: "text/html,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1" };
  for (const [key, value] of Object.entries(supplied ?? {})) {
    const name = key.trim().toLowerCase();
    if (FORBIDDEN_HEADERS.has(name)) continue;
    if (!/^[a-z0-9-]+$/.test(name)) continue;
    if (/[\r\n]/.test(value)) continue;
    out[name] = value.slice(0, 500);
  }
  return out;
}

/**
 * One web request, guarded, bounded, and followed by hand.
 *
 * Returns rather than throws: a mission step reports a refusal as a fact, and the
 * difference between "I would not send that" and "the server said 500" is
 * information the replanner needs.
 */
export async function webRequest(req: WebRequest): Promise<WebResult> {
  const doFetch = req.fetchImpl ?? fetch;
  const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
  const method = req.method ?? "GET";
  const allow = req.allowHosts ?? [];
  const chain: string[] = [];
  let target = req.url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const verdict = await checkUrl(target, allow, req.resolve ?? resolveHost);
    if (!verdict.ok) {
      return { ok: false, refused: true, reason: verdict.reason, ...(chain.length ? { finalUrl: chain[chain.length - 1]! } : {}) };
    }
    const url = verdict.url.toString();
    chain.push(url);

    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers: safeHeaders(req.headers),
        redirect: "manual",
        signal: AbortSignal.timeout(req.timeoutMs),
        ...(method === "POST" && req.body !== undefined ? { body: req.body.slice(0, maxBytes) } : {}),
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { ok: false, refused: false, reason: `could not reach ${verdict.url.host}: ${why}`, finalUrl: url };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) {
        return { ok: false, refused: false, reason: `${response.status} with no destination to follow`, status: response.status, finalUrl: url };
      }
      if (hop === MAX_REDIRECTS) {
        return { ok: false, refused: false, reason: `too many redirects (${MAX_REDIRECTS + 1} hops)`, status: response.status, finalUrl: url };
      }
      // Resolved against the URL that answered, then re-checked from the top of
      // this loop. This is the hop that makes the guard worth having.
      try {
        target = new URL(location, url).toString();
      } catch {
        return { ok: false, refused: false, reason: "that redirect is not a URL I can parse", status: response.status, finalUrl: url };
      }
      req.log?.(`following ${response.status} to ${target}`);
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (method !== "HEAD" && !TEXTUAL.test(contentType.trim())) {
      return {
        ok: false,
        refused: false,
        reason: `that answered with ${contentType === "" ? "no content type" : contentType.split(";")[0]}, which is not text I can read`,
        status: response.status,
        finalUrl: url,
      };
    }

    const read = await readCapped(response, maxBytes, req.timeoutMs);
    if (!read.ok) return { ok: false, refused: false, reason: read.reason, status: response.status, finalUrl: url };

    return {
      ok: true,
      status: response.status,
      finalUrl: url,
      contentType: contentType.split(";")[0]?.trim() ?? "",
      bytes: read.bytes,
      truncated: read.truncated,
      text: read.text,
      chain,
    };
  }

  return { ok: false, refused: false, reason: "too many redirects" };
}

// --- reading a body without buffering all of it -----------------------------

type Capped =
  | { readonly ok: true; readonly text: string; readonly bytes: number; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Read at most `maxBytes`, and stop reading rather than stop after.
 *
 * `response.text()` would buffer whatever the server decided to send, so a
 * 900 MB "page" would be a memory ceiling reached inside the always-on process.
 * The stream is read chunk by chunk and cancelled at the cap, which is why the
 * truncation is reported as a fact rather than discovered by a later step
 * wondering why the HTML stops mid-tag.
 */
async function readCapped(response: Response, maxBytes: number, timeoutMs: number): Promise<Capped> {
  const body = response.body;
  if (body === null) return { ok: true, text: "", bytes: 0, truncated: false };

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const reader = body.getReader();
  const deadline = Date.now() + timeoutMs;
  let bytes = 0;
  let truncated = false;
  let text = "";

  try {
    for (;;) {
      if (Date.now() > deadline) {
        // A body that stops arriving mid-stream is its own hang, separate from the
        // time-to-headers the abort signal covers. Reported as a failure rather
        // than as a short page, because half a document read as a whole one is how
        // a later step concludes something false.
        return { ok: false, reason: "the server stopped sending mid-response" };
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes >= maxBytes) {
        const keep = value.subarray(0, Math.max(0, value.byteLength - (bytes - maxBytes)));
        text += decoder.decode(keep, { stream: true });
        truncated = true;
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text, bytes: Math.min(bytes, maxBytes), truncated };
  } catch (err) {
    return { ok: false, reason: `could not read the response: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await reader.cancel().catch(() => {});
  }
}
