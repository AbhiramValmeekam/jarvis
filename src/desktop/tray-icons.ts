/**
 * Tray icons, generated rather than shipped as binaries.
 *
 * Windows tray icons are tiny, and every state needs one. Generating them from
 * a few numbers keeps them reviewable in a diff (a change to the "error" colour
 * shows up as a changed hex value, not as an opaque binary blob) and removes an
 * asset-loading failure mode from the always-on path.
 *
 * The encoder writes a minimal PNG by hand: PNG is the format `nativeImage`
 * accepts from a data URL, and Node ships the only hard part (zlib).
 */
import { deflateSync } from "node:zlib";
import type { TrayIcon } from "./tray-model.js";

export const ICON_SIZE = 32;

/** Core colour per state. Chosen to read at 16px against light and dark trays. */
export const ICON_COLORS: Record<TrayIcon, string> = {
  idle: "#38bdf8",
  listening: "#22d3ee",
  busy: "#fbbf24",
  speaking: "#a78bfa",
  muted: "#94a3b8",
  error: "#f87171",
  offline: "#64748b",
};

// --- PNG plumbing ----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode RGBA pixels as a PNG. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 = None.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

// --- drawing ---------------------------------------------------------------

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * Coverage of a circle over one pixel, sampled on a 4×4 grid.
 *
 * Cheap antialiasing. Without it a 32px circle looks visibly jagged in the
 * tray, which reads as "broken icon" more than "small icon".
 */
function coverage(px: number, py: number, cx: number, cy: number, r: number): number {
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const dx = px + (sx + 0.5) / 4 - cx;
      const dy = py + (sy + 0.5) / 4 - cy;
      if (dx * dx + dy * dy <= r * r) hits++;
    }
  }
  return hits / 16;
}

/**
 * Draw the orb: a soft outer ring plus a solid core, so the icon reads as
 * "Jarvis" at a glance and the state reads as colour.
 */
export function renderIcon(icon: TrayIcon, size = ICON_SIZE): Buffer {
  const [r, g, b] = parseHex(ICON_COLORS[icon]);
  const rgba = new Uint8Array(size * size * 4);
  const c = size / 2;
  const outer = size * 0.46;
  const inner = size * 0.26;
  // A hollow ring would vanish at 16px, so "offline" is dimmed instead.
  const ringAlpha = icon === "offline" ? 0.35 : 0.55;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inOuter = coverage(x, y, c, c, outer);
      const inInner = coverage(x, y, c, c, inner);
      const alpha = Math.min(1, inInner + (inOuter - inInner) * ringAlpha);
      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }

  // A muted mic is shown as a slash across the orb, because colour alone is
  // not a safe way to signal "your microphone is off".
  if (icon === "muted") {
    for (let t = 0; t < size * 4; t++) {
      const p = t / (size * 4);
      const x = Math.round(size * 0.18 + p * size * 0.64);
      const y = Math.round(size * 0.18 + p * size * 0.64);
      for (let w = -1; w <= 1; w++) {
        const px = x + w;
        if (px < 0 || px >= size || y < 0 || y >= size) continue;
        const i = (y * size + px) * 4;
        rgba[i] = 0xf8;
        rgba[i + 1] = 0x71;
        rgba[i + 2] = 0x71;
        rgba[i + 3] = 255;
      }
    }
  }

  return encodePng(rgba, size, size);
}

export function iconDataUrl(icon: TrayIcon, size = ICON_SIZE): string {
  return `data:image/png;base64,${renderIcon(icon, size).toString("base64")}`;
}
