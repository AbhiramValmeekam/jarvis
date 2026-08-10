/**
 * The packaged app's icon is generated, so the container format is code and code
 * gets a test.
 *
 * What is worth asserting is not that the orb looks right — nothing here can see
 * it — but that the bytes are a *valid ICO*: Windows reads the directory to find
 * each image, so an offset that is off by the header length produces a file that
 * opens fine in a viewer that guesses and shows nothing in Explorer. The reader
 * below is deliberately written from the format description rather than from the
 * encoder, so the two have to agree about something real.
 */
import { describe, it, expect } from "vitest";
import { encodeIco, buildAppIcon, ICO_SIZES } from "../scripts/make-icon.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Entry {
  width: number;
  height: number;
  bytes: number;
  offset: number;
  payload: Buffer;
}

/** Parse an ICO the way the shell does: header, directory, then follow offsets. */
function readIco(buf: Buffer): Entry[] {
  expect(buf.readUInt16LE(0)).toBe(0); // reserved
  expect(buf.readUInt16LE(2)).toBe(1); // icon, not cursor
  const count = buf.readUInt16LE(4);

  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const bytes = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    entries.push({
      // 0 in the directory means 256; the field is a single byte.
      width: buf[at] === 0 ? 256 : buf[at]!,
      height: buf[at + 1] === 0 ? 256 : buf[at + 1]!,
      bytes,
      offset,
      payload: buf.subarray(offset, offset + bytes),
    });
  }
  return entries;
}

describe("the packaged app icon", () => {
  const ico = buildAppIcon();
  const entries = readIco(ico);

  it("declares one entry per size, including the 256 electron-builder requires", () => {
    expect(entries.map((e) => e.width)).toEqual([...ICO_SIZES]);
    expect(entries.map((e) => e.height)).toEqual([...ICO_SIZES]);
    expect(entries.some((e) => e.width === 256)).toBe(true);
  });

  it("points every entry at a real PNG", () => {
    for (const e of entries) {
      expect(e.payload.subarray(0, 8)).toEqual(PNG_MAGIC);
      // The PNG's own IHDR must agree with what the directory advertises — a
      // directory that lies about a size is how an icon renders as a smear.
      expect(e.payload.readUInt32BE(16)).toBe(e.width);
      expect(e.payload.readUInt32BE(20)).toBe(e.height);
    }
  });

  it("lays the payloads out with no gap and no overlap", () => {
    let expected = 6 + entries.length * 16;
    for (const e of entries) {
      expect(e.offset).toBe(expected);
      expected += e.bytes;
    }
    // And the file ends exactly where the last image does: trailing bytes would
    // mean the encoder wrote something no directory entry accounts for.
    expect(ico.length).toBe(expected);
  });
});

describe("encodeIco refuses what it cannot express", () => {
  it("rejects mismatched images and sizes", () => {
    expect(() => encodeIco([Buffer.alloc(1)], [16, 32])).toThrow(/1 images for 2 sizes/);
  });

  it("rejects an empty icon", () => {
    expect(() => encodeIco([], [])).toThrow(/at least one image/);
  });

  it("rejects a size that does not fit an entry", () => {
    // 512 would wrap to 0 in the one-byte field and be read back as 256 — a
    // silently wrong icon is worse than a failed build.
    expect(() => encodeIco([Buffer.alloc(1)], [512])).toThrow(/does not fit/);
  });
});
