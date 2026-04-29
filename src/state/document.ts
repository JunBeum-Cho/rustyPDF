import { createStore } from "solid-js/store";

export interface PageMeta {
  index: number;
  width: number; // PDF points (1pt = 1/72 inch)
  height: number;
}

export type PrefetchPolicy = "all" | "lazy";

export interface OpenDocument {
  id: string; // backend handle
  path: string;
  pageCount: number;
  pages: PageMeta[];
  fileSize: number;
  prefetchPolicy: PrefetchPolicy;
}

export interface DocumentState {
  doc: OpenDocument | null;
  zoom: number; // 1 = 100%
  rotation: 0 | 90 | 180 | 270;
  currentPage: number; // 0-indexed
  loading: boolean;
  error: string | null;
}

const [documentStore, setDocumentStore] = createStore<DocumentState>({
  doc: null,
  zoom: 1,
  rotation: 0,
  currentPage: 0,
  loading: false,
  error: null,
});

export { documentStore, setDocumentStore };
