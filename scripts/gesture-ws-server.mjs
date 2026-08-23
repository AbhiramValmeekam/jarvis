/**
 * A WebSocket server in enough lines to test one, and no dependency.
 *
 * `scripts/probe-gesture-socket.mjs` needs a real server on a real port, because
 * the half of this feature unit tests cannot reach is the part where Chromium
 * decides whether the renderer's CSP permits the connection at all. `ws` is not a
 * dependency of this project and should not become one for a probe, and Node's
 * built-in WebSocket is a client only — so the handshake and a text frame writer
 * are here.
 *
 * Deliberately minimal and deliberately not reusable in the app: server-to-client
 * text frames under 64 KiB, no masking (servers must not mask), no continuation,
 * no compression, and it reads nothing the client sends. That is the entire
 * vocabulary a hand tracker needs.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Listen on `port` and resolve with a handle that can push JSON to whoever
 * connected. `onConnection` fires per client, which is how the probe waits for
 * the renderer to arrive rather than sleeping and hoping.
 */
export async function startGestureServer({ port = 0, onConnection } = {}) {
  const sockets = new Set();
  const http = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("websocket only");
  });

  http.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) return socket.destroy();
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("error", () => void sockets.delete(socket));
    socket.on("close", () => void sockets.delete(socket));
    sockets.add(socket);
    onConnection?.(socket);
  });

  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", resolve);
  });

  return {
    port: http.address().port,
    get clients() {
      return sockets.size;
    },
    /** Push one JSON payload to every connected client. */
    send(payload) {
      const frame = textFrame(typeof payload === "string" ? payload : JSON.stringify(payload));
      for (const socket of sockets) socket.write(frame);
    },
    /** Drop the connections without closing the port, to test the handback. */
    dropClients() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    async close() {
      this.dropClients();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

/** One unmasked text frame. Two length encodings, which covers every payload here. */
function textFrame(text) {
  const body = Buffer.from(text, "utf8");
  if (body.length > 0xffff) throw new Error("frame too large for this test server");
  const header =
    body.length < 126
      ? Buffer.from([0x81, body.length])
      : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([header, body]);
}
