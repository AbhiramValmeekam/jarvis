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
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, powerMonitor, Notification } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PipeClient } from "../ipc/pipe-client.js";
import type { NotificationView, RuntimeStatus, ServerEvent } from "../ipc/contract.js";
import { FORGET_EVERYTHING } from "../ipc/contract.js";
import { RuntimeLink, spawnDetachedRuntime, type RuntimeClientLike } from "./runtime-link.js";
import { buildTrayView, type TrayActionId, type TrayFacts, type TrayIcon } from "./tray-model.js";
import { iconDataUrl } from "./tray-icons.js";
import { AutostartManager } from "../system/autostart.js";
import { resolveAutostartCommand, startedMinimized, isRuntimeMode, RUNTIME_MODE_FLAG } from "./launch.js";
import { eventWantsWindow } from "./event-window.js";
import { openLogFile } from "../system/log-file.js";

const __dirname_ = fileURLToPath(new URL(".", import.meta.url));

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
/**
 * Mission Control, when it has been opened.
 *
 * A second window rather than a panel in the HUD, and the reason is the shape of
 * the thing: the HUD is 460 px of conversation that hides when you press Escape,
 * and a mission is a plan graph that outlives the sentence that started it. It
 * loads the same renderer bundle on a `#/mission` route — one preload bridge, one
 * set of security settings, nothing duplicated.
 */
let missionWin: BrowserWindow | null = null;
/** The Memory page, when it has been opened. Same reasoning, different subject. */
let memoryWin: BrowserWindow | null = null;
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
  // The diagnostic entry point: `Jarvis.exe --runtime`, useful when you want the
  // runtime started by hand from the packaged binary. It is NOT how the shell
  // starts it — see `runtimeCommand` below, which runs the same binary as plain
  // Node so no Chromium exists at all. This branch cannot get there, because by
  // the time argv is read Electron has already begun its browser bootstrap; the
  // switches below are the most that can be recovered from inside, and measured
  // they took the GPU helper from 82 MB to 46 MB rather than to zero.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  void import("../runtime/main.js");
} else if (!app.requestSingleInstanceLock()) {
  // A second shell must surface the first, not fight it for the tray.
  app.quit();
} else {
  // Windows groups taskbar buttons and attributes toast notifications by this
  // id. Without it a packaged build reports itself as `electron.app.Electron`,
  // which means `showToast` — how a failed scheduled task reaches a user who is
  // not looking at the HUD — arrives labelled as somebody else's application.
  // Must match `appId` in electron-builder.yml, or the installed shortcut and
  // the running process disagree and toasts are silently dropped.
  app.setAppUserModelId("com.abhiram.jarvis");
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
    if (e.type === "notification") showToast(e.notification);
    renderTray();

    // Waking must be able to *create* the window, not merely update it. After a
    // reboot the shell starts minimized, so `win` is null and the send below
    // goes nowhere — the runtime hears its name, listens, times out and returns
    // to idle, and the user sees no evidence any of it happened. Observed on the
    // §62 reboot test: "when i say hey jarvis the application not automatically
    // showing up, i need to click from tray and again i have to call".
    if (eventWantsWindow(e)) showWindow();

    sendToRenderers("jarvis:event", e);
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
  sendToRenderers("jarvis:link", value);
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
/**
 * How the shell starts the runtime, in both builds — and in both cases as plain
 * Node rather than as a second Electron browser process.
 *
 * Packaged, this is `Jarvis.exe out/main/runtime.js` with
 * `ELECTRON_RUN_AS_NODE=1`: the same binary, running only its Node half. The
 * obvious form — `Jarvis.exe --runtime` — also works and is kept below as a
 * diagnostic path, but it costs a GPU process and a network utility process that
 * a headless assistant never uses (measured: 95 MB resident, §72). Nothing under
 * `src/runtime/**` imports `electron`, which is what makes the Node-only form
 * legal; `electron.vite.config.ts` builds it as its own entry for this reason.
 */
const runtimeCommand = app.isPackaged
  ? {
      command: process.execPath,
      args: [join(__dirname_, "runtime.js")],
      env: { ELECTRON_RUN_AS_NODE: "1" } as NodeJS.ProcessEnv,
    }
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

/**
 * Open Mission Control, or bring it forward.
 *
 * Framed and resizable where the HUD is neither: this window is read for minutes
 * at a time and holds a plan, a stream and a report, so it gets a real title bar
 * and the ability to be sized. Same preload, same `contextIsolation`, same
 * `setWindowOpenHandler` — a second window must not be a second security model.
 *
 * Closing it destroys it, unlike the HUD, which hides. The HUD hides because it is
 * how Jarvis is reached and the tray promise is that closing it does not stop the
 * assistant; a mission console is a thing you open to look at something, and
 * keeping an invisible renderer alive to hold a view that is rebuilt from the
 * runtime on open would be cost with nothing bought.
 */
function openMissionWindow(): void {
  if (missionWin && !missionWin.isDestroyed()) {
    if (missionWin.isMinimized()) missionWin.restore();
    missionWin.show();
    missionWin.focus();
    return;
  }

  missionWin = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0d0805",
    title: "Jarvis — Mission Control",
    webPreferences: {
      preload: join(__dirname_, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
    },
  });

  missionWin.once("ready-to-show", () => missionWin?.show());
  missionWin.on("closed", () => {
    missionWin = null;
  });
  missionWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // The route is a hash, so both windows are the same built bundle and the same
  // dev server entry. `main.tsx` reads it once at mount.
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) void missionWin.loadURL(`${devUrl}#/mission`);
  else {
    void missionWin.loadFile(join(__dirname_, "../renderer/index.html"), { hash: "/mission" });
  }
}

/**
 * Open the Memory page, or bring it forward.
 *
 * A third window rather than a pane inside Mission Control, because what it shows
 * is not about a mission: it is the four layers Jarvis keeps about the person, and
 * it is the one place they are edited and deleted. It is also the window a user
 * opens when they want to check what Jarvis knows — an errand of its own, not a
 * detour inside watching an objective run.
 *
 * Smaller than Mission Control and the same security model as both other windows.
 */
function openMemoryWindow(): void {
  if (memoryWin && !memoryWin.isDestroyed()) {
    if (memoryWin.isMinimized()) memoryWin.restore();
    memoryWin.show();
    memoryWin.focus();
    return;
  }

  memoryWin = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    show: false,
    backgroundColor: "#0d0805",
    title: "Jarvis — Memory",
    webPreferences: {
      preload: join(__dirname_, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
    },
  });

  memoryWin.once("ready-to-show", () => memoryWin?.show());
  memoryWin.on("closed", () => {
    memoryWin = null;
  });
  memoryWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) void memoryWin.loadURL(`${devUrl}#/memory`);
  else {
    void memoryWin.loadFile(join(__dirname_, "../renderer/index.html"), { hash: "/memory" });
  }
}

/**
 * Every open renderer, for a fan-out that must not depend on which one exists.
 *
 * A mission runs whether or not Mission Control is open, and the HUD is the window
 * that can be hidden or never created at all. Sending to a list rather than to
 * `win` is what keeps "the events arrived" independent of "the user had a window
 * open when they arrived".
 */
function renderers(): BrowserWindow[] {
  return [win, missionWin, memoryWin].filter(
    (w): w is BrowserWindow => w !== null && !w.isDestroyed(),
  );
}

function sendToRenderers(channel: string, payload: unknown): void {
  for (const w of renderers()) w.webContents.send(channel, payload);
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
    ...(status ? { missions: status.missions } : {}),
  };
}

function renderTray(): void {
  // A destroyed tray is not a missing one: `quitEverything` tears it down while
  // the click handler that called it is still on the stack, and `setImage` on the
  // corpse throws. The handle is cleared there, and this is the second line of
  // defence for any other path that outlives the tray.
  if (!tray || tray.isDestroyed()) return;
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
          // `.catch` rather than a bare `void`: a menu click is a fire-and-forget
          // promise, so anything that escapes `onTrayAction` — including from its
          // own `finally` — would otherwise surface as an unhandled rejection with
          // no user-visible trace.
          click: () => void onTrayAction(entry.id).catch((err: unknown) => {
            log(`tray action ${entry.id} failed: ${describe(err)}`);
          }),
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
      case "open_missions":
        openMissionWindow();
        return;
      case "open_memory":
        openMemoryWindow();
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
    // Not after Quit. The tray and the pipe are both gone by then, so a status
    // refresh would ask a closed client and repaint a destroyed tray — which is
    // exactly the unhandled rejection this `void onTrayAction(...)` would swallow.
    if (!quittingForReal) await refreshStatus();
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
  // Clearing the handle is what makes `renderTray`'s guard true. Leaving a
  // destroyed Tray in the variable is how "Tray is destroyed" reached the top
  // level: the guard read "not null" and called into it anyway.
  tray = null;
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

// --- notifications ---------------------------------------------------------

/**
 * Draw a Windows toast.
 *
 * Delivery only. Whether this notification deserved to exist was decided in the
 * runtime (`notifications/notifier.ts`) — the level policy and the repeat
 * cooldown both live there, once, because the runtime outlives every shell and a
 * second copy of the policy here would drift from it and double-suppress or
 * double-show.
 *
 * The strings arrive already sanitised (§52): a job name is derived from an
 * agent's prompt, and a toast renders in the Action Center, outside our window
 * and past any escaping the HUD does.
 *
 * Clicking a toast surfaces the window rather than acting. There is no
 * notification here whose right response is a one-click irreversible action, and
 * a toast is the worst possible consent surface — it appears while the user is
 * looking somewhere else, at something else.
 */
function showToast(n: NotificationView): void {
  if (!Notification.isSupported()) {
    // Not silent: a machine where toasts are unavailable is one where the user
    // would otherwise never learn their scheduler is dead.
    log(`notification (no toast support): ${n.title} — ${n.body}`);
    return;
  }
  const toast = new Notification({
    title: n.title,
    body: n.body,
    silent: false,
  });
  toast.on("click", () => showWindow());
  toast.show();
}

// --- renderer bridge -------------------------------------------------------

function wireRendererBridge(): void {
  ipcMain.handle("jarvis:get-status", async () => {
    await refreshStatus();
    return status;
  });
  ipcMain.handle("jarvis:get-activity", async () => {
    // No limit forwarded from the renderer: the runtime's default is already the
    // right size for the view, and letting the renderer pick the number would
    // hand the untrusted side control of the response size for nothing gained.
    const result = await requireClient().request({ type: "get_activity" });
    return Array.isArray(result) ? result : [];
  });
  ipcMain.handle("jarvis:get-tasks", async () => {
    const result = await requireClient().request({ type: "get_tasks" });
    return result ?? null;
  });
  // The three read-only views the Command Center shows. No parameters on any of
  // them: nothing the renderer says can widen what comes back, so a compromised
  // renderer gets exactly the same answer the user would have seen anyway.
  ipcMain.handle("jarvis:get-mcp", async () => {
    const result = await requireClient().request({ type: "get_mcp" });
    return result ?? null;
  });
  ipcMain.handle("jarvis:get-memory", async () => {
    const result = await requireClient().request({ type: "get_memory" });
    return result ?? null;
  });
  ipcMain.handle("jarvis:get-skills", async () => {
    const result = await requireClient().request({ type: "get_skills" });
    return result ?? null;
  });
  ipcMain.handle("jarvis:get-world", async () => {
    const result = await requireClient().request({ type: "get_world" });
    return result ?? null;
  });
  // --- the world -----------------------------------------------------------
  // A write, and the only one that can start a mission without an objective being
  // typed. `accept` is checked against the literal pair rather than cast, for the
  // reason `resolve-learning` is: the two words mean "run this" and "never mention
  // it again", and a renderer that could send a third string would be choosing
  // which. The objective itself is not accepted from here at all — it is the one
  // the runtime already queued, looked up by id on its own side of the pipe.
  ipcMain.handle("jarvis:resolve-proposal", async (_e, proposalId: unknown, decision: unknown) => {
    if (typeof proposalId !== "string" || !proposalId) return null;
    if (decision !== "accept" && decision !== "decline") return null;
    const result = await requireClient().request({ type: "resolve_proposal", proposalId, decision });
    return result ?? null;
  });
  // --- memory --------------------------------------------------------------
  // Writes, unlike the three views above, and each one validated here before a
  // request is formed. What they can write is the user's own notes: there is no
  // shape below that stores an inferred value, invents a suggestion, or reaches a
  // store method that dictation does not already go through.
  ipcMain.handle("jarvis:remember", async (_e, text: unknown) => {
    if (typeof text !== "string" || !text.trim()) return null;
    const result = await requireClient().request({ type: "remember", text });
    return result ?? null;
  });
  ipcMain.handle("jarvis:edit-memory", async (_e, memoryId: unknown, text: unknown) => {
    if (typeof memoryId !== "string" || !memoryId) return null;
    if (typeof text !== "string" || !text.trim()) return null;
    const result = await requireClient().request({ type: "edit_memory", memoryId, text });
    return result ?? null;
  });
  ipcMain.handle("jarvis:forget-memory", async (_e, memoryId: unknown) => {
    if (typeof memoryId !== "string" || !memoryId) return null;
    const result = await requireClient().request({ type: "forget_memory", memoryId });
    return result ?? null;
  });
  ipcMain.handle("jarvis:forget-episode", async (_e, episodeId: unknown) => {
    if (typeof episodeId !== "string" || !episodeId) return null;
    const result = await requireClient().request({ type: "forget_episode", episodeId });
    return result ?? null;
  });
  ipcMain.handle("jarvis:set-profile", async (_e, key: unknown, value: unknown) => {
    if (typeof key !== "string" || !key) return null;
    // Absent stays absent. The runtime reads a missing `value` as "clear this
    // field", and coercing `undefined` to a string here would write the word.
    const result = await requireClient().request({
      type: "set_profile",
      key,
      ...(typeof value === "string" ? { value } : {}),
    });
    return result ?? null;
  });
  ipcMain.handle("jarvis:resolve-learning", async (_e, proposalId: unknown, decision: unknown) => {
    // Checked against the literal pair rather than cast: `accept` writes a fact
    // about the user into a store, which is the whole reason this queue exists.
    if (typeof proposalId !== "string" || !proposalId) return null;
    if (decision !== "accept" && decision !== "reject") return null;
    const result = await requireClient().request({ type: "resolve_learning", proposalId, decision });
    return result ?? null;
  });
  ipcMain.handle("jarvis:set-memory-enabled", async (_e, enabled: unknown) => {
    const result = await requireClient().request({
      type: "set_memory_enabled",
      enabled: Boolean(enabled),
    });
    return result ?? null;
  });
  ipcMain.handle("jarvis:forget-everything", async (_e, confirm: unknown) => {
    // Compared against the shared phrase here as well as in the runtime. This is
    // the one irreversible bulk delete on the bridge, and a check in two processes
    // is the cheap half of not having it fire by accident.
    if (confirm !== FORGET_EVERYTHING) return null;
    const result = await requireClient().request({ type: "forget_everything", confirm });
    return result ?? null;
  });
  // --- missions ------------------------------------------------------------
  // The one bridge call that starts an autonomous loop. It takes an objective and
  // nothing else: there is no shape here that could carry a step, a tool name or
  // an argument, so everything the mission does is chosen on the runtime's side.
  ipcMain.handle("jarvis:start-mission", async (_e, objective: unknown) => {
    if (typeof objective !== "string" || !objective.trim()) return null;
    // No timeout of our own. A mission is allowed to take minutes and the runtime
    // holds the four ceilings that stop it; a shell-side deadline would abandon
    // the answer to a mission that is still legitimately running.
    const result = await requireClient().request({
      type: "start_mission",
      objective: objective.trim(),
    });
    return result ?? null;
  });
  // A look at the screen, which spends one capture behind the consent gate the
  // runtime owns. Read-only on purpose: what comes back is a proposal, and the only
  // way it becomes a mission is the user clicking Start, which calls
  // `jarvis:start-mission` above with the objective they were shown.
  ipcMain.handle("jarvis:propose-from-screen", async (_e, ask: unknown) => {
    // No deadline here either. The capture waits on a consent prompt the user has to
    // answer, and a vision model can take twenty seconds on a 4K screenshot; the
    // runtime's own `timeoutMs` is the one clock that should end this.
    const result = await requireClient().request({
      type: "propose_from_screen",
      ...(typeof ask === "string" && ask.trim() ? { ask: ask.trim() } : {}),
    });
    return result ?? null;
  });
  ipcMain.handle("jarvis:get-missions", async () => {
    // No limit from the renderer, as with `get_activity`: the runtime's default is
    // the right size and letting the untrusted side pick it buys nothing.
    const result = await requireClient().request({ type: "get_missions" });
    return result ?? null;
  });
  ipcMain.handle("jarvis:get-mission", async (_e, missionId: unknown) => {
    if (typeof missionId !== "string" || !missionId) return null;
    const result = await requireClient().request({ type: "get_mission", missionId });
    return result ?? null;
  });
  ipcMain.handle("jarvis:get-trace", async (_e, missionId: unknown) => {
    // A read, and the largest one this bridge carries. The runtime bounds it — the
    // trace trims itself to 200 entries and says how many it dropped — so there is no
    // size for the renderer to ask for and none for it to get wrong.
    if (typeof missionId !== "string" || !missionId) return null;
    const result = await requireClient().request({ type: "get_trace", missionId });
    return result ?? null;
  });
  ipcMain.handle("jarvis:cancel-mission", async (_e, missionId: unknown) => {
    if (typeof missionId !== "string" || !missionId) return;
    await requireClient().request({ type: "cancel_mission", missionId });
  });
  ipcMain.handle(
    "jarvis:approve-step",
    async (_e, missionId: unknown, stepId: unknown, decision: unknown) => {
      // Validated against the literal list rather than cast, exactly as
      // `jarvis:permission-response` is: this authorises a step to run.
      if (typeof missionId !== "string" || !missionId) return;
      if (typeof stepId !== "string" || !stepId) return;
      if (decision !== "allow_once" && decision !== "allow_always" && decision !== "deny") return;
      await requireClient().request({ type: "approve_step", missionId, stepId, decision });
    },
  );
  ipcMain.handle("jarvis:get-tools", async () => {
    const result = await requireClient().request({ type: "get_tools" });
    return result ?? null;
  });
  /**
   * The demo catalogue and its verdict (§28).
   *
   * Three handlers and no fourth that runs a scenario: the Run button in the judge
   * view calls `jarvis:start-mission` with the objective string the view was shown,
   * so a demonstration is indistinguishable from a typed objective all the way down.
   */
  ipcMain.handle("jarvis:get-demo", async () => {
    const result = await requireClient().request({ type: "get_demo" });
    return result ?? null;
  });
  ipcMain.handle("jarvis:prepare-demo", async () => {
    // No argument to validate, which is the design rather than an omission: the
    // directory is computed in the runtime and nothing in this process can name one.
    const result = await requireClient().request({ type: "prepare_demo" });
    return result ?? null;
  });
  ipcMain.handle("jarvis:reset-demo", async () => {
    const result = await requireClient().request({ type: "reset_demo" });
    return result ?? null;
  });
  ipcMain.handle(
    "jarvis:set-tool-policy",
    async (_e, category: unknown, verdict: unknown) => {
      // Both sides checked against fixed sets before the request is formed. The
      // class list lives in the risk model and is not repeated here — an unknown
      // name is refused by the runtime with a reason, which is more useful to a
      // panel than a silent `null` from this process.
      if (typeof category !== "string" || !category) return null;
      if (
        verdict !== "auto" &&
        verdict !== "approval" &&
        verdict !== "deny" &&
        verdict !== "default"
      ) {
        return null;
      }
      const result = await requireClient().request({
        type: "set_tool_policy",
        category,
        verdict,
      });
      return result ?? null;
    },
  );
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
  // A `send`, not an `invoke`: opening a window returns nothing and the renderer
  // has nothing to wait for. It takes no arguments at all, so the untrusted side
  // cannot influence what is loaded — only that Mission Control is shown.
  ipcMain.on("jarvis:open-mission", () => openMissionWindow());
  ipcMain.on("jarvis:open-memory", () => openMemoryWindow());
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
    sendToRenderers("jarvis:event", { type: "status", status });
  } catch {
    setLinked(false);
    void reattachSoon();
  }
}

// --- misc ------------------------------------------------------------------

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A separate stream from the runtime's: two processes, two lifetimes, and
 * interleaving them would race on rotation. The shell's own failures — a
 * runtime that would not spawn, a pipe that would not authenticate — are
 * invisible in the packaged build without this.
 */
const logFile = openLogFile("shell");

function log(line: string): void {
  console.log(`[shell] ${line}`);
  logFile.write(`[shell] ${line}`);
}
