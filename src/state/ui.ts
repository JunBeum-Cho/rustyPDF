import { createEffect, createRoot } from "solid-js";
import { createStore } from "solid-js/store";

export type Theme = "auto" | "light" | "dark";

export interface UiState {
  theme: Theme;
  sidebarOpen: boolean;
  sidebarWidth: number;
  searchOpen: boolean;
}

export const SIDEBAR_MIN_WIDTH = 110;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 168;

const STORAGE_KEY = "rustpdf.ui";

const defaults: UiState = {
  theme: "auto",
  sidebarOpen: false,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  searchOpen: false,
};

export const clampSidebarWidth = (value: number) =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));

function loadInitial(): UiState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const merged = { ...defaults, ...JSON.parse(raw) };
      merged.sidebarWidth = clampSidebarWidth(
        Number(merged.sidebarWidth) || SIDEBAR_DEFAULT_WIDTH,
      );
      return merged;
    }
  } catch {
    /* ignore */
  }
  return defaults;
}

const [uiStore, setUiStore] = createStore<UiState>(loadInitial());

// Persist whenever any field changes. Solid's reactivity runs this on every
// tracked field touch.
createRoot(() => {
  createEffect(() => {
    const snapshot = JSON.stringify({
      theme: uiStore.theme,
      sidebarOpen: uiStore.sidebarOpen,
      sidebarWidth: uiStore.sidebarWidth,
      searchOpen: uiStore.searchOpen,
    });
    try {
      localStorage.setItem(STORAGE_KEY, snapshot);
    } catch {
      /* ignore */
    }
  });
});

export { uiStore, setUiStore };

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "auto") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
}
