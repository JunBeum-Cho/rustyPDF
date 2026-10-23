import { createStore, produce } from "solid-js/store";
import type { Annotation, AnnotationTool } from "../annotations/types";

export interface PageMeta {
  index: number;
  /** Display dimensions after the PDF page's intrinsic rotation. */
  width: number; // PDF points (1pt = 1/72 inch)
  height: number;
  /** Intrinsic clockwise rotation persisted in the PDF's `/Rotate` entry. */
  rotation: 0 | 90 | 180 | 270;
}

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface AnnotationTabState {
  editVersion: number;
  items: Annotation[];
  selectedIds: string[];
  editingId: string | null;
  dirty: boolean;
  saveStatus: SaveStatus;
  saveError: string | null;
  lastSavedAt: string | null;
}

export const emptyAnnotationTabState = (): AnnotationTabState => ({
  editVersion: 0,
  items: [],
  selectedIds: [],
  editingId: null,
  dirty: false,
  saveStatus: "idle",
  saveError: null,
  lastSavedAt: null,
});

export interface PageEditSnapshot {
  items: Annotation[];
  selectedPageIndices: number[];
  pageAnchor: number | null;
  currentPage: number;
}

/** `items` is the annotation list before the edit. At most 80 entries per stack. */
export type DocumentHistoryEntry =
  | { kind: "annotation"; items: Annotation[] }
  | { kind: "page"; token: string; snapshot: PageEditSnapshot };

export interface Tab {
  editHistory?: DocumentHistoryEntry[];
  editFuture?: DocumentHistoryEntry[];
  tabId: string; // stable local id used for tab identity
  docId: string; // stable backend document handle
  revision: number; // backend generation; incremented by mutations/saves
  path: string;
  isUnsaved?: boolean; // generated in memory; first save asks for a path
  pageCount: number;
  pages: PageMeta[];
  fileSize: number;
  contentVersion: number; // bumps when saved bytes change without a new docId
  zoom: number;
  currentPage: number;
  navigationVersion: number;
  selectedPageIndices: number[]; // for thumbnail multi-select
  pageAnchor: number | null; // shift-click anchor
  pageDirty: boolean; // page-level edits not yet saved to disk
  annotations: AnnotationTabState;
  readOnly: boolean;
  readOnlyReason: "encrypted" | null;
  signed: boolean;
  formDirty: boolean;
}

export interface AnnotationUiState {
  tool: AnnotationTool;
  color: string;
  textColor: string;
  fill: string;
  strokeWidth: number;
  fontSize: number;
  fontFamily: string;
}

export interface DocumentState {
  tabs: Tab[];
  activeTabId: string | null;
  loading: boolean;
  error: string | null;
  annotationUi: AnnotationUiState;
}

const [documentStore, setDocumentStore] = createStore<DocumentState>({
  tabs: [],
  activeTabId: null,
  loading: false,
  error: null,
  annotationUi: {
    tool: "select",
    color: "#e11d48",
    textColor: "#000000",
    fill: "transparent",
    strokeWidth: 2,
    fontSize: 16,
    fontFamily: "Noto Sans KR",
  },
});

export { documentStore, setDocumentStore };

export const generateTabId = (): string => {
  if ("randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const findTabIndex = (tabId: string): number =>
  documentStore.tabs.findIndex((tab) => tab.tabId === tabId);

export const activeTab = (): Tab | null => {
  const id = documentStore.activeTabId;
  if (!id) return null;
  return documentStore.tabs.find((tab) => tab.tabId === id) ?? null;
};

export const activeTabIndex = (): number => {
  const id = documentStore.activeTabId;
  if (!id) return -1;
  return findTabIndex(id);
};

export const updateActiveTab = (mutator: (tab: Tab) => void) => {
  const idx = activeTabIndex();
  if (idx < 0) return;
  setDocumentStore("tabs", idx, produce(mutator));
};

export const updateTabById = (tabId: string, mutator: (tab: Tab) => void) => {
  const idx = findTabIndex(tabId);
  if (idx < 0) return;
  setDocumentStore("tabs", idx, produce(mutator));
};

export const setActiveTab = (tabId: string) => {
  if (findTabIndex(tabId) < 0) return;
  setDocumentStore("activeTabId", tabId);
};

export const fileNameFromPath = (path: string): string => {
  const seg = path.split(/[\\/]/);
  return seg[seg.length - 1] || path;
};
