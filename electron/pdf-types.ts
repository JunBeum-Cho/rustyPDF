export interface PageMeta {
  index: number;
  width: number;
  height: number;
  rotation: number;
}
export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface OcrPage {
  text: string;
  lines: OcrLine[];
}
export interface DocumentState {
  id: string;
  path: string;
  revision: number;
  bytes: Uint8Array;
  diskFingerprint: string;
  pages: PageMeta[];
  ocr: Map<number, OcrPage>;
  ocrDirty: boolean;
  history: Map<string, { bytes: Uint8Array; pages: PageMeta[] }>;
  pendingRestore?: { id: string; token: string; previous: {bytes: Uint8Array; pages: PageMeta[]}; target: {bytes: Uint8Array; pages: PageMeta[]} };
}
