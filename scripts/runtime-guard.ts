/**
 * "Is a real Jarvis running right now?" — asked properly.
 *
 * Four probes need this. `start()` publishes the shared runtime token and
 * `stop()` revokes it, so a probe that runs beside a live Jarvis would revoke a
 * token that instance still depends on and lock its next HUD out. Refusing is
 * right.
 *
 * What was wrong was the test. Each probe asked `existsSync(tokenFilePath())`,
 * and a token file is not a running Jarvis — it is a file the last run left
 * behind. Anything that ends without `stop()` (a crash, a Ctrl-C, a probe killed
 * on a timeout) leaves one, and from then on every probe refuses to start with a
 * message telling you to quit a Jarvis that is not running. That happened here:
 * the acceptance harness would not run at all, against a machine with no Electron
 * and no Node process alive and no `jarvis` pipe in `\\.\pipe\`.
 *
 * A live runtime is one that is **listening**, so that is what this asks. The
 * token is only the hint that makes it worth asking.
 *
 * Note it does not delete the stale token, and does not need to: the runtime
 * publishes its own on `start()`. Nothing here removes a file that a live
 * instance might turn out to own.
 */
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { defaultPipeName } from "../src/ipc/contract.js";
import { tokenFilePath } from "../src/ipc/token.js";

/**
 * True when something accepts a connection on `pipeName`.
 *
 * Deliberately stops at the connection: it does not send `hello`. A pipe that
 * accepts and then rejects our token is still a live runtime — one belonging to
 * an instance whose token we do not have — and that is the case where taking
 * over would do the most damage.
 */
export function pipeIsListening(pipeName = defaultPipeName(), timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (live: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(live);
    };
    const socket = connect(pipeName);
    socket.once("connect", () => finish(true));
    // ENOENT ("all pipe instances are busy" is EBUSY and means live, but Node
    // reports it as an error too; treating busy as "not live" would be wrong, so
    // read the code rather than the fact of failure).
    socket.once("error", (err: NodeJS.ErrnoException) => finish(err.code === "EBUSY"));
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

/**
 * Exit with a message when a real Jarvis is listening. Returns normally — with a
 * note — when the token is merely stale.
 */
export async function refuseIfRuntimeLive(): Promise<void> {
  if (!existsSync(tokenFilePath())) return;
  const pipe = defaultPipeName();
  if (await pipeIsListening(pipe)) {
    console.error(
      `A Jarvis runtime is running and listening on ${pipe}.\n` +
        "Quit it first: this probe would revoke the token at\n" +
        `${tokenFilePath()} on exit, and that instance's next HUD could not\n` +
        "attach until the runtime was restarted.",
    );
    process.exit(1);
  }
  console.log(
    `(a runtime token is present at ${tokenFilePath()} but nothing is listening\n` +
      ` on ${pipe} — treating it as left over from an earlier run)\n`,
  );
}
