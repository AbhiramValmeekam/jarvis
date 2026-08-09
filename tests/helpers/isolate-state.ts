/**
 * Redirect runtime-private state to a throwaway directory.
 *
 * The runtime publishes its IPC token under `%LOCALAPPDATA%\Jarvis`, and revokes
 * it on shutdown. Two test files each starting a runtime would then fight over
 * one real file: whichever stopped first would delete the credentials the other
 * was still authenticating with. Vitest runs files in parallel, so that is a
 * flake waiting to happen — and a test suite has no business writing into the
 * developer's actual profile either way.
 *
 * Import this for its side effect, before constructing a runtime. `tokenFilePath`
 * reads the environment on every call, so setting it here is enough.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "jarvis-test-state-"));

process.env.LOCALAPPDATA = dir;
process.env.XDG_STATE_HOME = dir;

/** Where this worker's runtime state went, for tests that assert on it. */
export const isolatedStateDir = dir;
