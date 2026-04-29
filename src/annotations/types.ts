export type AnnotationKind =
  | "text"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "pen"
  | "highlight";

export type AnnotationTool = "select" | AnnotationKind;

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
    text?: string;
  };
}

export interface AnnotationSidecar {
  version: 1;
  sourcePath: string;
  updatedAt: string;
  annotations: Annotation[];
}
