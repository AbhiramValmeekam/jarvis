/**
 * A fake `ChildProcess` for supervisor tests.
 *
 * The voice daemon is a Python process that loads three ML models and opens a
 * microphone. None of that belongs in a unit test: it is slow, it needs
 * hardware, and it cannot be made to crash on demand. What the sidecar actually
 * owns is the *protocol* — spawn, read lines, write commands, notice death,
 * restart within bounds — and all of that is exercisable against a fake.
 *
 * Real-process behaviour is proven separately by scripts/probe-voice.ts, which
 * starts the real daemon and speaks into the real pipeline.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

export class FakeChild extends EventEmitter {
  static instances: FakeChild[] = [];

  readonly stdout = new PassThrough({ encoding: "utf8" });
  readonly stderr = new PassThrough({ encoding: "utf8" });
  /** Everything the sidecar wrote to the daemon's stdin, in order. */
  readonly written: string[] = [];
  readonly stdin: PassThrough & { destroyedByEnd?: boolean };

  readonly cmd: string;
  readonly args: string[];
  readonly cwd: string;

  pid: number | null;
  exitCode: number | null = null;
  killed = false;
  /** Set to make `stdin.write` throw, as a closed pipe does. */
  stdinBroken = false;

  constructor(cmd: string, args: string[], cwd: string) {
    super();
    this.cmd = cmd;
    this.args = args;
    this.cwd = cwd;
    this.pid = 4000 + FakeChild.instances.length;
    FakeChild.instances.push(this);

    const stdin = new PassThrough();
    const realWrite = stdin.write.bind(stdin);
    stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (this.stdinBroken) throw new Error("EPIPE");
      this.written.push(String(chunk));
      return realWrite(chunk as never, ...(rest as []));
    }) as PassThrough["write"];
    this.stdin = stdin;
  }

  static reset(): void {
    FakeChild.instances = [];
  }

  static get latest(): FakeChild {
    const c = FakeChild.instances[FakeChild.instances.length - 1];
    if (!c) throw new Error("no child spawned yet");
    return c;
  }

  /** The commands the sidecar sent, parsed. */
  get commands(): Array<Record<string, unknown>> {
    return this.written
      .join("")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  /** Emit one event line on stdout, as the daemon does. */
  emitEvent(event: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  /** Emit the `ready` frame with sensible defaults. */
  emitReady(over: Record<string, unknown> = {}): void {
    this.emitEvent({
      type: "ready",
      wakeWord: "hey_jarvis",
      device: "Test Mic",
      sttModel: "base.en",
      ttsVoice: "en_US-amy",
      sampleRate: 16000,
      capture: true,
      ...over,
    });
  }

  /** Write raw bytes to stdout — for chunk-boundary tests. */
  writeRaw(text: string): void {
    this.stdout.write(text);
  }

  /** Terminate as a crash (non-zero) or a clean exit. */
  die(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 0;
    this.pid = null;
    this.emit("exit", code, signal);
  }

  kill(): boolean {
    this.killed = true;
    this.die(null, "SIGTERM");
    return true;
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

/** A spawn function that hands out `FakeChild`s. */
export function fakeSpawn(cmd: string, args: string[], cwd: string): ChildProcess {
  return new FakeChild(cmd, args, cwd).asChildProcess();
}

/** Resolve after all pending microtasks and one timer tick. */
export function tick(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll until `pred` holds.
 *
 * Restart backoff is measured in milliseconds here, but Windows timers are
 * coarse (~15 ms), so a fixed sleep is a coin flip: kill the child again before
 * its replacement exists and the second crash lands on a corpse and is never
 * counted. Waiting on the condition makes the test measure the policy rather
 * than the timer.
 */
export async function waitUntil(
  pred: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await tick(2);
  }
}

/** Kill the live daemon and wait for the supervisor to finish reacting. */
export async function crashAndSettle(isFailed: () => boolean): Promise<void> {
  const before = FakeChild.instances.length;
  FakeChild.latest.die(1);
  await waitUntil(() => isFailed() || FakeChild.instances.length > before);
}
