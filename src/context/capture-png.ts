/**
 * The actual screenshot: pixels into memory, as PNG bytes.
 *
 * Kept out of `screen-capture.ts` on purpose. That file is the policy — who is
 * asked, how often, what they are told — and it imports nothing, which is what
 * lets the policy be tested exhaustively on a machine with no display. This file
 * is the part that touches Windows, and it is deliberately small enough to read
 * in one sitting.
 *
 * **Why not a temp file.** The obvious implementation saves to `%TEMP%` and reads
 * it back, and the Phase 4 `screenshot` executor already does something like that
 * for a file the user explicitly asked to keep. It is the wrong shape here: a PNG
 * of the whole desktop sitting in a world-readable temp directory is exactly the
 * artefact §53's habit exists to avoid, and if the process dies between the save
 * and the unlink it stays there. So the image travels base64 on stdout and exists
 * only as a `Uint8Array` the caller owns.
 *
 * **Why it is downscaled.** A 4K desktop is several megabytes of PNG, and base64
 * inflates that by a third. Nothing downstream benefits: the consumer of these
 * bytes is a vision model, which resizes anyway. Capping the width keeps the
 * transfer small enough to be reliable and is not a fidelity decision anyone will
 * notice.
 */

/** Widest image this will produce. Beyond it the capture is scaled down. */
export const CAPTURE_MAX_WIDTH = 1600;

/** Refuse anything too small to be a real screenshot — see `decodePng`. */
const MIN_PLAUSIBLE_BYTES = 1024;

/** PNG's 8-byte signature. The one claim about this data worth verifying. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Capture the whole virtual desktop, scale it down, and emit base64 PNG.
 *
 * A constant, like every other script in this project: the only value that varies
 * is the width cap, and it arrives through the environment where PowerShell reads
 * it as data rather than parsing it as script.
 *
 * `[Console]::Out.Write` rather than `Write-Output` — the latter goes through
 * PowerShell's formatter, which is free to wrap a long string at the host width.
 * When stdout is a pipe it does not, but relying on that is relying on a detail
 * of the host rather than on the call.
 */
export const CAPTURE_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$max = 0
if ($env:JARVIS_CAPTURE_MAX_WIDTH -match '^[0-9]+$') { $max = [int]$env:JARVIS_CAPTURE_MAX_WIDTH }
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$g.Dispose()
$out = $bmp
if ($max -gt 0 -and $b.Width -gt $max) {
  $h = [int][Math]::Round($b.Height * ($max / $b.Width))
  $small = New-Object System.Drawing.Bitmap($max, $h)
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.DrawImage($bmp, 0, 0, $max, $h)
  $sg.Dispose()
  $out = $small
}
$ms = New-Object System.IO.MemoryStream
$out.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bytes = $ms.ToArray()
$ms.Dispose()
if (-not [Object]::ReferenceEquals($out, $bmp)) { $out.Dispose() }
$bmp.Dispose()
[Console]::Out.Write([Convert]::ToBase64String($bytes))
`;

/**
 * Turn what PowerShell wrote into bytes, or say why it is not an image.
 *
 * Exported and tested separately because this is where a silent corruption would
 * live. Two failures found by hand in this phase — a console codepage mangling a
 * character, and PowerShell's progress stream arriving as CLIXML — both produced
 * output that looked plausible until something checked it. `Buffer.from(s,
 * "base64")` never throws: handed prose it returns short garbage. So the PNG
 * signature is verified rather than assumed, which turns "the screenshot is
 * corrupt" into "the capture failed", at the only point where the difference can
 * still be reported honestly.
 */
export function decodePng(stdout: string): Uint8Array {
  // Whitespace-tolerant: a wrapped or newline-terminated payload is still valid
  // base64 once the breaks are gone, and rejecting it would be pedantry.
  const b64 = stdout.replace(/\s+/g, "");
  if (!b64) throw new Error("the capture produced no output");

  const bytes = Buffer.from(b64, "base64");
  if (bytes.byteLength < MIN_PLAUSIBLE_BYTES) {
    // Small output is the shape of an error message that happened to survive
    // base64 decoding, not of a screenshot.
    throw new Error(`the capture produced ${bytes.byteLength} bytes, too few to be an image`);
  }
  for (const [i, want] of PNG_MAGIC.entries()) {
    if (bytes[i] !== want) throw new Error("the capture output is not a PNG");
  }
  return new Uint8Array(bytes);
}

export interface CapturePngDeps {
  /** The same runner the executors use, so there is one process helper. */
  run(
    file: string,
    args: readonly string[],
    opts?: { timeoutMs?: number; env?: Readonly<Record<string, string>>; maxBufferBytes?: number },
  ): Promise<string>;
  /** Wrap a fixed script for `-EncodedCommand`. Injected to avoid a cycle. */
  encode(script: string): readonly string[];
  maxWidth?: number;
}

/**
 * The `capture` dependency `ScreenCapture` needs, bound to real Windows.
 *
 * Returns a function rather than taking the deps per call so the runtime can wire
 * it once. 20 s is generous for a screenshot and deliberately so: the alternative
 * to waiting is telling the user a capture failed when it was merely slow on a
 * machine with four monitors.
 */
export function windowsCapturePng(deps: CapturePngDeps): () => Promise<Uint8Array> {
  const maxWidth = deps.maxWidth ?? CAPTURE_MAX_WIDTH;
  return async () => {
    const out = await deps.run("powershell.exe", deps.encode(CAPTURE_SCRIPT), {
      timeoutMs: 20_000,
      env: { JARVIS_CAPTURE_MAX_WIDTH: String(maxWidth) },
      // A downscaled PNG is well under a megabyte, but a machine whose
      // `VirtualScreen` spans several displays can beat that before scaling
      // applies. The default 1 MiB would truncate it into garbage that decodes
      // to the wrong thing rather than failing.
      maxBufferBytes: 32 << 20,
    });
    return decodePng(out);
  };
}
