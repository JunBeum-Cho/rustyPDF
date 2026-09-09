import { PhysicalPosition } from "@tauri-apps/api/dpi";

/** Tauri reports physical pixels; DOM hit tests use this WebView's CSS pixels. */
export const physicalDropToClient = (
  position: { x: number; y: number },
  pixelRatio: number,
): { x: number; y: number } => {
  const scale = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const logical = new PhysicalPosition(position).toLogical(scale);
  return { x: logical.x, y: logical.y };
};
