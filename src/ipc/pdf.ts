import { ensureAnnotationFonts } from "../annotations/fonts";
import { ask, confirmUnsaved, invoke, listen, open, save } from "../platform/desktop";
import { pdfEngine } from "../platform/pdf-engine";
import { normalizeImageSource } from "../images/normalize";
import { emitToast } from "../capture/capture";
import { markAnnotationSaveErrorForTab, setAnnotationSaveStatusForTab } from "../annotations/store";
import { measureTextLayout } from "../annotations/textLayout";
import { sanitizeAnnotation } from "../annotations/sanitize";
import { includeOcrOnSave } from "../ocr/ocr";
import type { Annotation, AnnotationSidecar } from "../annotations/types";
import {
  activeTab,
  documentStore,
  emptyAnnotationTabState,
  fileNameFromPath,
  findTabIndex,
  generateTabId,
  setActiveTab,
  setDocumentStore,
  updateTabById,
  type PageMeta,
  type Tab,
} from "../state/document";
import { onCleanup, onMount } from "solid-js";
import { produce } from "solid-js/store";
import { enqueueDocumentMutation } from "./documentMutations";

export interface DocPayload {
  id: string;
  revision: number;
  path: string;
  pageCount: number;
  pages: PageMeta[];
  fileSize: number;
  readOnly: boolean;
  readOnlyReason: "encrypted" | null;
  signed: boolean;
}

export interface TabOptions {
  annotations?: Annotation[];
  unsaved?: boolean;
  dirty?: boolean;
}

interface OpenedDocPayload extends DocPayload {
  annotations?: Annotation[] | null;
  legacy?: { annotations: Annotation[]; message: string } | null;
}

export type DirtyChoice = "save" | "discard" | "cancel";

/** Result of a page edit command (pdf_delete_pages and friends). */
export interface PdfPageEditPayload extends DocPayload {
  /** Mapping[oldIdx] = newIdx | null for annotation remap. */
  pageMapping: Array<number | null>;
  historyToken?: string;
  retainedHistoryTokens: string[];
}

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SearchHit {
  page: number;
  start: number;
  length: number;
  snippet: string;
  space?: "raw" | "display";
  rectangles?: Array<{ x: number; y: number; w: number; h: number; space?: "raw" | "display" }>;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const READ_ONLY_SAVE_MESSAGE = "읽기 전용 PDF는 저장할 수 없습니다";
const SIGNED_MESSAGE =
  "전자 서명이 있는 PDF입니다. 저장하면 서명이 무효가 될 수 있습니다. 계속할까요?";
const LEGACY_MESSAGE =
  "이전 버전 주석을 불러왔습니다. 저장하면 PDF 안에 함께 저장됩니다.";
const RESTART_MESSAGE =
  "PDF 엔진이 다시 시작되어 저장하지 않은 페이지 편집이 취소되었습니다.";

const cleanAnnotations = (items: readonly Annotation[]): Annotation[] =>
  (JSON.parse(JSON.stringify(items)) as Annotation[]).map(sanitizeAnnotation);

const hasRealPath = (tab: Tab) => !tab.isUnsaved && !tab.path.startsWith("unsaved://");

/**
 * Sidecar for save, export and print: waits for fonts, attaches the measured
 * text layout and normalizes image sources. Store proxies are deep-copied so
 * the payload can cross the desktop bridge.
 */
export async function buildAnnotationPayload(tab: Tab): Promise<AnnotationSidecar> {
  await ensureAnnotationFonts();
  const annotations = cleanAnnotations(tab.annotations.items);
  for (const annotation of annotations) {
    if (annotation.type === "text") {
      const layout = measureTextLayout(annotation);
      if (layout && layout.length > 0) {
        annotation.payload = { ...(annotation.payload ?? {}), layout };
      }
    } else if (annotation.type === "image" && annotation.payload?.imageSrc) {
      annotation.payload.imageSrc = await normalizeImageSource(
        annotation.payload.imageSrc,
      );
    }
  }
  return {
    version: 2,
    sourcePath: tab.path,
    updatedAt: new Date().toISOString(),
    annotations,
  };
}

const buildTabFromPayload = (
  payload: DocPayload,
  options: TabOptions = {},
): Tab => {
  const tab: Tab = {
    tabId: generateTabId(),
    docId: payload.id,
    revision: payload.revision,
    path: payload.path,
    pageCount: payload.pageCount,
    pages: payload.pages,
    fileSize: payload.fileSize,
    contentVersion: 0,
    zoom: 1,
    currentPage: 0,
    navigationVersion: 0,
    selectedPageIndices: [],
    pageAnchor: null,
    pageDirty: Boolean(options.unsaved),
    annotations: emptyAnnotationTabState(),
    readOnly: payload.readOnly ?? false,
    readOnlyReason: payload.readOnlyReason ?? null,
    signed: payload.signed ?? false,
    formDirty: false,
  };
  if (options.unsaved) tab.isUnsaved = true;
  tab.annotations.items = cleanAnnotations(options.annotations ?? []);
  if (options.dirty) {
    tab.annotations.dirty = true;
    tab.annotations.editVersion = 1;
  }
  return tab;
};

/** Create and activate a tab for an opened or generated document. */
export function addDocumentTab(payload: DocPayload, options: TabOptions = {}): string {
  const tab = buildTabFromPayload(payload, options);
  setDocumentStore(
    produce((state) => {
      state.tabs.push(tab);
      state.activeTabId = tab.tabId;
    }),
  );
  return tab.tabId;
}

export async function openImagesAsPdf(paths: string[], name = "이미지"): Promise<void> {
  const payload = await invoke<DocPayload>("pdf_create_from_images", { paths, name });
  addDocumentTab(payload, { unsaved: true });
}

const draftOf = (items: readonly Annotation[]) => JSON.stringify(cleanAnnotations(items));

async function offerDraftRecovery(tabId: string, path: string): Promise<void> {
  try {
    const raw = await invoke<string | null>("draft_read", { path });
    if (!raw) return;
    const draft = JSON.parse(raw) as { savedAt?: string; annotations?: Annotation[] };
    if (!Array.isArray(draft.annotations)) return;
    const tab = documentStore.tabs.find((t) => t.tabId === tabId);
    if (!tab || tab.readOnly) return;
    const recovered = draftOf(draft.annotations);
    if (recovered === draftOf(tab.annotations.items)) return;
    emitToast("저장하지 않은 주석 초안이 있습니다.", "info", {
      timeoutMs: null,
      actions: [
        {
          label: "복구",
          run: () => {
            updateTabById(tabId, (current) => {
              current.annotations.items = JSON.parse(recovered) as Annotation[];
              current.annotations.selectedIds = [];
              current.annotations.editingId = null;
              current.annotations.editVersion += 1;
              current.annotations.dirty = true;
              current.annotations.saveStatus = "idle";
            });
          },
        },
      ],
    });
  } catch (error) {
    console.error("draft read failed", error);
  }
}

async function performOpenPdf(path: string): Promise<boolean> {
  setDocumentStore({ loading: true, error: null });
  try {
    const payload = await invoke<OpenedDocPayload>("pdf_open", { path });
    const existing = documentStore.tabs.find((t) => t.docId === payload.id);
    if (existing) {
      setActiveTab(existing.tabId);
      setDocumentStore({ loading: false });
      return true;
    }
    const legacy = payload.annotations == null ? payload.legacy ?? null : null;
    const tabId = addDocumentTab(payload, {
      annotations: payload.annotations ?? legacy?.annotations ?? [],
      dirty: Boolean(legacy),
    });
    setDocumentStore({ loading: false });
    if (legacy) emitToast(LEGACY_MESSAGE, "info", { timeoutMs: 9000 });
    if (!payload.readOnly) await offerDraftRecovery(tabId, payload.path);
    return true;
  } catch (e) {
    const message = errorMessage(e);
    setDocumentStore({ loading: false, error: message });
    emitToast(`PDF 열기 실패: ${message}`, "error");
    return false;
  }
}

// File-drop, OS-open, and dialog events can arrive together. Serializing the
// open flow keeps two calls from racing past the "already open" check.
let openTail: Promise<void> = Promise.resolve();

/**
 * Open a PDF as a tab, or activate the tab that already holds the same
 * document. Resolves false (after toasting the failure) when opening failed.
 */
export function openPdf(path: string): Promise<boolean> {
  const operation = openTail.then(() => performOpenPdf(path));
  openTail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export async function openPdfDialog(): Promise<void> {
  let selected: string | string[] | null;
  try {
    selected = await open({
      multiple: true,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
  } catch (error) {
    const message = errorMessage(error);
    console.error("open pdf dialog failed", error);
    setDocumentStore({ loading: false, error: message });
    emitToast(`파일 선택 창을 열 수 없습니다: ${message}`, "error");
    return;
  }
  if (Array.isArray(selected)) {
    for (const path of selected) await openPdf(path);
  } else if (typeof selected === "string") {
    await openPdf(selected);
  }
}

export async function closePdf(docId: string): Promise<void> {
  await invoke("pdf_close", { docId });
}

export async function deleteDraft(path: string): Promise<void> {
  if (path.startsWith("unsaved://")) return;
  try {
    await invoke("draft_delete", { path });
  } catch (error) {
    console.error("draft delete failed", error);
  }
}

async function performCloseTab(tabId: string): Promise<void> {
  const idx = findTabIndex(tabId);
  if (idx < 0) return;
  const tab = documentStore.tabs[idx];

  if (tab.annotations.dirty || tab.pageDirty || tab.formDirty) {
    const choice = await confirmUnsaved(
      `${fileNameFromPath(tab.path)}에 저장되지 않은 변경사항이 있습니다. 저장하시겠습니까?`,
    );
    if (choice === "cancel") return;
    if (choice === "save") {
      const saved = await performSaveTabUntilClean(tab.tabId);
      if (!saved) {
        const force = await ask("저장에 실패했습니다. 그래도 닫으시겠습니까?");
        if (!force) return;
      }
    } else {
      await deleteDraft(tab.path);
    }
  }

  try {
    await closePdf(tab.docId);
  } catch (error) {
    console.error("backend close failed", error);
  }

  setDocumentStore(
    produce((state) => {
      const removeIdx = state.tabs.findIndex((t) => t.tabId === tabId);
      if (removeIdx < 0) return;
      state.tabs.splice(removeIdx, 1);
      if (state.activeTabId === tabId) {
        const next = state.tabs[Math.min(removeIdx, state.tabs.length - 1)];
        state.activeTabId = next ? next.tabId : null;
      }
    }),
  );
}

export function closeTab(tabId: string): Promise<void> {
  return enqueueDocumentMutation(tabId, () => performCloseTab(tabId));
}

export async function initialOpenPaths(): Promise<string[]> {
  return await invoke<string[]>("initial_open_paths");
}

export async function exportAnnotatedPdfFile(): Promise<void> {
  const selectedTab = activeTab();
  if (!selectedTab) return;
  const tabId = selectedTab.tabId;
  if (selectedTab.readOnly) {
    emitToast(READ_ONLY_SAVE_MESSAGE, "error");
    return;
  }

  const target = await save({
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    defaultPath: selectedTab.isUnsaved
      ? fileNameFromPath(selectedTab.path)
      : selectedTab.path.replace(/\.pdf$/i, ".annotated.pdf"),
  });
  if (!target) return;
  if (documentStore.tabs.some((candidate) => candidate.path === target)) {
    emitToast("열려 있는 PDF에는 내보낼 수 없습니다. 원본과 다른 경로를 선택해 주세요.", "error");
    return;
  }

  try {
    await enqueueDocumentMutation(tabId, async () => {
      const tab = documentStore.tabs.find((candidate) => candidate.tabId === tabId);
      if (!tab) return;
      const data = await buildAnnotationPayload(tab);
      await invoke("export_annotated_pdf", {
        docId: tab.docId,
        expectedRevision: tab.revision,
        targetPath: target,
        data,
      });
    });
    emitToast("주석을 포함한 PDF로 내보냈습니다", "info");
  } catch (error) {
    console.error("export annotated pdf failed", error);
    emitToast(`내보내기 실패: ${errorMessage(error)}`, "error");
  }
}

const pageEdit = (
  command: string,
  docId: string,
  expectedRevision: number,
  extra: Record<string, unknown>,
) => invoke<PdfPageEditPayload>(command, { docId, expectedRevision, ...extra });

export const deletePdfPages = (docId: string, expectedRevision: number, indices: number[]) =>
  pageEdit("pdf_delete_pages", docId, expectedRevision, { indices });

export const duplicatePdfPages = (docId: string, expectedRevision: number, indices: number[]) =>
  pageEdit("pdf_duplicate_pages", docId, expectedRevision, { indices });

export const rotatePdfPages = (
  docId: string,
  expectedRevision: number,
  indices: number[],
  direction: 1 | -1,
) => pageEdit("pdf_rotate_pages", docId, expectedRevision, { indices, direction });

export const pastePdfPages = (
  docId: string,
  expectedRevision: number,
  afterIndex: number,
  clipboardId: string,
) => pageEdit("pdf_paste_pages", docId, expectedRevision, { afterIndex, clipboardId });

export async function copyPdfPages(
  docId: string,
  expectedRevision: number,
  indices: number[],
): Promise<string> {
  return await invoke<string>("pdf_copy_pages", { docId, expectedRevision, indices });
}

const signedConfirmed = new Set<string>();

async function performSaveTabPdf(tabId: string, asNew = false): Promise<boolean> {
  const idx = findTabIndex(tabId);
  if (idx < 0) return false;

  const currentTab = documentStore.tabs[idx];
  if (currentTab.readOnly) {
    emitToast(READ_ONLY_SAVE_MESSAGE, "error");
    return false;
  }
  if (currentTab.signed && !signedConfirmed.has(tabId)) {
    if (!(await ask(SIGNED_MESSAGE))) return false;
    signedConfirmed.add(tabId);
  }
  let target = currentTab.path;
  if (asNew || currentTab.isUnsaved) {
    const chosen = await save({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      defaultPath: currentTab.isUnsaved
        ? fileNameFromPath(currentTab.path)
        : currentTab.path,
    });
    if (!chosen) return false;
    if (documentStore.tabs.some((c) => c.tabId !== tabId && c.path === chosen)) {
      emitToast("선택한 파일은 다른 탭에서 열려 있습니다. 다른 경로를 선택해 주세요.", "error");
      return false;
    }
    target = chosen;
  }

  const previousPath = currentTab.path;
  try {
    // The save dialog yields to the UI; reacquire by stable tab identity.
    const liveIdx = findTabIndex(tabId);
    if (liveIdx < 0) return false;
    const tab = documentStore.tabs[liveIdx];
    const savedAt = new Date().toISOString();
    const bytesChanged = tab.pageDirty || tab.formDirty || target !== tab.path;
    if (tab.annotations.dirty) setAnnotationSaveStatusForTab(tab.tabId, "saving");

    const savedVersion = tab.annotations.editVersion;
    const annotations = await buildAnnotationPayload(tab);
    annotations.sourcePath = target;
    const saved = await invoke<DocPayload>("pdf_save_document", {
      docId: tab.docId,
      expectedRevision: tab.revision,
      targetPath: target,
      annotations,
      includeOcr: includeOcrOnSave(),
    });

    setDocumentStore(
      produce((state) => {
        const live = state.tabs.find((t) => t.tabId === tabId);
        if (!live) return;
        // Keep `pages` identity when the layout is unchanged so <For> does not
        // remount every PageCanvas.
        const layoutChanged =
          live.pages.length !== saved.pages.length ||
          live.pages.some(
            (p, i) =>
              p.width !== saved.pages[i].width ||
              p.height !== saved.pages[i].height ||
              p.rotation !== saved.pages[i].rotation,
          );
        live.docId = saved.id;
        live.revision = saved.revision;
        live.path = saved.path;
        live.isUnsaved = false;
        live.pageCount = saved.pageCount;
        if (layoutChanged) live.pages = saved.pages;
        live.fileSize = saved.fileSize;
        live.readOnly = saved.readOnly ?? live.readOnly;
        live.readOnlyReason = saved.readOnlyReason ?? live.readOnlyReason;
        live.signed = saved.signed ?? live.signed;
        if (bytesChanged) live.contentVersion += 1;
        live.pageDirty = false;
        live.formDirty = false;
        live.annotations.saveError = null;
        live.annotations.lastSavedAt = savedAt;
        if (live.annotations.editVersion === savedVersion) {
          live.annotations.dirty = false;
          live.annotations.saveStatus = "saved";
        } else {
          // Edits arrived during the round-trip; the draft autosave keeps them.
          live.annotations.saveStatus = "idle";
        }
      }),
    );
    const after = documentStore.tabs.find((t) => t.tabId === tabId);
    if (after && !after.annotations.dirty) {
      await deleteDraft(previousPath);
      if (after.path !== previousPath) await deleteDraft(after.path);
    }
  } catch (error) {
    console.error("save pdf failed", error);
    const message = errorMessage(error);
    const failedTab = documentStore.tabs.find((tab) => tab.tabId === tabId);
    if (failedTab?.annotations.dirty) markAnnotationSaveErrorForTab(tabId, message);
    emitToast(`저장 실패: ${message}`, "error");
    return false;
  }
  return true;
}

export function saveTabPdf(tabId: string, asNew = false): Promise<boolean> {
  return enqueueDocumentMutation(tabId, () => performSaveTabPdf(tabId, asNew));
}

/** Save the active tab; `asNew` prompts for a target path. */
export async function saveActivePdf(asNew = false): Promise<boolean> {
  const tab = activeTab();
  if (!tab) return false;
  return await saveTabPdf(tab.tabId, asNew);
}

async function performSaveTabUntilClean(tabId: string, maxAttempts = 3): Promise<boolean> {
  const isClean = (tab: Tab) => !tab.pageDirty && !tab.formDirty && !tab.annotations.dirty;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = documentStore.tabs.find((tab) => tab.tabId === tabId);
    if (!current) return false;
    if (isClean(current)) return true;
    if (!(await performSaveTabPdf(tabId, false))) return false;
  }
  const current = documentStore.tabs.find((tab) => tab.tabId === tabId);
  return Boolean(current && isClean(current));
}

/** Save a tab and reflush edits that arrived during the previous round-trip. */
export function saveTabPdfUntilClean(tabId: string): Promise<boolean> {
  return enqueueDocumentMutation(tabId, () => performSaveTabUntilClean(tabId));
}

/**
 * Re-open a tab's file from disk. `keepAnnotations` keeps the tab's in-memory
 * annotations (service restart); otherwise they come from the file.
 */
async function reopenTab(tabId: string, keepAnnotations: boolean, closeOld: boolean): Promise<void> {
  const tab = documentStore.tabs.find((t) => t.tabId === tabId);
  if (!tab || !hasRealPath(tab)) return;
  const oldDocId = tab.docId;
  const payload = await invoke<OpenedDocPayload>("pdf_open", { path: tab.path });
  const fresh = keepAnnotations
    ? null
    : cleanAnnotations(payload.annotations ?? payload.legacy?.annotations ?? []);
  try {
    pdfEngine().close(oldDocId);
  } catch {
    /* engine may not be initialised */
  }
  updateTabById(tabId, (live) => {
    live.docId = payload.id;
    live.revision = payload.revision;
    live.path = payload.path;
    live.pageCount = payload.pageCount;
    live.pages = payload.pages;
    live.fileSize = payload.fileSize;
    live.readOnly = payload.readOnly;
    live.readOnlyReason = payload.readOnlyReason;
    live.signed = payload.signed;
    live.contentVersion += 1;
    live.pageDirty = false;
    live.formDirty = false;
    live.selectedPageIndices = [];
    live.pageAnchor = null;
    live.currentPage = Math.min(live.currentPage, Math.max(0, payload.pageCount - 1));
    live.editHistory = [];
    live.editFuture = [];
    if (fresh) {
      live.annotations.items = fresh;
      live.annotations.selectedIds = [];
      live.annotations.editingId = null;
      live.annotations.editVersion += 1;
      live.annotations.dirty = false;
      live.annotations.saveStatus = "idle";
      live.annotations.saveError = null;
    }
  });
  if (closeOld && oldDocId !== payload.id) {
    try {
      await closePdf(oldDocId);
    } catch (error) {
      console.error("old document close failed", error);
    }
  }
}

async function handleServiceRestarted(): Promise<void> {
  const tabs = documentStore.tabs.filter(hasRealPath);
  for (const tab of tabs) {
    try {
      await enqueueDocumentMutation(tab.tabId, () => reopenTab(tab.tabId, true, false));
    } catch (error) {
      console.error("reopen after restart failed", tab.path, error);
      emitToast(`PDF를 다시 열 수 없습니다: ${fileNameFromPath(tab.path)}`, "error");
    }
  }
  emitToast(RESTART_MESSAGE, "info", { timeoutMs: 9000 });
}

function handleChangedOnDisk(docId: string): void {
  const tab = documentStore.tabs.find((t) => t.docId === docId);
  if (!tab || !hasRealPath(tab)) return;
  const tabId = tab.tabId;
  const dirty = tab.annotations.dirty || tab.pageDirty || tab.formDirty;
  emitToast(
    `${fileNameFromPath(tab.path)} 파일이 다른 프로그램에서 변경되었습니다.`,
    "info",
    {
      timeoutMs: null,
      actions: [
        {
          label: dirty ? "변경 사항 버리고 다시 불러오기" : "다시 불러오기",
          run: async () => {
            try {
              await enqueueDocumentMutation(tabId, () => reopenTab(tabId, false, true));
              await deleteDraft(tab.path);
            } catch (error) {
              emitToast(`다시 불러오기 실패: ${errorMessage(error)}`, "error");
            }
          },
        },
      ],
    },
  );
}

/** Subscribe to service-restart and disk-change events; returns the cleanup. */
export function attachDocumentEventHandlers(): () => void {
  let disposed = false;
  const unlisteners: Array<() => void> = [];
  const track = (promise: Promise<() => void>) =>
    promise.then(
      (unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      },
      (error) => console.error("install document event handlers failed", error),
    );
  void track(listen<unknown>("pdf-service-restarted", () => void handleServiceRestarted()));
  void track(
    listen<{ docId: string }>("document-changed-on-disk", (event) =>
      handleChangedOnDisk(event.payload.docId),
    ),
  );
  return () => {
    disposed = true;
    for (const unlisten of unlisteners.splice(0)) unlisten();
  };
}

export function installDocumentEventHandlers(): void {
  onMount(() => onCleanup(attachDocumentEventHandlers()));
}
