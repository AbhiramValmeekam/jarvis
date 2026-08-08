/**
 * Live Hermes probe — proves Jarvis -> Hermes -> streamed response end to end.
 *
 * This performs a REAL agent turn against the installed Hermes. It is not a
 * mock. Run: npm run probe:hermes
 */
import { HermesAdapter } from "../src/hermes/hermes-adapter.js";

const PROMPT =
  process.argv.slice(2).join(" ") ||
  "Reply with exactly: JARVIS_LINK_OK — then stop. Do not use any tools.";

async function main(): Promise<void> {
  const t0 = Date.now();
  const logs: string[] = [];

  const hermes = new HermesAdapter({
    cwd: process.cwd(),
    onLog: (line) => {
      logs.push(line);
      if (/error|traceback|exception/i.test(line)) {
        console.error("  [hermes:stderr]", line);
      }
    },
    onPermissionRequest: (req) => {
      console.log("  [permission] requested:", JSON.stringify(req.toolCall));
      return "deny";
    },
  });

  hermes.on("state", (s) => console.log(`  [state] ${s}`));

  console.log("→ starting `hermes acp` ...");
  const health = await hermes.start();
  const tReady = Date.now();
  console.log(
    `✓ handshake OK in ${tReady - t0}ms:`,
    JSON.stringify({
      agent: health.agentName,
      version: health.agentVersion,
      protocol: health.protocolVersion,
      pid: health.pid,
    }),
  );

  console.log("→ session/new ...");
  const sessionId = await hermes.createSession();
  console.log(`✓ session: ${sessionId}`);

  console.log(`→ prompt: ${PROMPT}`);
  let firstChunkAt: number | null = null;
  let text = "";
  const tPrompt = Date.now();

  const stopReason = await hermes.streamMessage(sessionId, PROMPT, (e) => {
    switch (e.kind) {
      case "text":
        if (firstChunkAt === null) {
          firstChunkAt = Date.now();
          console.log(`  [first token] +${firstChunkAt - tPrompt}ms`);
        }
        text += e.text;
        process.stdout.write(e.text);
        break;
      case "thought":
        break;
      case "tool_call":
        console.log(`\n  [tool] ${e.title}`);
        break;
      default:
        break;
    }
  });

  const tEnd = Date.now();
  console.log("\n---");
  console.log(`stopReason      : ${stopReason}`);
  console.log(`reply chars     : ${text.length}`);
  console.log(`handshake       : ${tReady - t0}ms`);
  console.log(
    `first token     : ${firstChunkAt ? firstChunkAt - tPrompt : -1}ms`,
  );
  console.log(`total turn      : ${tEnd - tPrompt}ms`);
  console.log(`stderr lines    : ${logs.length}`);

  await hermes.stop();
  console.log("✓ stopped cleanly");

  if (!text.trim()) {
    console.error("✗ FAIL: no text streamed back from Hermes");
    process.exit(1);
  }
  console.log("✓ PASS: Jarvis -> Hermes -> streamed response works");
}

main().catch((err) => {
  console.error("✗ probe failed:", err);
  process.exit(1);
});
