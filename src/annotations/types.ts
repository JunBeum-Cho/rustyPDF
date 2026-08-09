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
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
  textAlign?: "left" | "center" | "right" | "justify";
}

/**
 * One visual line of a text annotation as the browser actually laid it out.
 * Produced at export time so the flattened PDF reuses the editor's own
 * wrapping, alignment and baselines instead of re-deriving them.
 *
 * `baseline` is in PDF points, measured downward from the top edge of the
 * annotation's content box.
 */
export interface TextLayoutLine {
  baseline: number;
  fragments: TextLayoutFragment[];
}

/** A run of characters that shares one line and one computed style. */
export interface TextLayoutFragment {
  text: string;
  /** Offset from the left edge of the annotation's content box, in points. */
  x: number;
  fontSize: number;
  /** `#rrggbb`. */
  color: string;
  fontFamily?: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export interface Annotation {
  id: string;
  page: number;
  type: AnnotationKind;
  rect?: Rect;
  points?: Point[];
  /**
   * Quarter-turn (clockwise, degrees) applied to this annotation's own
   * content inside `rect`. Page rotation accumulates here for the kinds that
   * carry an orientation — text and images — so a rotated page keeps its
   * photos upright-relative-to-the-page instead of squashing them into the
   * transposed bounding box. Shapes are fully described by their transformed
   * geometry and always stay at 0.
   */
  rotation?: 0 | 90 | 180 | 270;
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
    /**
     * Measured line layout. Attached only to the export payload — it is
     * derived from the live DOM and would go stale in the sidecar.
     */
    layout?: TextLayoutLine[];
  };
}

export interface AnnotationSidecar {
  /** v1 records are accepted only as exact-path migration input. */
  version: 1 | 2;
  documentKey?: string;
  sourcePath: string;
  /** Filled and verified by the backend when persisted. */
  pdfFingerprint?: string;
  documentRevision?: number;
  pageLayout?: Array<{
    width: number;
    height: number;
    rotation: 0 | 90 | 180 | 270;
  }>;
  updatedAt: string;
  annotations: Annotation[];
}
