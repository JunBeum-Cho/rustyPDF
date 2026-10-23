import { createEffect, onCleanup } from "solid-js";
import { invoke } from "../platform/desktop";
import { pdfEngine } from "../platform/pdf-engine";
import { registerPreMutationHook } from "../ipc/documentMutations";
import { invalidateOcrForDocument } from "../ocr/ocr";
import { activeTab, documentStore, updateTabById, type Tab } from "../state/document";
import { commitPageEditHistory, snapshotPageEdit } from "./documentHistoryState";
import { createLinkService } from "./pdfLinks";
import "./overlay.css";

export interface PdfAnnotationOverlayProps {
  docId: string;
  revision: number;
  pageIndex: number;
  scale: number;
}

const findTab = (docId: string) => documentStore.tabs.find((t) => t.docId === docId);

/** Tracks which loaded documents already have their dirty listener attached. */
const wired = new WeakSet<object>();

function wireDirty(doc: any, docId: string) {
  const storage = doc.annotationStorage;
  if (!storage || wired.has(storage)) return;
  wired.add(storage);
  storage.onSetModified = () => {
    const tab = findTab(docId);
    if (!tab) return;
    updateTabById(tab.tabId, (t) => {
      t.formDirty = true;
      t.pageDirty = true;
    });
  };
}

export async function flushFormChanges(tabId: string): Promise<void> {
  const tab = documentStore.tabs.find((t) => t.tabId === tabId);
  if (!tab || !tab.formDirty) return;
  const { docId, revision } = tab;
  const doc = await pdfEngine().getDocument(docId, revision);
  const bytes = await doc.saveDocument();
  const result = await invoke<{
    id: string;
    revision: number;
    pageCount: number;
    pages: Tab["pages"];
    fileSize: number;
    historyToken?: string;
    retainedHistoryTokens?: string[];
  }>("pdf_apply_form_bytes", { docId, expectedRevision: revision, bytes });
  const live = documentStore.tabs.find((t) => t.tabId === tabId);
  const before = live ? snapshotPageEdit(live) : null;
  updateTabById(tabId, (t) => {
    t.revision = result.revision;
    t.pageCount = result.pageCount;
    t.pages = result.pages;
    t.fileSize = result.fileSize;
    t.contentVersion += 1;
    t.formDirty = false;
    t.pageDirty = true;
  });
  if (before) commitPageEditHistory(tabId, before, result);
  invalidateOcrForDocument(docId, result.revision, result.pageCount);
}

registerPreMutationHook(flushFormChanges);

export function PdfAnnotationOverlay(props: PdfAnnotationOverlayProps) {
  let host!: HTMLDivElement;
  let generation = 0;

  const clear = () => host?.replaceChildren();

  createEffect(() => {
    const { docId, revision, pageIndex, scale } = props;
    const readOnly = findTab(docId)?.readOnly ?? activeTab()?.readOnly ?? false;
    const run = ++generation;
    void (async () => {
      try {
        const doc = await pdfEngine().getDocument(docId, revision);
        const page = await doc.getPage(pageIndex + 1);
        const annotations = await page.getAnnotations({ intent: "display" });
        if (run !== generation) return;
        wireDirty(doc, docId);
        const { AnnotationLayer } = await import("pdfjs-dist");
        if (run !== generation) return;
        const viewport = page.getViewport({ scale }).clone({ dontFlip: true });
        const div = document.createElement("div");
        div.className = "annotationLayer";
        div.style.setProperty("--scale-factor", String(scale));
        div.style.setProperty("--total-scale-factor", String(scale));
        const layer = new AnnotationLayer({
          div,
          page,
          viewport,
          accessibilityManager: null,
          annotationCanvasMap: null,
          annotationEditorUIManager: null,
          structTreeLayer: null,
          commentManager: null,
          linkService: createLinkService(doc) as any,
          annotationStorage: doc.annotationStorage,
        } as any);
        await layer.render({
          annotations,
          viewport,
          div,
          page,
          linkService: createLinkService(doc) as any,
          annotationStorage: doc.annotationStorage,
          renderForms: !readOnly,
        } as any);
        if (run !== generation) return;
        host.classList.toggle("readonly", readOnly);
        host.replaceChildren(div);
      } catch (error) {
        if (run === generation) clear();
        console.warn("annotation overlay failed", error);
      }
    })();
  });

  onCleanup(() => {
    generation++;
    clear();
  });

  return <div class="pdf-annotation-overlay" ref={host} />;
}
