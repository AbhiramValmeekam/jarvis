/**
 * Deciding which video a song title means.
 *
 * Two things are worth testing here and they are different in kind. The parsing is
 * fragile by nature — it reads someone else's markup — so it is tested against the
 * shape a real results page has, captured from `www.youtube.com` on 2026-08-23:
 * a `videoRenderer` wrapper whose first key is `videoId`, with the title a little
 * way after it inside the same object. The lookup around it is tested for what it
 * does when the internet does not cooperate, because that is the path a user
 * actually hits — every failure has to become `null`, so that `media.play` opens
 * the search page instead of a red banner.
 *
 * No test here touches a socket or a resolver. Both are injected.
 */
import { describe, it, expect } from "vitest";
import {
  findYouTubeVideo,
  firstVideoFromSearchHtml,
} from "../src/tools/net/youtube-search.js";
import { youtubeSearchUrl } from "../src/local-intents/intent-model.js";

const PUBLIC = async (): Promise<readonly string[]> => ["142.250.187.14"];

/** One result, shaped as YouTube's own page shapes it. */
function renderer(id: string, title: string): string {
  return `{"videoRenderer":{"videoId":"${id}","thumbnail":{"thumbnails":[{"url":"https://i.ytimg.com/vi/${id}/hq.jpg","width":360,"height":202}]},"title":{"runs":[{"text":"${title}"}],"accessibility":{"accessibilityData":{"label":"${title} by someone"}}},"longBylineText":{"runs":[{"text":"Music"}]}}}`;
}

/** A page: the noise before the results, then the results. */
const page = (...results: string[]): string =>
  `<!DOCTYPE html><html><head><title>x - YouTube</title></head><body><script>var ytInitialData = {"contents":{"twoColumnSearchResultsRenderer":{"primaryContents":{"sectionListRenderer":{"contents":[{"itemSectionRenderer":{"contents":[${results.join(",")}]}}]}}}}};</script></body></html>`;

/** A fetch that answers one body, and records what it was asked. */
function fakeFetch(body: string, init: { status?: number; contentType?: string } = {}) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(body, {
      status: init.status ?? 200,
      headers: { "content-type": init.contentType ?? "text/html; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("reading a results page", () => {
  it("takes the first ordinary video result, with its title", () => {
    const html = page(
      renderer("BerNfXSuvJ0", "Justin Bieber - Sorry (Lyrics)"),
      renderer("aaaaaaaaaaa", "Something else"),
    );
    expect(firstVideoFromSearchHtml(html)).toEqual({
      id: "BerNfXSuvJ0",
      title: "Justin Bieber - Sorry (Lyrics)",
    });
  });

  it("ignores ids that are not a video result before the first one that is", () => {
    // The reason the wrapper is matched rather than the first `videoId` anywhere:
    // a promoted shelf, a channel preview and a Shorts reel all carry a videoId,
    // and any of them can be printed above the results.
    const html = `{"reelItemRenderer":{"videoId":"shortshorts"}},${renderer("BerNfXSuvJ0", "Sorry")}`;
    expect(firstVideoFromSearchHtml(html)?.id).toBe("BerNfXSuvJ0");
  });

  it("falls back to a bare videoId when the page has no renderer at all", () => {
    // Degraded rather than absent: a layout change that drops the wrapper should
    // still play something, since the alternative is a search page the user has
    // to click through.
    expect(firstVideoFromSearchHtml('"videoId":"BerNfXSuvJ0"')).toEqual({ id: "BerNfXSuvJ0" });
  });

  it("decodes the title rather than repeating its escapes", () => {
    const html = renderer("BerNfXSuvJ0", "Sorry \\u0026 Sorry \\\"live\\\"");
    expect(firstVideoFromSearchHtml(html)?.title).toBe('Sorry & Sorry "live"');
  });

  it("returns the id alone when the title cannot be read", () => {
    expect(firstVideoFromSearchHtml('{"videoRenderer":{"videoId":"BerNfXSuvJ0","x":1}}')).toEqual({
      id: "BerNfXSuvJ0",
    });
  });

  it("finds nothing in a page with no video in it", () => {
    for (const html of ["", "<html>no results</html>", '"videoId":"tooshort"']) {
      expect(firstVideoFromSearchHtml(html), html).toBeNull();
    }
  });
});

describe("looking a song up", () => {
  it("asks youtube for exactly the query it was given, and returns the watch url", async () => {
    const { impl, calls } = fakeFetch(page(renderer("BerNfXSuvJ0", "Justin Bieber - Sorry")));
    const hit = await findYouTubeVideo("sorry by justin bieber", {
      fetchImpl: impl,
      resolve: PUBLIC,
    });
    expect(hit).toEqual({
      id: "BerNfXSuvJ0",
      title: "Justin Bieber - Sorry",
      url: "https://www.youtube.com/watch?v=BerNfXSuvJ0",
    });
    expect(calls).toEqual([youtubeSearchUrl("sorry by justin bieber")]);
  });

  it("answers null for every way this can fail, and logs which one", async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    // The page answered, with nothing in it.
    const empty = fakeFetch("<html>nothing here</html>");
    expect(await findYouTubeVideo("x", { fetchImpl: empty.impl, resolve: PUBLIC, log })).toBeNull();

    // The server said no.
    const refused = fakeFetch("nope", { status: 429 });
    expect(
      await findYouTubeVideo("x", { fetchImpl: refused.impl, resolve: PUBLIC, log }),
    ).toBeNull();

    // The socket never opened.
    const dead = (async () => {
      throw new Error("getaddrinfo EAI_AGAIN www.youtube.com");
    }) as unknown as typeof fetch;
    expect(await findYouTubeVideo("x", { fetchImpl: dead, resolve: PUBLIC, log })).toBeNull();

    // Nothing was asked at all.
    expect(await findYouTubeVideo("   ", { fetchImpl: empty.impl, resolve: PUBLIC, log })).toBeNull();

    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).toMatch(/youtube lookup/);
  });

  it("does not trust a body that came from somewhere other than youtube's search", async () => {
    // A redirect onto a consent wall or a login page can still return HTML with
    // an id-shaped string in it. `finalUrl` is what the bytes actually came from.
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (calls.length === 1) {
        return new Response("", { status: 302, headers: { location: "https://www.youtube.com/consent" } });
      }
      return new Response(page(renderer("BerNfXSuvJ0", "Sorry")), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    expect(await findYouTubeVideo("sorry", { fetchImpl: impl, resolve: PUBLIC })).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("reads far enough into the page to find the first result", async () => {
    // Not a style point. The id sits around byte 743,000 of a real results page,
    // so the client's 512 KiB default would truncate the body to a prefix with no
    // id in it — and this function would return null every time while looking
    // like it was working.
    const html = " ".repeat(900_000) + page(renderer("BerNfXSuvJ0", "Sorry"));
    const { impl } = fakeFetch(html);
    const hit = await findYouTubeVideo("sorry", { fetchImpl: impl, resolve: PUBLIC });
    expect(hit?.id).toBe("BerNfXSuvJ0");
  });
});
