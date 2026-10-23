import { createEffect, createRoot, createSignal, on } from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "../platform/desktop";
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

const [missingRecents, setMissingRecents] = createSignal<ReadonlySet<string>>(new Set());
export { missingRecents };

/** Ask the main process which recent paths no longer exist. */
export async function checkRecentPaths(): Promise<ReadonlySet<string>> {
  const paths = recentFiles.entries.map((e) => e.path);
  if (paths.length === 0) {
    setMissingRecents(() => new Set<string>());
    return missingRecents();
  }
  try {
    const result = await invoke<boolean[]>("paths_exist", { paths });
    const missing = new Set<string>();
    if (Array.isArray(result)) {
      paths.forEach((p, i) => {
        if (result[i] === false) missing.add(p);
      });
    }
    setMissingRecents(() => missing);
  } catch {
    /* keep previous state */
  }
  return missingRecents();
}

const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recentFiles));
  } catch {
    /* ignore quota issues */
  }
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
};

export const removeRecentFile = (path: string) => {
  setRecentFiles("entries", (prev) => prev.filter((e) => e.path !== path));
  persist();
};

export const clearRecentFiles = () => {
  setRecentFiles("entries", []);
  persist();
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
        () => documentStore.tabs.filter((t) => !t.isUnsaved).map((t) => t.path),
        (paths) => {
          const next = new Set(paths);
          for (const path of next) {
            if (!known.has(path)) recordRecentFile(path);
          }
          known = next;
        },
      ),
    );
  });
}
