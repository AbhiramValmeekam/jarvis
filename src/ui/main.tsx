/**
 * The renderer entry, for both windows.
 *
 * There is one HTML input in `electron.vite.config.ts`, so the windows are routes of
 * one bundle rather than separate builds: the HUD is the default, Mission Control is
 * `#/mission`, and Memory is `#/memory`. That means all of them get the same preload
 * bridge, the same CSP and the same security flags — one surface to audit instead of
 * three that drift.
 *
 * The hash is read once, at mount. No window navigates: main opens each one with the
 * hash already set, so there is nothing here to listen for and no router dependency
 * to add.
 */
import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import MissionControl from "./pages/MissionControl";
import Memory from "./pages/Memory";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

/** Exact match, not a prefix: an unknown hash is the HUD, never a blank window. */
function page(hash: string): ReactElement {
  switch (hash.replace(/^#/, "")) {
    case "/mission":
      return <MissionControl />;
    case "/memory":
      return <Memory />;
    default:
      return <App />;
  }
}

createRoot(root).render(<StrictMode>{page(window.location.hash)}</StrictMode>);
