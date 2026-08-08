/**
 * How the desktop app finds — or starts — the headless runtime.
 *
 * The runtime is a separate process on purpose (ARCHITECTURE.md §4): the UI is
 * a control surface, not the assistant. Two consequences shape this file:
 *
 *   1. Attach before spawning. A runtime is very often already up (autostart,
 *      or a previous UI session), and spawning a second one is pointless — the
 *      runtime refuses anyway, single-instance.
 *   2. Spawn detached. If Electron crashes or is killed, Jarvis must keep
 *      listening. A child that dies with its parent would quietly turn the
 *      always-on assistant into an app.
 */
import { spawn } from "node:child_process";
import type { RuntimeStatus } from "../ipc/contract.js";

/** The bit of PipeClient this module needs — keeps it testable without a pipe. */
export interface RuntimeClientLike {
  connectAndAuthenticate(): Promise<void>;
  request(body: { type: "get_status" }): Promise<unknown>;
  close(): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export interface RuntimeLinkOptions {
  /** Build a fresh client. Called again for each attach attempt. */
  createClient: () => RuntimeClientLike;
  /** Start a detached runtime process. */
  spawnRuntime: () => void;
  /** How long to wait for a freshly spawned runtime to accept us. */
  startupTimeoutMs?: number;
  /** Gap between attach attempts. */
  retryIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface AttachResult {
  client: RuntimeClientLike;
  status: RuntimeStatus;
  /** True when we had to start the runtime ourselves. */
  spawned: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RuntimeLink {
  private readonly opts: Required<Omit<RuntimeLinkOptions, "createClient" | "spawnRuntime">> &
    Pick<RuntimeLinkOptions, "createClient" | "spawnRuntime">;

  constructor(options: RuntimeLinkOptions) {
    this.opts = {
      startupTimeoutMs: 20_000,
      retryIntervalMs: 250,
      sleep: defaultSleep,
      now: () => Date.now(),
      ...options,
    };
  }

  /**
   * Attach to the runtime, starting it if it is not there.
   *
   * Resolves only once the connection is authenticated AND a status has come
   * back, so callers never get a half-open link that looks connected.
   */
  async attach(): Promise<AttachResult> {
    const existing = await this.tryAttach();
    if (existing) return { ...existing, spawned: false };

    this.opts.spawnRuntime();

    const deadline = this.opts.now() + this.opts.startupTimeoutMs;
    let lastError = "runtime did not become reachable";
    while (this.opts.now() < deadline) {
      await this.opts.sleep(this.opts.retryIntervalMs);
      try {
        const attached = await this.tryAttach(true);
        if (attached) return { ...attached, spawned: true };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(
      `could not reach the Jarvis runtime after ${this.opts.startupTimeoutMs}ms: ${lastError}`,
    );
  }

  /** One attach attempt. Returns null when the runtime is simply not there. */
  private async tryAttach(
    rethrow = false,
  ): Promise<{ client: RuntimeClientLike; status: RuntimeStatus } | null> {
    const client = this.opts.createClient();
    try {
      await client.connectAndAuthenticate();
      const status = (await client.request({ type: "get_status" })) as RuntimeStatus;
      return { client, status };
    } catch (err) {
      // Leave nothing half-open behind a failed attempt.
      await client.close().catch(() => {});
      if (rethrow) throw err;
      return null;
    }
  }
}

/**
 * Spawn the runtime so it outlives this process.
 *
 * `detached` + `unref` is the whole point: Electron is the UI's lifetime, not
 * the assistant's. stdio is ignored because a detached child holding pipes to
 * a dead parent is a way to hang on exit; the runtime writes its own log.
 */
export function spawnDetachedRuntime(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  child.unref();
}
