/**
 * Generate `build/icon.ico` for the packaged app.
 *
 *   npx tsx scripts/make-icon.ts
 *
 * Runs as electron-builder's `prepackage` step. The icon is generated from the
 * same `renderIcon` the tray uses, for the same reason the tray icons are
 * generated: a change to the orb shows up in a diff as a changed number rather
 * than as an opaque binary nobody reviews, and there is no asset to fail to load.
 *
 * **The ICO format, in the only two paragraphs that matter here.** A `.ico` is a
 * 6-byte directory header, then one 16-byte entry per image, then the image
 * payloads. Each entry records its own size and byte offset, so the payloads can
 * be anything the shell knows how to decode. Since Vista that includes PNG, and
 * embedding PNG is what electron-builder's own converter emits — so this writes
 * PNG payloads rather than the older BMP-with-AND-mask form, which would need a
 * bottom-up scanline flip and a mask plane to say nothing new.
 *
 * A size byte of 0 means 256: the field is one byte and 256 does not fit, which
 * is the single sharp edge in the format and the reason `256 % 256` appears
 * below rather than a plain width.
 *
 * The generated file is not committed (`build/` is ignored) — it is derived, and
 * checking in a binary that a script produces is how the two drift apart.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderIcon } from "../src/desktop/tray-icons.js";

/**
 * Sizes Windows picks between: tray and title bar at the bottom, the 256 that
 * electron-builder requires and Explorer's extra-large view uses at the top.
 */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

const DIR_HEADER_BYTES = 6;
const DIR_ENTRY_BYTES = 16;

/** Pack PNGs into an ICO container, in the order given. */
export function encodeIco(images: readonly Buffer[], sizes: readonly number[]): Buffer {
  if (images.length !== sizes.length) {
    throw new Error(`${images.length} images for ${sizes.length} sizes`);
  }
  if (images.length === 0) throw new Error("an ICO needs at least one image");
  if (images.length > 0xffff) throw new Error("too many images for one ICO");

  const header = Buffer.alloc(DIR_HEADER_BYTES);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon (2 would be a cursor)
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(DIR_ENTRY_BYTES * images.length);
  let offset = DIR_HEADER_BYTES + directory.length;

  images.forEach((png, i) => {
    const size = sizes[i]!;
    if (size < 1 || size > 256) throw new Error(`${size}px does not fit an ICO entry`);
    const at = i * DIR_ENTRY_BYTES;
    directory[at] = size % 256; // 0 means 256 — see the header note
    directory[at + 1] = size % 256;
    directory[at + 2] = 0; // palette size; 0 for truecolour
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel — RGBA
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images]);
}

/** The app icon: the same orb the tray shows when Jarvis is idle and well. */
export function buildAppIcon(): Buffer {
  const sizes = [...ICO_SIZES];
  return encodeIco(
    sizes.map((s) => renderIcon("idle", s)),
    sizes,
  );
}

function main(): void {
  // Relative to this file, not to `process.cwd()`: a build step that only works
  // when invoked from the right directory is the same class of bug this phase
  // exists to fix.
  const out = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "build", "icon.ico");
  const ico = buildAppIcon();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, ico);
  console.log(`wrote ${out} — ${ICO_SIZES.join(", ")}px, ${ico.length} bytes`);
}

// Importable by the test without writing a file as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
