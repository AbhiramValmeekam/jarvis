/**
 * The renderer's view of the preload bridge.
 *
 * `window.jarvis` is optional on purpose: if the page is ever loaded outside
 * Electron the UI must degrade to "not connected" rather than throw on load.
 */
import type { UiBridge } from "../desktop/preload";

declare global {
  interface Window {
    jarvis?: UiBridge;
  }
}

export {};
