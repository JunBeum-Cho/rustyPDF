import { createSignal } from "solid-js";

export const [imageImportOpen, setImageImportOpen] = createSignal(false);
export const [imagePaths, setImagePaths] = createSignal<string[]>([]);
export const [imageImportBusy, setImageImportBusy] = createSignal(false);
export const [imageImportError, setImageImportError] = createSignal("");

export function addImagePaths(paths: string[]) {
  if (imageImportBusy()) return;
  const supported = paths.filter(path => /\.(png|jpe?g)$/i.test(path));
  const next = [...new Set([...imagePaths(), ...supported])];
  if (next.length > 100) {
    setImageImportError("최대 100장까지 추가할 수 있습니다.");
    return;
  }
  setImagePaths(next);
  setImageImportError(supported.length === paths.length ? "" : "PNG 또는 JPG 이미지 파일만 추가할 수 있습니다. 지원하지 않는 파일은 제외했습니다.");
}

export function openImageImport(paths: string[] = []) {
  setImageImportOpen(true);
  addImagePaths(paths);
}

export function moveImage(index: number, delta: -1 | 1) {
  const next = [...imagePaths()];
  const target = index + delta;
  if (imageImportBusy() || target < 0 || target >= next.length) return;
  [next[index], next[target]] = [next[target], next[index]];
  setImagePaths(next);
}
