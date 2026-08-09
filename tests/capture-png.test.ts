import { describe, it, expect } from "vitest";
import {
  decodePng,
  windowsCapturePng,
  CAPTURE_SCRIPT,
  CAPTURE_MAX_WIDTH,
} from "../src/context/capture-png.js";

/** A PNG header followed by enough filler to clear the plausibility floor. */
function fakePng(bytes = 4096): Buffer {
  const b = Buffer.alloc(bytes, 0x41);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  return b;
}

describe("reading what PowerShell wrote", () => {
  it("decodes a real PNG payload", () => {
    const png = fakePng();
    const out = decodePng(png.toString("base64"));
    expect(out.byteLength).toBe(png.byteLength);
    expect(Buffer.from(out).equals(png)).toBe(true);
  });

  it("tolerates line breaks in the payload", () => {
    // A host that wraps long output must not turn a good capture into a failure.
    const b64 = fakePng().toString("base64");
    const wrapped = (b64.match(/.{1,76}/g) ?? []).join("\r\n");
    expect(decodePng(wrapped).byteLength).toBeGreaterThan(1024);
  });

  it("rejects output that is not a PNG", () => {
    // The defect this exists for: `Buffer.from(s, "base64")` never throws. Handed
    // an error message it returns bytes, and without the signature check those
    // bytes would travel onward as an image.
    const prose = Buffer.from("A".repeat(4096)).toString("base64");
    expect(() => decodePng(prose)).toThrow(/not a PNG/i);
  });

  it("rejects CLIXML on the wire", () => {
    // Found by hand in this phase against the window reader. Same stream, same
    // trap: PowerShell's progress records can arrive mixed into the output.
    const clixml = '#< CLIXML\n<Objs Version="1.1.0.1"></Objs>';
    expect(() => decodePng(Buffer.from(clixml).toString("base64"))).toThrow();
  });

  it("rejects output too small to be a screenshot", () => {
    expect(() => decodePng(Buffer.from([0x89, 0x50]).toString("base64"))).toThrow(/too few/i);
  });

  it("rejects empty output rather than returning zero bytes", () => {
    expect(() => decodePng("")).toThrow(/no output/i);
    expect(() => decodePng("   \r\n  ")).toThrow(/no output/i);
  });

  it("does not accept a truncated PNG as a smaller one", () => {
    // Truncation is the failure mode a too-small `maxBuffer` produces, and it is
    // the dangerous one: the prefix is a valid PNG header, so only the length
    // floor stands between it and being treated as a picture.
    expect(() => decodePng(fakePng(64).toString("base64"))).toThrow(/too few/i);
  });
});

describe("the capture call", () => {
  function spy(stdout: string) {
    const calls: { file: string; args: readonly string[]; opts?: Record<string, unknown> }[] = [];
    const capture = windowsCapturePng({
      run: async (file, args, opts) => {
        calls.push({ file, args, ...(opts ? { opts: opts as Record<string, unknown> } : {}) });
        return stdout;
      },
      encode: (script) => ["-NoProfile", "-EncodedCommand", script],
    });
    return { capture, calls };
  }

  it("returns the decoded image", async () => {
    const { capture } = spy(fakePng().toString("base64"));
    const img = await capture();
    expect(img).toBeInstanceOf(Uint8Array);
    expect(img[0]).toBe(0x89);
  });

  it("asks for a buffer big enough that truncation cannot happen quietly", async () => {
    const { capture, calls } = spy(fakePng().toString("base64"));
    await capture();
    expect(calls[0]?.opts?.["maxBufferBytes"]).toBeGreaterThan(1 << 20);
  });

  it("passes the width cap as data, never spliced into the script", async () => {
    const { capture, calls } = spy(fakePng().toString("base64"));
    await capture();
    const env = calls[0]?.opts?.["env"] as Record<string, string> | undefined;
    expect(env?.["JARVIS_CAPTURE_MAX_WIDTH"]).toBe(String(CAPTURE_MAX_WIDTH));
    expect(CAPTURE_SCRIPT).not.toContain(String(CAPTURE_MAX_WIDTH));
  });

  it("reads the width from the environment as a number, not as script", () => {
    // The env var is checked against `^[0-9]+$` before it is used. Anything else
    // leaves the cap at 0, which means "do not scale" — never "run this".
    expect(CAPTURE_SCRIPT).toMatch(/match '\^\[0-9\]\+\$'/);
  });

  it("writes no file", () => {
    // The property the module header claims. A capture that touches the disk
    // leaves an artefact nobody consented to, and this is the cheapest place to
    // notice it coming back.
    expect(CAPTURE_SCRIPT).not.toMatch(/\.Save\(\$env:|Out-File|Set-Content|New-Item|TEMP/i);
    expect(CAPTURE_SCRIPT).toMatch(/MemoryStream/);
  });

  it("disposes what it allocates", () => {
    // GDI bitmaps are unmanaged handles. An always-on process that captures
    // twenty times a session and leaks each one is a slow memory fault.
    expect(CAPTURE_SCRIPT).toMatch(/\$bmp\.Dispose\(\)/);
    expect(CAPTURE_SCRIPT).toMatch(/\$ms\.Dispose\(\)/);
    expect(CAPTURE_SCRIPT).toMatch(/\$g\.Dispose\(\)/);
  });

  it("keeps the profile out of the call", () => {
    const { calls } = spy(fakePng().toString("base64"));
    void calls;
    // `encodePwsh` is what the runtime injects; this only asserts the script
    // itself does not try to loosen anything.
    expect(CAPTURE_SCRIPT).not.toMatch(/ExecutionPolicy|Bypass/i);
  });

  it("lets a failed capture fail rather than returning something", async () => {
    const capture = windowsCapturePng({
      run: async () => {
        throw new Error("powershell is missing");
      },
      encode: (s) => [s],
    });
    await expect(capture()).rejects.toThrow(/powershell is missing/);
  });
});
