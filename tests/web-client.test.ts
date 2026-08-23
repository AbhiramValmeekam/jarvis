/**
 * The guard in front of the internet.
 *
 * Giving an autonomous loop HTTP is giving it an SSRF primitive, so these tests are
 * written from the attacker's side: the interesting cases are a public-looking name
 * that resolves inside the network, a redirect that lands on the metadata endpoint,
 * and a body that never stops arriving. Nothing here touches a real socket or a real
 * resolver — both are injected, which is the only way the DNS cases can be asserted
 * at all.
 */
import { describe, it, expect } from "vitest";
import {
  checkUrl,
  isPrivateAddress,
  webRequest,
  DEFAULT_MAX_BYTES,
} from "../src/tools/net/web-client.js";

/** Answers for a name, so no test needs DNS. */
const resolves = (map: Readonly<Record<string, readonly string[]>>) =>
  async (host: string): Promise<readonly string[]> => {
    const answer = map[host];
    if (!answer) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    return answer;
  };

const PUBLIC = resolves({ "example.com": ["93.184.216.34"], "api.example.com": ["93.184.216.34"] });

interface Reply {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** A fetch that answers from a table, and records what it was asked for. */
function fakeFetch(replies: Readonly<Record<string, Reply>> | Reply) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = "status" in replies || "body" in replies || "headers" in replies
      ? (replies as Reply)
      : (replies as Record<string, Reply>)[url] ?? { status: 404, body: "no" };
    return new Response(reply.body ?? "", {
      status: reply.status ?? 200,
      headers: { "content-type": "text/plain", ...(reply.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "ff02::1",
  ])("refuses %s", (addr) => {
    expect(isPrivateAddress(addr)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "192.169.1.1", "2606:2800:220:1::1"])(
    "allows %s",
    (addr) => {
      expect(isPrivateAddress(addr)).toBe(false);
    },
  );

  it("unwraps an IPv4-mapped IPv6 address, in both notations", () => {
    // The same address wearing a different hat. Treating the two differently is
    // exactly how a check like this gets walked past.
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:a00:1")).toBe(true);
    expect(isPrivateAddress("[::ffff:169.254.169.254]")).toBe(true);
    expect(isPrivateAddress("::ffff:5db8:d822")).toBe(false); // 93.184.216.34
  });

  it("ignores a zone index and brackets", () => {
    expect(isPrivateAddress("[fe80::1%eth0]")).toBe(true);
  });
});

describe("checkUrl", () => {
  it("allows an ordinary public page", async () => {
    const verdict = await checkUrl("https://example.com/docs", [], PUBLIC);
    expect(verdict.ok).toBe(true);
  });

  it.each([
    ["file:///C:/Users/me/.ssh/id_ed25519", /only make http/i],
    ["data:text/html,<b>hi</b>", /only make http/i],
    ["ftp://example.com/x", /only make http/i],
    ["not a url", /not a URL/i],
  ])("refuses %s", async (url, why) => {
    const verdict = await checkUrl(url, [], PUBLIC);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(why);
  });

  it("refuses a URL carrying a username or password", async () => {
    const verdict = await checkUrl("https://user:pass@example.com/", [], PUBLIC);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/username or password/i);
  });

  it("refuses the metadata endpoint by literal address", async () => {
    const verdict = await checkUrl("http://169.254.169.254/latest/meta-data/", [], PUBLIC);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/private or loopback/i);
  });

  it("refuses a public name that resolves inside the network", async () => {
    // The DNS half of an SSRF, and the reason `resolve` is injectable.
    const verdict = await checkUrl(
      "https://internal.example.com/",
      [],
      resolves({ "internal.example.com": ["10.0.0.5"] }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/resolves to 10\.0\.0\.5/);
  });

  it("refuses a name that resolves to a private address among public ones", async () => {
    const verdict = await checkUrl(
      "https://mixed.example.com/",
      [],
      resolves({ "mixed.example.com": ["93.184.216.34", "192.168.0.9"] }),
    );
    expect(verdict.ok).toBe(false);
  });

  it.each(["localhost", "wiki.internal", "printer.local", "box.home.arpa", "nas"])(
    "refuses the internal name %s and says how to allow it",
    async (host) => {
      const verdict = await checkUrl(`http://${host}/`, [], PUBLIC);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/webAllowHosts/);
    },
  );

  it.each([22, 3306, 6379, 27017, 9200])("refuses port %i as not a web port", async (port) => {
    const verdict = await checkUrl(`http://example.com:${port}/`, [], PUBLIC);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/not a web port/);
  });

  it("lets an allowed host through, and only the one that was allowed", async () => {
    expect((await checkUrl("http://localhost:3000/api", ["localhost:3000"], PUBLIC)).ok).toBe(true);
    expect((await checkUrl("http://localhost:3001/api", ["localhost:3000"], PUBLIC)).ok).toBe(false);
    expect((await checkUrl("http://127.0.0.1/", ["127.0.0.1"], PUBLIC)).ok).toBe(true);
  });

  it("does not let an allowlist entry open an infrastructure port", async () => {
    // Allowing a host is saying "this machine is fine to talk to", not "send an
    // HTTP request to its database".
    const verdict = await checkUrl("http://localhost:6379/", ["localhost:6379"], PUBLIC);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/not a web port/);
  });

  it("reports a resolver failure as a refusal rather than throwing", async () => {
    const verdict = await checkUrl("https://nope.example.com/", [], PUBLIC);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/could not resolve/i);
  });
});

describe("webRequest", () => {
  const call = (url: string, extra: Partial<Parameters<typeof webRequest>[0]> = {}) => ({
    url,
    timeoutMs: 2_000,
    resolve: PUBLIC,
    ...extra,
  });

  it("returns the body, the status and the chain", async () => {
    const { impl } = fakeFetch({ body: "hello", headers: { "content-type": "text/plain" } });
    const result = await webRequest(call("https://example.com/x", { fetchImpl: impl }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("hello");
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe("https://example.com/x");
    expect(result.chain).toEqual(["https://example.com/x"]);
  });

  it("refuses before it opens a socket", async () => {
    const { impl, calls } = fakeFetch({ body: "should not happen" });
    const result = await webRequest(call("http://169.254.169.254/", { fetchImpl: impl }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refused).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("re-checks every redirect, so a public host cannot hand off to the metadata endpoint", async () => {
    // The whole reason redirects are followed by hand rather than by `fetch`.
    const { impl, calls } = fakeFetch({
      "https://example.com/go": {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      },
    });
    const result = await webRequest(call("https://example.com/go", { fetchImpl: impl }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refused).toBe(true);
      expect(result.reason).toMatch(/private or loopback/i);
    }
    // It asked for the first URL and stopped; the second was never sent.
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/go"]);
  });

  it("follows a redirect that is allowed, and records both URLs as sources", async () => {
    const { impl } = fakeFetch({
      "https://example.com/old": { status: 301, headers: { location: "/new" } },
      "https://example.com/new": { body: "arrived" },
    });
    const result = await webRequest(call("https://example.com/old", { fetchImpl: impl }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("arrived");
    expect(result.finalUrl).toBe("https://example.com/new");
    expect(result.chain).toEqual(["https://example.com/old", "https://example.com/new"]);
  });

  it("gives up on a redirect loop instead of following it forever", async () => {
    const { impl, calls } = fakeFetch({
      "https://example.com/loop": { status: 302, headers: { location: "https://example.com/loop" } },
    });
    const result = await webRequest(call("https://example.com/loop", { fetchImpl: impl }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refused).toBe(false);
      expect(result.reason).toMatch(/too many redirects/i);
    }
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it("treats a 3xx with no destination as a failure of the server, not a refusal", async () => {
    const { impl } = fakeFetch({ "https://example.com/x": { status: 302 } });
    const result = await webRequest(call("https://example.com/x", { fetchImpl: impl }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refused).toBe(false);
      expect(result.reason).toMatch(/no destination/i);
    }
  });

  it("will not be told to send a cookie, an authorization or a host header", async () => {
    const { impl, calls } = fakeFetch({ body: "ok" });
    await webRequest(
      call("https://example.com/x", {
        fetchImpl: impl,
        headers: {
          authorization: "Bearer sk-secret",
          cookie: "session=abc",
          host: "internal.example.com",
          referer: "https://elsewhere.example",
          "x-subscription-token": "keep-me",
          accept: "application/json",
        },
      }),
    );
    const sent = calls[0]?.init.headers as Record<string, string>;
    expect(sent["authorization"]).toBeUndefined();
    expect(sent["cookie"]).toBeUndefined();
    expect(sent["host"]).toBeUndefined();
    expect(sent["referer"]).toBeUndefined();
    // A provider key is a header a caller may set. That is the difference between
    // "Jarvis was asked to spend a credential" and "a plan asked for one".
    expect(sent["x-subscription-token"]).toBe("keep-me");
    expect(sent["accept"]).toBe("application/json");
    expect(sent["user-agent"]).toMatch(/Jarvis/);
  });

  it("drops a header whose value would inject a second header line", async () => {
    const { impl, calls } = fakeFetch({ body: "ok" });
    await webRequest(
      call("https://example.com/x", {
        fetchImpl: impl,
        headers: { "x-note": "fine\r\nauthorization: Bearer sk" },
      }),
    );
    const sent = calls[0]?.init.headers as Record<string, string>;
    expect(sent["x-note"]).toBeUndefined();
  });

  it("refuses a body that is not text, with the type it actually answered", async () => {
    const { impl } = fakeFetch({
      body: " binary",
      headers: { "content-type": "image/png" },
    });
    const result = await webRequest(call("https://example.com/x", { fetchImpl: impl }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refused).toBe(false);
      expect(result.reason).toMatch(/image\/png/);
    }
  });

  it.each(["text/html", "application/json", "text/plain", "application/xhtml+xml", "application/vnd.api+json"])(
    "reads %s",
    async (type) => {
      const { impl } = fakeFetch({ body: "{}", headers: { "content-type": `${type}; charset=utf-8` } });
      const result = await webRequest(call("https://example.com/x", { fetchImpl: impl }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.contentType).toBe(type);
    },
  );

  it("stops reading at the cap and says the body was truncated", async () => {
    const { impl } = fakeFetch({ body: "x".repeat(5_000) });
    const result = await webRequest(
      call("https://example.com/big", { fetchImpl: impl, maxBytes: 1_000 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(1_000);
    expect(result.text.length).toBeLessThanOrEqual(1_000);
  });

  it("sends a body only on POST, and caps it", async () => {
    const { impl, calls } = fakeFetch({ body: "ok" });
    await webRequest(
      call("https://example.com/api", { fetchImpl: impl, method: "GET", body: "ignored" }),
    );
    expect(calls[0]?.init.body).toBeUndefined();

    await webRequest(
      call("https://example.com/api", { fetchImpl: impl, method: "POST", body: "sent" }),
    );
    expect(calls[1]?.init.body).toBe("sent");
  });

  it("reports a network error as a failure that names the host", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await webRequest(call("https://example.com/x", { fetchImpl: impl }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refused).toBe(false);
      expect(result.reason).toMatch(/could not reach example\.com/);
    }
  });

  it("keeps a 404 as an answer rather than an error", async () => {
    const { impl } = fakeFetch({ status: 404, body: "nope" });
    const result = await webRequest(call("https://example.com/missing", { fetchImpl: impl }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe(404);
  });

  it("has a default cap, so a caller that forgets one is still bounded", () => {
    expect(DEFAULT_MAX_BYTES).toBe(512 * 1024);
  });
});
