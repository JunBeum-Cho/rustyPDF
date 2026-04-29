export type AnnotationKind =
  | "text"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "pen"
  | "highlight"
  | "image";

export type AnnotationTool = "select" | AnnotationKind | "capture";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnnotationStyle {
  color: string;
  width: number;
  fill?: string;
  opacity?: number;
  fontSize?: number;
}

export interface Annotation {
  id: string;
  page: number;
  type: AnnotationKind;
  rect?: Rect;
  points?: Point[];
  style: AnnotationStyle;
  payload?: {
    /** Plain text (legacy / fallback when html absent). */
    text?: string;
    /** Rich-text HTML for text annotations. Sanitized on commit. */
    html?: string;
    /** Data URL (or asset URL) for image annotations. */
    imageSrc?: string;
    /** Original pixel dimensions, used for default aspect ratio on insert. */
    imageNaturalWidth?: number;
    imageNaturalHeight?: number;
  };
}

export interface AnnotationSidecar {
  version: 1;
  sourcePath: string;
  updatedAt: string;
  annotations: Annotation[];
}
