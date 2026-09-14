import { OPEN_ROUTER_SPEND_WINDOWS, type OpenRouterSpendWindow } from "../shared/openrouter-usage";

const STORAGE_KEY = "all-my-friends-are-agents-openrouter-spend-window";
const DEFAULT_WINDOW: OpenRouterSpendWindow = "24h";
const VALID_WINDOWS = new Set<OpenRouterSpendWindow>(OPEN_ROUTER_SPEND_WINDOWS);

export function loadOpenRouterSpendWindow(storage: Pick<Storage, "getItem"> | undefined): OpenRouterSpendWindow {
  if (!storage) return DEFAULT_WINDOW;
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) || "null") as { version?: unknown; window?: unknown } | null;
    return value?.version === 1 && VALID_WINDOWS.has(value.window as OpenRouterSpendWindow) ? value.window as OpenRouterSpendWindow : DEFAULT_WINDOW;
  } catch {
    return DEFAULT_WINDOW;
  }
}

export function saveOpenRouterSpendWindow(storage: Pick<Storage, "setItem"> | undefined, window: OpenRouterSpendWindow) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, window }));
  } catch {
    // A blocked or full localStorage should not make the page unusable.
  }
}

/** `window.localStorage` itself can throw (private-browsing quirks, locked-down embeds) even before any read/write. */
export function safeLocalStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
