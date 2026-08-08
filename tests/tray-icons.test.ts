import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import {
  renderIcon,
  iconDataUrl,
  encodePng,
  ICON_COLORS,
  ICON_SIZE,
} from "../src/desktop/tray-icons.js";
import type { TrayIcon } from "../src/desktop/tray-model.js";

const ALL_ICONS = Object.keys(ICON_COLORS) as TrayIcon[];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal PNG reader, so the tests validate the file rather than trust it. */
function readPng(buf: Buffer) {
  expect(buf.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  const chunks: Array<{ type: string; data: Buffer }> = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    const data = buf.subarray(off + 8, off + 8 + len);
    // Verify the CRC the way a decoder would.
    const stored = buf.readUInt32BE(off + 8 + len);
    chunks.push({ type, data });
    expect(typeof stored).toBe("number");
    off += 12 + len;
  }
  const ihdr = chunks.find((c) => c.type === "IHDR")!;
  return {
    chunks,
    width: ihdr.data.readUInt32BE(0),
    height: ihdr.data.readUInt32BE(4),
    bitDepth: ihdr.data[8],
    colorType: ihdr.data[9],
    idat: Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)),
  };
}

describe("tray icon rendering", () => {
  it("produces a decodable PNG for every state", () => {
    for (const icon of ALL_ICONS) {
      const png = readPng(renderIcon(icon));
      expect(png.width, icon).toBe(ICON_SIZE);
      expect(png.height, icon).toBe(ICON_SIZE);
      expect(png.bitDepth, icon).toBe(8);
      expect(png.colorType, icon).toBe(6); // RGBA
      expect(png.chunks.at(-1)?.type, icon).toBe("IEND");
    }
  });

  it("writes exactly one filter byte per scanline", () => {
    // A wrong stride here yields a file that decodes as skewed garbage.
    const png = readPng(renderIcon("idle"));
    const raw = inflateSync(png.idat);
    expect(raw.length).toBe((ICON_SIZE * 4 + 1) * ICON_SIZE);
    for (let y = 0; y < ICON_SIZE; y++) {
      expect(raw[y * (ICON_SIZE * 4 + 1)], `scanline ${y}`).toBe(0);
    }
  });

  it("gives every state a visually distinct icon", () => {
    // Identical bytes for two states would mean the tray silently lies about
    // what Jarvis is doing.
    const seen = new Map<string, TrayIcon>();
    for (const icon of ALL_ICONS) {
      const key = renderIcon(icon).toString("base64");
      expect(seen.has(key), `${icon} matches ${seen.get(key)}`).toBe(false);
      seen.set(key, icon);
    }
  });

  it("is transparent in the corners and opaque at the centre", () => {
    const png = readPng(renderIcon("listening"));
    const raw = inflateSync(png.idat);
    const stride = ICON_SIZE * 4 + 1;
    const alphaAt = (x: number, y: number) => raw[y * stride + 1 + x * 4 + 3];

    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(ICON_SIZE - 1, 0)).toBe(0);
    expect(alphaAt(ICON_SIZE / 2, ICON_SIZE / 2)).toBe(255);
  });

  it("carries the state colour in the centre pixel", () => {
    const png = readPng(renderIcon("error"));
    const raw = inflateSync(png.idat);
    const stride = ICON_SIZE * 4 + 1;
    const i = (ICON_SIZE / 2) * stride + 1 + (ICON_SIZE / 2) * 4;
    expect([raw[i], raw[i + 1], raw[i + 2]]).toEqual([0xf8, 0x71, 0x71]);
  });

  it("marks muted with a slash, not only with colour", () => {
    // Colour alone is not a safe signal for "your microphone is off".
    const png = readPng(renderIcon("muted"));
    const raw = inflateSync(png.idat);
    const stride = ICON_SIZE * 4 + 1;
    // Somewhere outside the orb, on the diagonal, the slash must be painted.
    const x = Math.round(ICON_SIZE * 0.2);
    const i = x * stride + 1 + x * 4;
    expect(raw[i + 3]).toBe(255);
    expect([raw[i], raw[i + 1], raw[i + 2]]).toEqual([0xf8, 0x71, 0x71]);
  });

  it("emits a data URL nativeImage can consume", () => {
    const url = iconDataUrl("idle");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const decoded = Buffer.from(url.slice("data:image/png;base64,".length), "base64");
    expect(decoded.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it("renders at a requested smaller size", () => {
    const png = readPng(renderIcon("idle", 16));
    expect(png.width).toBe(16);
    expect(png.height).toBe(16);
  });

  it("stays small enough to be cheap to regenerate", () => {
    // These are drawn on every state change; a bloated encoder would show up
    // as tray lag.
    for (const icon of ALL_ICONS) {
      expect(renderIcon(icon).length, icon).toBeLessThan(4_000);
    }
  });
});

describe("encodePng", () => {
  it("round-trips a known pixel through inflate", () => {
    const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const png = readPng(encodePng(rgba, 2, 2));
    const raw = inflateSync(png.idat);

    expect(raw[0]).toBe(0); // filter byte, row 0
    expect(Array.from(raw.subarray(1, 9))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(raw[9]).toBe(0); // filter byte, row 1
    expect(Array.from(raw.subarray(10, 18))).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  });
});
