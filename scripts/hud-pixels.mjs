/**
 * What one captured HUD frame looks like, in numbers.
 *
 * Extracted from `probe-gesture.mjs` when `probe-gesture-socket.mjs` needed the
 * same measurements: two probes asking "did the assembly rotate" with two
 * slightly different definitions of rotation would be worse than no second probe
 * at all.
 *
 * `getBitmap` is BGRA. Everything is measured over the core's band only, so the
 * chat below it and the title bar above cannot move any of these.
 *
 * The pose is measured on a coarse grid rather than per pixel, and that was not
 * the first attempt. A per-pixel difference of a few thousand drifting points is
 * enormous no matter what the pose is — every point moving one pixel lights two
 * and darkens two — so two captures of the *same* pose came out 77% apart, which
 * made the metric useless for "did it return to centre". Averaging into cells
 * throws the twinkle away and keeps the thing being asked about: where the light
 * is.
 */

/** The band of the window the core occupies, as fractions of its height. */
export const PANEL_TOP = 0.06;
export const PANEL_BOTTOM = 0.4;
/** Luminance below this is background gradient, not the core. */
export const FLOOR = 26;
/** And above this is the sun itself rather than its field. */
export const SUN = 170;

export const GRID_COLUMNS = 24;
export const GRID_ROWS = 12;

export function measure(image) {
  const { width, height } = image.getSize();
  const data = image.getBitmap();
  const top = Math.round(height * PANEL_TOP);
  const bottom = Math.round(height * PANEL_BOTTOM);
  const cellWidth = width / GRID_COLUMNS;
  const cellHeight = (bottom - top) / GRID_ROWS;

  let lit = 0;
  let mass = 0;
  let sunMass = 0;
  let sunX = 0;
  const grid = new Float64Array(GRID_COLUMNS * GRID_ROWS);
  const counts = new Float64Array(GRID_COLUMNS * GRID_ROWS);

  for (let y = top; y < bottom; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const lum = 0.0722 * data[i] + 0.7152 * data[i + 1] + 0.2126 * data[i + 2];
      const cell =
        Math.min(GRID_ROWS - 1, Math.floor((y - top) / cellHeight)) * GRID_COLUMNS +
        Math.min(GRID_COLUMNS - 1, Math.floor(x / cellWidth));
      grid[cell] += lum;
      counts[cell] += 1;
      if (lum <= FLOOR) continue;
      lit += 1;
      mass += lum;
      if (lum > SUN) {
        sunMass += lum;
        sunX += x * lum;
      }
    }
  }

  for (let i = 0; i < grid.length; i += 1) grid[i] /= Math.max(1, counts[i]);

  return {
    width,
    /** Pixels bright enough to be part of the assembly — how big it renders. */
    lit,
    /** Total luminance in the band. */
    mass: Math.round(mass),
    /** The sun's centre of mass in device pixels, which a rotation must not move. */
    sunX: sunMass ? sunX / sunMass : 0,
    grid,
  };
}

/** How differently two frames place their light, as a % of mean cell brightness. */
export function difference(a, b) {
  let sum = 0;
  let scale = 0;
  for (let i = 0; i < a.grid.length; i += 1) {
    sum += Math.abs(a.grid[i] - b.grid[i]);
    scale += (a.grid[i] + b.grid[i]) / 2;
  }
  return (sum / Math.max(0.001, scale)) * 100;
}
