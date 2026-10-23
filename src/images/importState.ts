import { createSignal } from "solid-js";

export const [imageImportOpen, setImageImportOpen] = createSignal(false);
export const [imagePaths, setImagePaths] = createSignal<string[]>([]);
export const [imageImportBusy, setImageImportBusy] = createSignal(false);
export const [imageImportError, setImageImportError] = createSignal("");

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "heic", "heif", "webp", "gif", "bmp", "tif", "tiff"];
export const MAX_IMAGES = 100;
export const isSupportedImage = (path: string) => IMAGE_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase() ?? "") && path.includes(".");

export function addImagePaths(paths: string[]) {
  if (imageImportBusy()) return;
  const supported = paths.filter(path => isSupportedImage(path));
  const next = [...new Set([...imagePaths(), ...supported])];
  if (next.length > MAX_IMAGES) {
    setImageImportError("최대 100장까지 추가할 수 있습니다.");
    return;
  }
  setImagePaths(next);
  setImageImportError(supported.length === paths.length ? "" : `지원하는 형식(${IMAGE_EXTENSIONS.map(e => e.toUpperCase()).join(", ")})만 추가할 수 있습니다. 지원하지 않는 파일은 제외했습니다.`);
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

export function moveImageTo(from: number, to: number) {
  const next = [...imagePaths()];
  if (imageImportBusy() || from === to || from < 0 || from >= next.length || to < 0 || to >= next.length) return;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  setImagePaths(next);
}

/** Tracks created object URLs per key so each one is revoked exactly once. */
export function createUrlRegistry(create: (blob: Blob) => string, revoke: (url: string) => void) {
  const urls = new Map<string, string>();
  return {
    add(key: string, blob: Blob) { this.remove(key); const url = create(blob); urls.set(key, url); return url; },
    get: (key: string) => urls.get(key),
    remove(key: string) { const url = urls.get(key); if (url !== undefined) { revoke(url); urls.delete(key); } },
    clear() { for (const url of urls.values()) revoke(url); urls.clear(); },
    keys: () => [...urls.keys()],
    get size() { return urls.size; },
  };
}
