/**
 * A `fetch` that answers from a script instead of from a network.
 *
 * Every provider takes `fetchImpl`, so the whole model layer can be tested without a
 * server, a key, or a socket. Replies are replayed in order and the last one repeats,
 * which is what a retry test wants; responses are cloned on the way out because a
 * body can only be read once and a retry reads the same scripted reply again.
 */
export interface FakeCall {
  readonly url: string;
  readonly init: RequestInit;
  /** The request body, parsed. Null when it was not JSON. */
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

export interface FakeFetch {
  readonly impl: typeof fetch;
  readonly calls: FakeCall[];
  count(): number;
  last(): FakeCall;
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

export function fakeFetch(replies: readonly (Response | Error)[]): FakeFetch {
  const calls: FakeCall[] = [];
  let i = 0;

  const impl = (async (url: string | URL, init?: RequestInit) => {
    const raw = init?.body;
    let body: unknown = null;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }
    calls.push({
      url: String(url),
      init: init ?? {},
      body,
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    });

    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    if (reply === undefined) throw new Error("fakeFetch was given no replies");
    if (reply instanceof Error) throw reply;
    return reply.clone();
  }) as unknown as typeof fetch;

  return {
    impl,
    calls,
    count: () => i,
    last: () => {
      const call = calls[calls.length - 1];
      if (call === undefined) throw new Error("fakeFetch was never called");
      return call;
    },
  };
}
