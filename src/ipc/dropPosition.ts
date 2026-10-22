/** Legacy physical coordinate conversion for imported integrations. Desktop drops use CSS pixels. */
export const physicalDropToClient = (
  position: { x: number; y: number },
  pixelRatio: number,
): { x: number; y: number } => {
  const scale = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const logical = { x: position.x / scale, y: position.y / scale };
  return { x: logical.x, y: logical.y };
};
