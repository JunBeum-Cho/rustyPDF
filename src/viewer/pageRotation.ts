import { snapshotPageEdit, commitPageEditHistory } from "./documentHistoryState";
import { emitToast } from "../capture/capture";
import {
  addQuarterTurn,
  pagePointToDisplay,
  rectToDisplayBox,
} from "../annotations/coords";
import { invoke } from "../platform/desktop";
import { enqueueDocumentMutation } from "../ipc/documentMutations";
import { invalidateOcrForDocument } from "../ocr/ocr";
import {
  activeTab,
  documentStore,
  updateTabById,
  type PageMeta,
  type Tab,
} from "../state/document";

interface RotateResult {
  id: string;
  revision: number;
  path: string;
  pageCount: number;
  pages: PageMeta[];
  fileSize: number;
}

/** Selected pages, else the current page. */
const targetPages = (tab: Tab): number[] => {
  const selected = [...new Set(tab.selectedPageIndices)]
    .filter((i) => i >= 0 && i < tab.pageCount)
    .sort((a, b) => a - b);
  return selected.length > 0 ? selected : [tab.currentPage];
};

const clonePages = (pages: PageMeta[]): PageMeta[] =>
  pages.map((page) => ({ ...page }));

async function performRotation(
  tabId: string,
  direction: 1 | -1,
): Promise<void> {
  const tab = documentStore.tabs.find((candidate) => candidate.tabId === tabId);
  if (!tab || tab.pageCount === 0) return;

  // Read the latest state when this queued turn starts. Fast repeated clicks
  // therefore become 90° + 90° instead of racing two mutations against the
  // same old dimensions.
  if (tab.readOnly) {
    emitToast("읽기 전용 PDF입니다", "info");
    return;
  }
  const oldPages = clonePages(tab.pages);
  const indices = targetPages(tab);
  const targetSet = new Set(indices);
  const expectedDocId = tab.docId;
  const expectedRevision = tab.revision;
  const result = await invoke<RotateResult>("pdf_rotate_pages", {
    docId: expectedDocId,
    expectedRevision,
    indices,
    direction,
  });
  const live = documentStore.tabs.find(
    (candidate) => candidate.tabId === tabId,
  );
  if (
    !live ||
    live.docId !== expectedDocId ||
    live.revision !== expectedRevision ||
    result.id !== expectedDocId ||
    result.revision !== expectedRevision + 1
  ) {
    throw new Error(
      "문서가 회전 응답을 기다리는 동안 변경되어 결과를 적용하지 않았습니다.",
    );
  }
  const before = snapshotPageEdit(live);
  const geometryRotation = direction === 1 ? 90 : 270;
  invalidateOcrForDocument(expectedDocId, result.revision, result.pageCount);

  updateTabById(tabId, (current) => {
    let transformedAnnotations = false;
    for (const annotation of current.annotations.items) {
      if (!targetSet.has(annotation.page)) continue;
      const oldPage = oldPages[annotation.page];
      if (!oldPage) continue;
      transformedAnnotations = true;
      if (annotation.rect) {
        annotation.rect = rectToDisplayBox(
          annotation.rect,
          oldPage,
          1,
          geometryRotation,
        );
      }
      if (annotation.quads) {
        annotation.quads = annotation.quads.map((quad) =>
          rectToDisplayBox(quad, oldPage, 1, geometryRotation),
        );
      }
      if (annotation.points) {
        annotation.points = annotation.points.map((point) =>
          pagePointToDisplay(point, oldPage, 1, geometryRotation),
        );
      }
      // Turning the bounding box is enough for shapes — a rotated rectangle
      // is still a rectangle, and pen/line geometry is carried point by
      // point. Text and images have an orientation of their own, so without
      // this they'd be squashed into the transposed box instead of rotating
      // with the page.
      if (annotation.type === "text" || annotation.type === "image") {
        annotation.rotation = addQuarterTurn(
          annotation.rotation,
          geometryRotation,
        );
      }
    }

    current.docId = result.id;
    current.revision = result.revision;
    current.path = result.path;
    current.pageCount = result.pageCount;
    current.pages = result.pages.map((page) => ({ ...page }));
    current.fileSize = result.fileSize;
    current.contentVersion += 1;
    current.pageDirty = true;

    if (transformedAnnotations) {
      current.annotations.editingId = null;
      current.annotations.editVersion += 1;
      current.annotations.dirty = true;
      current.annotations.saveStatus = "idle";
      current.annotations.saveError = null;
    }
  });
  commitPageEditHistory(tabId, before, result);
}

/** Persistently rotate the selected pages (else the current page) one quarter-turn. */
export function rotateSelectedPages(direction: 1 | -1): Promise<void> {
  const tab = activeTab();
  if (!tab) return Promise.resolve();

  const tabId = tab.tabId;
  return enqueueDocumentMutation(tabId, () =>
    performRotation(tabId, direction),
  ).catch((error) => {
    console.error("rotate pages failed", error);
    emitToast(
      `페이지 회전 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
