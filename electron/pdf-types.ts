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
export interface HistoryEntry {
  bytes: Uint8Array;
  pages: PageMeta[];
  ocr: Map<number, OcrPage>;
}
export interface DocumentState {
  id: string;
  path: string;
  revision: number;
  /** Base bytes: RustyPDF annotations stripped (original bytes when read-only). */
  bytes: Uint8Array;
  diskFingerprint: string;
  pages: PageMeta[];
  ocr: Map<number, OcrPage>;
  ocrDirty: boolean;
  history: Map<string, HistoryEntry>;
  readOnly: boolean;
  readOnlyReason: "encrypted" | null;
  signed: boolean;
}
export interface PdfServiceOptions {
  dataDir: string;
  legacyDataDirs?: string[];
  assetsDir?: string;
  fontsDir?: string;
}
export type PdfServiceEmit = (event: string, payload: unknown) => void;
