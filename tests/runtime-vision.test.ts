/**
 * The window's half of "fix this", over a real pipe.
 *
 * `vision-objective.test.ts` proves the refusals against a stubbed reader and a
 * stubbed gate. What it cannot prove is the thing this door is for: that a *runtime*
 * asked to look at the screen spends nothing it does not have to, answers a refusal as
 * an answer rather than as a failed request, and tells every attached window what it
 * decided — including the windows that did not ask.
 *
 * So the model here is forced offline. That is not a convenience: it makes the check
 * that matters checkable. With nothing configured that could read a picture, a runtime
 * that took a screenshot anyway would have photographed the desktop to produce a
 * refusal it already knew it was going to give, and the consent prompt is the most
 * expensive thing in this path. The proposal side of the door — a real capture through
 * the real consent gate, a real HTTP model, a real objective started from what came
 * back — is `scripts/probe-vision.ts`, because none of that is honest against a fake.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
// Side effect: redirects the runtime token and the config file out of the real profile.
import "./helpers/isolate-state.js";
import { JarvisRuntime } from "../src/runtime/jarvis-runtime.js";
import { PipeClient } from "../src/ipc/pipe-client.js";
import { readToken } from "../src/ipc/token.js";
import { FakeAdapter } from "./helpers/fake-adapter.js";
import { ENV_KEYS } from "../src/llm/factory.js";
import type { ServerEvent, VisionProposalView } from "../src/ipc/contract.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let counter = 0;
function uniquePipe(): string {
  counter++;
  const name = `jarvis-vision-${process.pid}-${counter}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `/tmp/${name}.sock`;
}

/** A PNG's signature and nothing else: this capture is never decoded or sent. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("looking at the screen, asked for by a window", () => {
  let runtime: JarvisRuntime | null = null;
  const clients: PipeClient[] = [];
  /** How many times anything asked the display for a picture. Zero is the point. */
  let captures = 0;
  let pipeName = "";
  let previousProvider: string | undefined;

  beforeEach(async () => {
    FakeAdapter.reset();
    captures = 0;
    // Config is silent in the isolated profile, so this decides — which is how a
    // test picks a provider without editing the file a person owns.
    previousProvider = process.env[ENV_KEYS.provider];
    process.env[ENV_KEYS.provider] = "offline";
    pipeName = uniquePipe();
    runtime = new JarvisRuntime({
      pipeName,
      lazyHermes: true,
      voice: { enabled: false },
      createAdapter: () => new FakeAdapter(),
      missionDir: mkdtempSync(join(tmpdir(), "jarvis-vision-")),
      captureScreen: async () => {
        captures++;
        return PNG;
      },
    });
    await runtime.start();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close();
    if (runtime) await runtime.stop();
    runtime = null;
    if (previousProvider === undefined) delete process.env[ENV_KEYS.provider];
    else process.env[ENV_KEYS.provider] = previousProvider;
  });

  async function ui(name = "vision-ui"): Promise<PipeClient> {
    const c = new PipeClient({
      pipeName,
      token: readToken() ?? undefined,
      clientName: name,
      autoReconnect: false,
      requestTimeoutMs: 10_000,
    });
    await c.connectAndAuthenticate();
    clients.push(c);
    return c;
  }

  const look = (c: PipeClient, ask?: string): Promise<VisionProposalView> =>
    c.request({
      type: "propose_from_screen",
      ...(ask === undefined ? {} : { ask }),
    }) as Promise<VisionProposalView>;

  it("answers a refusal as an answer, not as a failed request", async () => {
    // §4's shape: the runtime was asked a question and it answered it. An error frame
    // here would make a window draw "the request failed" for a request that worked.
    const answer = await look(await ui(), "fix this");
    expect(answer).toMatchObject({ kind: "refused", source: "window", refusal: "no-model" });
    expect(answer.kind === "refused" && answer.speech).toContain("no model");
    expect(typeof answer.at).toBe("number");
  });

  it("spends no screenshot on a refusal it could make without one", async () => {
    // The ordering `acceptsImages` exists for, asserted where it is expensive: a
    // capture costs a consent prompt, and this refusal needed no picture to make.
    const c = await ui();
    await look(c, "fix this");
    expect(captures).toBe(0);
  });

  it("keeps the maintainer's note off the wire and out of the window", async () => {
    const answer = await look(await ui());
    expect(answer).not.toHaveProperty("note");
    // And nothing that would let a page draw a refusal as though it were an offer.
    expect(answer).not.toHaveProperty("objective");
    expect(answer).not.toHaveProperty("observed");
  });

  it("tells every attached window what it decided, including the one that did not ask", async () => {
    // A spoken "fix this" is one sentence said once. A window that missed it has no
    // way to ask again, which is why this is a broadcast and not just a reply.
    const asker = await ui("asker");
    const watcher = await ui("watcher");
    const seen: VisionProposalView[] = [];
    watcher.on("event", (e: ServerEvent) => {
      if (e.type === "vision_proposal") seen.push(e.proposal);
    });
    const answer = await look(asker, "fix this");
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(1);
    expect({ ...seen[0], at: answer.at }).toEqual(answer);
  });

  it("refuses an ask that is not a string, before anything looks at anything", async () => {
    // The renderer sends this, and a renderer displays model output: a frame whose
    // shape was never checked is the one door into this path that nobody clicked.
    const c = await ui();
    await expect(
      c.request({ type: "propose_from_screen", ask: 5 } as never),
    ).rejects.toThrow(/string/i);
    expect(captures).toBe(0);
  });

  it("costs an idle runtime nothing until a person asks", async () => {
    // §7, and the reason this is a request rather than a watcher: there is no timer
    // behind it. A runtime nobody asked has taken no pictures and made no proposals.
    await ui();
    await new Promise((r) => setTimeout(r, 100));
    expect(captures).toBe(0);
  });
});
