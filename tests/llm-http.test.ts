/**
 * `postJson`, which is the whole HTTP client for the model layer.
 *
 * The four things it exists to get right are the four things asserted here: a
 * retryable classification taken from the status and not from anyone's prose, a
 * `retry-after` that is honoured but bounded, a 200 whose body is not JSON treated as
 * a failure rather than as an empty answer, and redaction on every path out. Every
 * test injects `fetchImpl`, so nothing in this file touches a network.
 */
import { describe, it, expect } from "vitest";
import { fakeFetch, jsonResponse as json } from "./helpers/fake-fetch.js";
import { postJson } from "../src/llm/http.js";
import { LLMUnavailableError } from "../src/llm/provider.js";

const base = { url: "https://example.test/v1/messages", headers: { "x-api-key": "k" }, secrets: [], timeoutMs: 5_000 };

describe("postJson", () => {
  it("returns the parsed body and sends one JSON POST", async () => {
    const f = fakeFetch([json(200, { ok: true })]);

    const out = await postJson({ ...base, body: { model: "m" }, fetchImpl: f.impl });

    expect(out).toEqual({ ok: true });
    expect(f.count()).toBe(1);
    const call = f.calls[0]!;
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBe('{"model":"m"}');
    expect(call.init.headers).toMatchObject({ "x-api-key": "k", "content-type": "application/json" });
  });

  it("gives up immediately on a status that will fail identically forever", async () => {
    const f = fakeFetch([json(400, { error: { type: "invalid_request_error", message: "max_tokens is required" } })]);

    await expect(postJson({ ...base, body: {}, fetchImpl: f.impl })).rejects.toMatchObject({
      retryable: false,
      status: 400,
      message: "the model refused the request: max_tokens is required",
    });
    // A second attempt at a 400 is a second identical failure and a second bill.
    expect(f.count()).toBe(1);
  });

  it("retries a 429 once and then reports it as retryable", async () => {
    const f = fakeFetch([json(429, { error: "slow down" }, { "retry-after": "0" })]);
    const log: string[] = [];

    const err = await postJson({ ...base, body: {}, fetchImpl: f.impl, log: (l) => log.push(l) }).catch((e) => e);

    expect(err).toBeInstanceOf(LLMUnavailableError);
    expect(err).toMatchObject({ retryable: true, status: 429 });
    // `{error: "…"}` is the other shape a compatible server uses for its message.
    expect((err as Error).message).toContain("slow down");
    expect(f.count()).toBe(2);
    expect(log.join("\n")).toContain("retrying once");
  });

  it("abandons a retry-after longer than the call has, rather than sleeping through it", async () => {
    const f = fakeFetch([json(503, { error: { message: "capacity" } }, { "retry-after": "300" })]);
    const log: string[] = [];

    await expect(postJson({ ...base, body: {}, fetchImpl: f.impl, log: (l) => log.push(l) })).rejects.toMatchObject({
      retryable: true,
      status: 503,
    });
    expect(f.count()).toBe(1);
    expect(log.join("\n")).toContain("300s wait");
  });

  it("honours attempts: 1 as no retrying at all", async () => {
    const f = fakeFetch([json(500, { error: { message: "boom" } }, { "retry-after": "0" })]);

    await expect(postJson({ ...base, body: {}, attempts: 1, fetchImpl: f.impl })).rejects.toBeInstanceOf(
      LLMUnavailableError,
    );
    expect(f.count()).toBe(1);
  });

  it("retries a connection failure and then says it could not reach the model", async () => {
    const f = fakeFetch([new Error("ECONNREFUSED 127.0.0.1:8080")]);

    await expect(postJson({ ...base, body: {}, fetchImpl: f.impl })).rejects.toMatchObject({
      retryable: true,
      message: "could not reach the model: ECONNREFUSED 127.0.0.1:8080",
    });
    expect(f.count()).toBe(2);
  });

  it("treats a 200 that is not JSON as a failure, not as an empty answer", async () => {
    // A proxy's HTML login page arrives with a 200 and would otherwise parse to
    // nothing and be handed to the planner as a model that returned no steps.
    const f = fakeFetch([new Response("<html>sign in</html>", { status: 200 })]);

    await expect(postJson({ ...base, body: {}, fetchImpl: f.impl })).rejects.toMatchObject({
      retryable: false,
      message: "the model returned 200 with a body that is not JSON",
    });
  });

  it("scrubs a key the server echoed back at us", async () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuv";
    const f = fakeFetch([json(401, { error: { message: `invalid key ${key}` } })]);

    const err = (await postJson({
      ...base,
      headers: { "x-api-key": key },
      body: {},
      secrets: [key],
      fetchImpl: f.impl,
    }).catch((e: unknown) => e)) as Error;

    // This is the last gate before a key could reach the log file or the wire.
    expect(err.message).not.toContain(key);
    expect(err.message).toContain("[redacted]");
  });

  it("falls back to the status when the error body is not a message", async () => {
    const f = fakeFetch([new Response("Bad Gateway", { status: 502, headers: { "retry-after": "0" } })]);

    const err = (await postJson({ ...base, body: {}, attempts: 1, fetchImpl: f.impl }).catch(
      (e: unknown) => e,
    )) as Error;

    expect(err.message).toBe("the model refused the request: HTTP 502");
  });
});
