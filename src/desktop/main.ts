/**
 * Electron main process — the desktop shell.
 *
 * What this process is: a tray, a window, and a bridge to the runtime.
 * What it is NOT: the assistant. Jarvis lives in the headless runtime, which
 * this process may start but never owns. Killing the shell must leave Jarvis
 * listening; that is the whole point of the split (ARCHITECTURE.md §4).
 *
 * Consequences visible below:
 *   - closing the window hides it (§13 close ≠ quit)
 *   - quitting the shell does NOT stop the runtime; only tray Quit does
 *   - a second shell instance focuses the first rather than racing it
 */
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, powerMonitor } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PipeClient } from "../ipc/pipe-client.js";
import type { RuntimeStatus, ServerEvent } from "../ipc/contract.js";
import { RuntimeLink, spawnDetachedRuntime, type RuntimeClientLike } from "./runtime-link.js";
import { buildTrayView, type TrayActionId, type TrayFacts, type TrayIcon } from "./tray-model.js";
import { iconDataUrl } from "./tray-icons.js";
import { AutostartManager } from "../system/autostart.js";
import { resolveAutostartCommand, startedMinimized, isRuntimeMode, RUNTIME_MODE_FLAG } from "./launch.js";

const __dirname_ = fileURLToPath(new URL(".", import.meta.url));

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let client: PipeClient | null = null;
let status: RuntimeStatus | null = null;
let linked = false;
/** Set only by tray Quit — it is the one path allowed to stop the runtime. */
let quittingForReal = false;

const autostart = new AutostartManager();
let autostartState: TrayFacts["autostart"] = {
  enabled: false,
  available: false,
  reason: "not checked yet",
};

// --- bootstrap -------------------------------------------------------------
// A packaged build ships one executable that can be either the shell or the
// headless runtime. Runtime mode is decided before anything Electron-shaped
// happens, so it never flashes a window or takes the shell's instance lock.
if (isRuntimeMode(process.argv)) {
  void import("../runtime/main.js");
} else if (!app.requestSingleInstanceLock()) {
  // A second shell must surface the first, not fight it for the tray.
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  void main();
}

async function main(): Promise<void> {
  await app.whenReady();

  // Tray first: it is the always-reachable surface, and it must exist even if
  // the runtime never comes up so the user can still see why and quit.
  createTray();
  await refreshAutostart();
  renderTray();

  if (!startedMinimized(process.argv)) createWindow();

  wirePowerEvents();
  wireRendererBridge();

  try {
    await connectRuntime();
  } catch (err) {
    // Not fatal: the tray shows "not connected" and keeps retrying.
    log(`could not attach to the runtime: ${describe(err)}`);
  }

  app.on("window-all-closed", () => {
    // Deliberately empty. On Windows the default is to quit, which would kill
    // the tray and, with it, the user's only way back to Jarvis.
  });

  app.on("before-quit", () => {
    if (!quittingForReal) log("shell exiting; runtime left running");
  });
}

// --- runtime link ----------------------------------------------------------

async function connectRuntime(): Promise<void> {
  const link = new RuntimeLink({
    createClient: () =>
      new PipeClient({
        clientName: "jarvis-desktop",
        autoReconnect: false, // RuntimeLink owns the retry loop during attach
      }) as unknown as RuntimeClientLike,
    spawnRuntime: () => {
      log("no runtime found; starting one");
      spawnDetachedRuntime(runtimeCommand.command, runtimeCommand.args, runtimeCommand.env);
    },
  });

  const result = await link.attach();
  client = result.client as unknown as PipeClient;
  status = result.status;
  setLinked(true);
  log(result.spawned ? "started and attached to a new runtime" : "attached to the running runtime");

  client.on("event", (e: ServerEvent) => {
    if (e.type === "status") status = e.status;
    if (e.type === "state" && status) status = { ...status, state: e.state };
    renderTray();
    win?.webContents.send("jarvis:event", e);
  });

  client.on("disconnected", () => {
    setLinked(false);
    void reattachSoon();
  });
}

/** The runtime is separate, so losing it is a reconnect, not a crash. */
let reattachTimer: NodeJS.Timeout | null = null;
async function reattachSoon(): Promise<void> {
  if (reattachTimer || quittingForReal) return;
  reattachTimer = setTimeout(() => {
    reattachTimer = null;
    connectRuntime().catch((err) => {
      log(`reattach failed: ${describe(err)}`);
      void reattachSoon();
    });
  }, 2_000);
}

function setLinked(value: boolean): void {
  linked = value;
  renderTray();
  win?.webContents.send("jarvis:link", value);
}

/**
 * How to start the runtime.
 *
 * Packaged: re-launch our own executable in runtime mode — one binary, no Node
 * install required on the user's machine.
 *
 * Dev: `process.execPath` is electron.exe, which only behaves as Node when
 * ELECTRON_RUN_AS_NODE is set. Without it the spawn silently produces a second
 * Electron rather than a runtime, and the shell waits forever for a pipe that
 * never appears.
 */
const runtimeCommand = app.isPackaged
  ? { command: process.execPath, args: [RUNTIME_MODE_FLAG], env: undefined }
  : {
      command: process.execPath,
      args: [
        join(__dirname_, "../../node_modules/tsx/dist/cli.mjs"),
        join(__dirname_, "../../src/runtime/main.ts"),
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" } as NodeJS.ProcessEnv,
    };

// --- window ----------------------------------------------------------------

function createWindow(): void {
  if (win && !win.isDestroyed()) return showWindow();

  win = new BrowserWindow({
    width: 460,
    height: 680,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: false,
    backgroundColor: "#00000000",
    title: "Jarvis",
    webPreferences: {
      preload: join(__dirname_, "../preload/preload.mjs"),
      // The renderer displays model and web-derived content, which the security
      // model treats as untrusted. It gets no Node and no direct IPC surface
      // beyond what preload.ts enumerates.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
    },
  });

  win.once("ready-to-show", () => win?.show());

  // Close hides. Only tray Quit really quits (§13).
  win.on("close", (e) => {
    if (quittingForReal) return;
    e.preventDefault();
    win?.hide();
  });

  // Any attempt to open a new window goes to the real browser instead of
  // becoming an unsandboxed Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname_, "../renderer/index.html"));
}

function showWindow(): void {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  else showWindow();
}

// --- tray ------------------------------------------------------------------

function createTray(): void {
  tray = new Tray(imageFor("offline"));
  tray.on("click", () => toggleWindow());
  tray.on("double-click", () => showWindow());
}

function imageFor(icon: TrayIcon) {
  const img = nativeImage.createFromDataURL(iconDataUrl(icon));
  img.setTemplateImage(false);
  return img;
}

function trayFacts(): TrayFacts {
  return {
    connected: linked && status !== null,
    state: status?.state ?? "idle",
    hermes: status?.hermes ?? {
      state: "unknown",
      pid: null,
      sessionId: null,
      restartCount: 0,
      gaveUpReason: null,
    },
    voice: status?.voice ?? {
      state: "unknown",
      pid: null,
      wakeWord: null,
      device: null,
      capturing: false,
      restartCount: 0,
      gaveUpReason: null,
    },
    listening: status?.listening ?? false,
    muted: status?.muted ?? false,
    autostart: autostartState,
  };
}

function renderTray(): void {
  if (!tray) return;
  const view = buildTrayView(trayFacts());

  tray.setImage(imageFor(view.icon));
  tray.setToolTip(view.tooltip);
  tray.setContextMenu(
    Menu.buildFromTemplate(
      view.menu.map((entry) => {
        if (entry.kind === "separator") return { type: "separator" as const };
        if (entry.kind === "status") return { label: entry.text, enabled: false };
        return {
          label: entry.label,
          enabled: entry.enabled,
          ...(entry.checked === undefined
            ? {}
            : { type: "checkbox" as const, checked: entry.checked }),
          click: () => void onTrayAction(entry.id),
        };
      }),
    ),
  );
}

async function onTrayAction(id: TrayActionId): Promise<void> {
  try {
    switch (id) {
      case "toggle_window":
        toggleWindow();
        return;
      case "toggle_listening":
        await client?.request({ type: "set_listening", enabled: !trayFacts().listening });
        return;
      case "toggle_muted":
        await client?.request({ type: "set_muted", muted: !trayFacts().muted });
        return;
      case "restart_hermes":
        await client?.request({ type: "restart_hermes" });
        return;
      case "restart_voice":
        await client?.request({ type: "restart_voice" });
        return;
      case "toggle_autostart":
        await toggleAutostart();
        return;
      case "quit":
        await quitEverything();
        return;
    }
  } catch (err) {
    log(`tray action ${id} failed: ${describe(err)}`);
  } finally {
    await refreshStatus();
  }
}

/**
 * The only path that stops the runtime.
 *
 * Order matters: tell the runtime to quit while the pipe is still open, then
 * tear down the shell.
 */
async function quitEverything(): Promise<void> {
  quittingForReal = true;
  try {
    await client?.request({ type: "quit" });
  } catch (err) {
    log(`runtime did not acknowledge quit: ${describe(err)}`);
  }
  await client?.close().catch(() => {});
  tray?.destroy();
  app.quit();
}

// --- autostart -------------------------------------------------------------

async function refreshAutostart(): Promise<void> {
  const target = resolveAutostartCommand({
    execPath: process.execPath,
    isPackaged: app.isPackaged,
  });
  if (!target.available) {
    autostartState = { enabled: false, available: false, reason: target.reason };
    return;
  }
  const state = await autostart.getState();
  autostartState = {
    enabled: state.enabled,
    available: state.supported,
    ...(state.detail ? { reason: state.detail } : {}),
  };
}

async function toggleAutostart(): Promise<void> {
  const target = resolveAutostartCommand({
    execPath: process.execPath,
    isPackaged: app.isPackaged,
  });
  if (!target.available) {
    log(`autostart unavailable: ${target.reason}`);
    return;
  }
  await autostart.setEnabled(!autostartState.enabled, target.command);
  await refreshAutostart();
  renderTray();
}

// --- power -----------------------------------------------------------------

function wirePowerEvents(): void {
  // The runtime handles its own suspend/resume; the shell only needs to stop
  // trusting a link that a sleep may have severed.
  powerMonitor.on("suspend", () => log("system suspending"));
  powerMonitor.on("resume", () => {
    log("system resumed; re-checking the runtime link");
    void refreshStatus().catch(() => void reattachSoon());
  });
  powerMonitor.on("lock-screen", () => log("session locked"));
  powerMonitor.on("unlock-screen", () => void refreshStatus().catch(() => {}));
}

// --- renderer bridge -------------------------------------------------------

function wireRendererBridge(): void {
  ipcMain.handle("jarvis:get-status", async () => {
    await refreshStatus();
    return status;
  });
  ipcMain.handle("jarvis:prompt", async (_e, text: unknown) => {
    if (typeof text !== "string" || !text.trim()) return;
    await requireClient().request({ type: "prompt", text });
  });
  ipcMain.handle("jarvis:cancel", async () => {
    await requireClient().request({ type: "cancel" });
  });
  ipcMain.handle("jarvis:set-listening", async (_e, enabled: unknown) => {
    await requireClient().request({ type: "set_listening", enabled: Boolean(enabled) });
  });
  ipcMain.handle("jarvis:set-muted", async (_e, muted: unknown) => {
    await requireClient().request({ type: "set_muted", muted: Boolean(muted) });
  });
  ipcMain.handle("jarvis:restart-hermes", async () => {
    await requireClient().request({ type: "restart_hermes" });
  });
  ipcMain.handle("jarvis:restart-voice", async () => {
    await requireClient().request({ type: "restart_voice" });
  });
  ipcMain.handle("jarvis:push-to-talk", async (_e, down: unknown) => {
    await requireClient().request({ type: "push_to_talk", down: Boolean(down) });
  });
  ipcMain.handle("jarvis:say", async (_e, text: unknown) => {
    if (typeof text !== "string" || !text.trim()) return;
    await requireClient().request({ type: "say", text });
  });
  ipcMain.handle("jarvis:permission-response", async (_e, requestId: unknown, decision: unknown) => {
    // Validated against a literal list rather than cast. This is the one bridge
    // call that authorises an action on the machine, so a renderer sending
    // "allow_forever" or an object must fall off here, not further in.
    if (typeof requestId !== "string" || !requestId) return;
    if (decision !== "allow_once" && decision !== "allow_always" && decision !== "deny") return;
    await requireClient().request({ type: "permission_response", requestId, decision });
  });
  ipcMain.on("jarvis:hide-window", () => win?.hide());
}

function requireClient(): PipeClient {
  if (!client || !linked) throw new Error("not connected to the Jarvis runtime");
  return client;
}

async function refreshStatus(): Promise<void> {
  if (!client) return;
  try {
    status = (await client.request({ type: "get_status" })) as RuntimeStatus;
    if (!linked) setLinked(true);
    else renderTray();
    win?.webContents.send("jarvis:event", { type: "status", status });
  } catch {
    setLinked(false);
    void reattachSoon();
  }
}

// --- misc ------------------------------------------------------------------

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function log(line: string): void {
  console.log(`[shell] ${line}`);
}
