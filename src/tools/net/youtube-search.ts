/**
 * Which video a song title means, decided without an API key.
 *
 * `media.play` exists so that "play sorry by justin bieber on youtube" costs one
 * call to the shell instead of an agent turn. That leaves one question the local
 * layer cannot answer from a table: *which* video. This module answers it the
 * cheapest honest way — YouTube's own search page, read as data.
 *
 * Three properties it is responsible for.
 *
 * **No credential, no account, no third party.** One `GET` to `www.youtube.com`
 * for a page any browser would fetch. Nothing is signed up for, nothing is
 * stored, and the query is the words the user said and nothing else.
 *
 * **The page is data.** The HTML is scanned for an id-shaped substring and
 * discarded. Nothing in it is executed, no text from it reaches a shell, and the
 * one value that survives is eleven characters matching `[A-Za-z0-9_-]` — the
 * executor re-checks that before it goes anywhere near a URL, because a page on
 * the internet is exactly where a crafted value would come from.
 *
 * **Silence is an answer.** Every failure — offline, a timeout, a redirect to a
 * consent wall, a layout change that moves the id — returns `null`, and the
 * caller opens the search page instead. A local intent that reaches the network
 * must degrade to something that works, or it undoes the reason the local layer
 * exists (§4 on not pretending, and Phase 4's rule that these commands work with
 * networking off).
 */
import { webRequest } from "./web-client.js";
import { YOUTUBE_SEARCH_PREFIX, youtubeSearchUrl } from "../../local-intents/intent-model.js";

/** A single result: YouTube's id, and what the page called it. */
export interface YouTubeHit {
  /** Eleven characters of `[A-Za-z0-9_-]`. Verified before it is returned. */
  readonly id: string;
  /** The result's own title, when it could be read. Used only for the reply. */
  readonly title?: string;
  /** `watch?v=<id>`, for a caller that wants the destination rather than the id. */
  readonly url: string;
}

export interface YouTubeLookupOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Injected by tests, so no unit test reaches the internet. */
  readonly fetchImpl?: typeof fetch;
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly log?: (line: string) => void;
}

/**
 * Four seconds, because this sits in front of a user waiting for music.
 *
 * The page is ~1.3 MB and answers in about a second on a working connection, so
 * this is roughly four times the observed cost — long enough to survive a slow
 * moment, short enough that giving up and opening the search page still feels
 * like a response to what was asked rather than a stall.
 */
const LOOKUP_TIMEOUT_MS = 4_000;

/**
 * 2 MiB, which is a deliberate departure from `DEFAULT_MAX_BYTES`.
 *
 * Measured rather than guessed: the results page is 1.24–1.28 MB and the first
 * result's id sits around byte 743,000 — well past the 512 KiB default, which
 * would truncate the body to a prefix containing no id at all and make this
 * function return `null` every time while looking like it worked.
 */
const LOOKUP_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The standard search-result item.
 *
 * `videoRenderer` is the object YouTube wraps an ordinary video result in, and
 * its `videoId` is the first key inside it. Matching the wrapper rather than the
 * first `videoId` anywhere is what keeps a promoted shelf, a channel preview or a
 * Shorts reel from being mistaken for the top result.
 */
const RENDERER = /"videoRenderer":\s*\{\s*"videoId":\s*"([A-Za-z0-9_-]{11})"/;

/** The same id, wherever it appears. Only consulted when the wrapper is absent. */
const ANY_VIDEO_ID = /"videoId":\s*"([A-Za-z0-9_-]{11})"/;

/**
 * The title that follows the id inside the same renderer object.
 *
 * Bounded on both sides on purpose: searched only in the window after the id, and
 * capped, so a page that never closes the object cannot turn this into a scan of
 * the whole megabyte. The body is JSON-escaped text, so it is decoded by handing
 * it back to `JSON.parse` rather than by unescaping it here.
 */
const TITLE = /"title":\s*\{\s*"runs":\s*\[\s*\{\s*"text":\s*"((?:[^"\\]|\\.){1,300})"/;

/** How far past the id to look for its title. */
const TITLE_WINDOW = 4_000;

/**
 * Pull the first video out of a search page's HTML.
 *
 * Pure, exported, and tested against a captured page: the parsing is the part
 * most likely to rot when YouTube changes its markup, and a test that needs the
 * network to notice is a test that gets deleted.
 */
export function firstVideoFromSearchHtml(html: string): { id: string; title?: string } | null {
  const m = RENDERER.exec(html) ?? ANY_VIDEO_ID.exec(html);
  const id = m?.[1];
  if (!id) return null;
  const title = titleNear(html, (m?.index ?? 0) + (m?.[0].length ?? 0));
  return title === null ? { id } : { id, title };
}

/** Decode the result's own title, or `null` when the page did not give one. */
function titleNear(html: string, from: number): string | null {
  const window = html.slice(from, from + TITLE_WINDOW);
  const raw = TITLE.exec(window)?.[1];
  if (!raw) return null;
  try {
    // The capture is the inside of a JSON string, so this is a decode and not an
    // evaluation: `JSON.parse` on a quoted scalar cannot produce anything but a
    // string, and a malformed escape throws rather than half-decoding.
    const decoded: unknown = JSON.parse(`"${raw}"`);
    return typeof decoded === "string" && decoded.trim() ? decoded.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Ask YouTube which video a title means.
 *
 * Returns `null` for every unhappy path, and says why in the log rather than in
 * the return value: the caller's decision is the same whatever went wrong — open
 * the search page — and the reason belongs where someone debugging can find it.
 *
 * The guard, the redirect re-check and the size ceiling all come from
 * `webRequest`, so this adds no new way for the runtime to reach the network.
 */
export async function findYouTubeVideo(
  query: string,
  opts: YouTubeLookupOptions = {},
): Promise<YouTubeHit | null> {
  const terms = query.trim();
  if (!terms) return null;

  const result = await webRequest({
    url: youtubeSearchUrl(terms),
    timeoutMs: opts.timeoutMs ?? LOOKUP_TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? LOOKUP_MAX_BYTES,
    // English, so the title read back is the one the user will see, and a
    // language negotiation cannot redirect this into a consent flow.
    headers: { "accept-language": "en-US,en;q=0.9" },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.resolve ? { resolve: opts.resolve } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });

  if (!result.ok) {
    opts.log?.(`youtube lookup ${result.refused ? "refused" : "failed"}: ${result.reason}`);
    return null;
  }
  // A search that answered from somewhere other than YouTube is not an answer
  // about YouTube. Cheap to check, and the alternative is trusting a redirect.
  if (!result.finalUrl.startsWith(YOUTUBE_SEARCH_PREFIX)) {
    opts.log?.(`youtube lookup landed elsewhere: ${result.finalUrl}`);
    return null;
  }
  const hit = firstVideoFromSearchHtml(result.text);
  if (!hit) {
    opts.log?.(
      `youtube lookup found no video for "${terms}" (${result.bytes} bytes${result.truncated ? ", truncated" : ""})`,
    );
    return null;
  }
  return {
    id: hit.id,
    ...(hit.title === undefined ? {} : { title: hit.title }),
    url: `https://www.youtube.com/watch?v=${hit.id}`,
  };
}
