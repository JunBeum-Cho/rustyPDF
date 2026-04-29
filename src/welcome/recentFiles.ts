import { createEffect, createRoot, on } from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { documentStore, fileNameFromPath } from "../state/document";

const STORAGE_KEY = "rustpdf.recents";
const MAX_RECENTS = 24;

export interface RecentEntry {
  path: string;
  name: string;
  /** ISO timestamp of most recent open. */
  openedAt: string;
}

interface RecentsState {
  entries: RecentEntry[];
}

const loadInitial = (): RecentsState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { entries: [] };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.entries)) return { entries: [] };
    return {
      entries: parsed.entries
        .filter(
          (e: unknown): e is RecentEntry =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as RecentEntry).path === "string",
        )
        .slice(0, MAX_RECENTS),
    };
  } catch {
    return { entries: [] };
  }
};

const [recentFiles, setRecentFiles] = createStore<RecentsState>(loadInitial());

export { recentFiles };

const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recentFiles));
  } catch {
    /* ignore quota issues */
  }
};

const syncDockMenu = () => {
  const entries = recentFiles.entries.slice(0, 10);
  const paths = entries.map((e) => e.path);
  const names = entries.map((e) => e.name);
  void invoke("set_dock_recents", { paths, names }).catch(() => {
    /* ignore — non-critical (no-op on non-mac platforms) */
  });
};

export const recordRecentFile = (path: string) => {
  const name = fileNameFromPath(path);
  const openedAt = new Date().toISOString();
  setRecentFiles("entries", (prev) => {
    const filtered = prev.filter((entry) => entry.path !== path);
    const next = [{ path, name, openedAt }, ...filtered];
    return next.slice(0, MAX_RECENTS);
  });
  persist();
  // Best-effort native OS recents (macOS Dock right-click, Windows Jump List).
  void invoke("note_recent_document", { path }).catch(() => {
    /* ignore */
  });
  // Rebuild the dock-tile recents submenu — we have to do this manually for
  // non-document-based apps (which Tauri is).
  syncDockMenu();
};

export const removeRecentFile = (path: string) => {
  setRecentFiles("entries", (prev) => prev.filter((e) => e.path !== path));
  persist();
  syncDockMenu();
};

export const clearRecentFiles = () => {
  setRecentFiles("entries", []);
  persist();
  syncDockMenu();
};

/**
 * Auto-track tab opens by watching `documentStore.tabs`. Whenever a new tab
 * appears, add its path to the recents list. Closing tabs leaves recents
 * intact — the file is still "recently used."
 */
export function installRecentFilesTracking() {
  createRoot(() => {
    let known = new Set<string>();
    createEffect(
      on(
        () => documentStore.tabs.map((t) => t.path),
        (paths) => {
          const next = new Set(paths);
          for (const path of next) {
            if (!known.has(path)) recordRecentFile(path);
          }
          known = next;
        },
      ),
    );
    // Push the dock menu once at startup so the previously-saved recents
    // are visible without requiring the user to open another file first.
    queueMicrotask(syncDockMenu);
  });
}
