import { createSignal, For, onCleanup, Show } from "solid-js";
import { open, readFile } from "../platform/desktop";
import { activeTab } from "../state/document";

export const SIGNATURE_STORAGE_KEY = "rustpdf.signatures";
export const MAX_SIGNATURES = 5;

export interface SignatureStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const defaultStorage = (): SignatureStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadSignatures(storage: SignatureStorage | null = defaultStorage()): string[] {
  try {
    const parsed = JSON.parse(storage?.getItem(SIGNATURE_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string").slice(0, MAX_SIGNATURES)
      : [];
  } catch {
    return [];
  }
}

const persist = (list: string[], storage: SignatureStorage | null) => {
  try {
    storage?.setItem(SIGNATURE_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable or full; keep the in-memory list */
  }
};

/** Newest first, capped at MAX_SIGNATURES. Returns the new list. */
export function addSignature(dataUrl: string, storage: SignatureStorage | null = defaultStorage()): string[] {
  const list = [dataUrl, ...loadSignatures(storage).filter((v) => v !== dataUrl)].slice(0, MAX_SIGNATURES);
  persist(list, storage);
  return list;
}

export function removeSignature(dataUrl: string, storage: SignatureStorage | null = defaultStorage()): string[] {
  const list = loadSignatures(storage).filter((v) => v !== dataUrl);
  persist(list, storage);
  return list;
}

/** Bounding box of pixels with non-zero alpha; `alpha` holds one alpha byte per pixel. */
export function trimBounds(alpha: Uint8ClampedArray, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지를 열 수 없습니다."));
    img.src = src;
  });

/** Draw `source` onto a canvas, crop transparent margins and return a PNG data URL. */
async function trimToPng(source: CanvasImageSource, width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0);
  const data = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Uint8ClampedArray(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
  const box = trimBounds(alpha, width, height);
  if (!box) return null;
  const out = document.createElement("canvas");
  out.width = box.w;
  out.height = box.h;
  out.getContext("2d")!.drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return { dataUrl: out.toDataURL("image/png"), width: box.w, height: box.h };
}

const mimeFor = (path: string) => (/\.png$/i.test(path) ? "image/png" : "image/jpeg");
const toDataUrl = (bytes: Uint8Array, mime: string) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
};

const PAD_W = 600;
const PAD_H = 200;
const COLORS = [
  { value: "#111111", label: "검정" },
  { value: "#1a4fd6", label: "파랑" },
];

export function SignatureDialog(props: { open: boolean; onClose(): void }) {
  let canvas!: HTMLCanvasElement;
  const [color, setColor] = createSignal(COLORS[0].value);
  const [saved, setSaved] = createSignal(loadSignatures());
  const [empty, setEmpty] = createSignal(true);
  const [error, setError] = createSignal("");
  let drawing = false;
  let last: { x: number; y: number } | null = null;

  const setupCanvas = (el: HTMLCanvasElement) => {
    canvas = el;
    const dpr = window.devicePixelRatio || 1;
    el.width = PAD_W * dpr;
    el.height = PAD_H * dpr;
    el.getContext("2d")!.scale(dpr, dpr);
  };
  const pos = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * PAD_W, y: ((e.clientY - r.top) / r.height) * PAD_H };
  };
  const segment = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ctx = canvas.getContext("2d")!;
    ctx.strokeStyle = color();
    ctx.fillStyle = color();
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    setEmpty(false);
  };
  const onDown = (e: PointerEvent) => {
    drawing = true;
    canvas.setPointerCapture?.(e.pointerId);
    last = pos(e);
    segment(last, { x: last.x + 0.01, y: last.y });
  };
  const onMove = (e: PointerEvent) => {
    if (!drawing || !last) return;
    const p = pos(e);
    segment(last, p);
    last = p;
  };
  const onUp = () => { drawing = false; last = null; };
  const clear = () => {
    const ctx = canvas.getContext("2d")!;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    setEmpty(true);
    setError("");
  };

  const place = async (dataUrl: string, nw: number, nh: number) => {
    // Lazy: the store pulls in browser-only dependencies.
    const { addAnnotationToTab, createAnnotationId } = await import("./store");
    const tab = activeTab();
    if (!tab || tab.readOnly) return;
    const page = tab.pages[tab.currentPage];
    if (!page) return;
    const w = page.width * 0.3;
    const h = (w * nh) / nw;
    addAnnotationToTab(tab.tabId, {
      id: createAnnotationId(),
      page: tab.currentPage,
      type: "image",
      rect: { x: (page.width - w) / 2, y: (page.height - h) / 2, w, h },
      style: { color: "#000000", width: 0 },
      payload: { imageSrc: dataUrl, imageNaturalWidth: nw, imageNaturalHeight: nh },
    });
    props.onClose();
  };

  const useDrawn = async () => {
    try {
      const result = await trimToPng(canvas, canvas.width, canvas.height);
      if (!result) { setError("서명을 먼저 그려 주세요."); return; }
      setSaved(addSignature(result.dataUrl));
      await place(result.dataUrl, result.width, result.height);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const importImage = async () => {
    try {
      const picked = await open({
        title: "서명 이미지 선택",
        filters: [{ name: "이미지", extensions: ["png", "jpg", "jpeg"] }],
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      const img = await loadImage(toDataUrl(await readFile(path), mimeFor(path)));
      const result = await trimToPng(img, img.naturalWidth, img.naturalHeight);
      if (!result) { setError("이미지에 내용이 없습니다."); return; }
      setSaved(addSignature(result.dataUrl));
      await place(result.dataUrl, result.width, result.height);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const useSaved = async (dataUrl: string) => {
    try {
      const img = await loadImage(dataUrl);
      await place(dataUrl, img.naturalWidth, img.naturalHeight);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && props.open) props.onClose(); };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <Show when={props.open}>
      <div class="signature-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
        <div class="signature-dialog" role="dialog" aria-modal="true" aria-label="서명">
          <h2>서명</h2>
          <canvas
            ref={setupCanvas}
            class="signature-pad"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
          <div class="signature-actions">
            <For each={COLORS}>
              {(c) => (
                <button
                  type="button"
                  class="signature-color"
                  classList={{ active: color() === c.value }}
                  style={{ background: c.value }}
                  title={c.label}
                  aria-label={c.label}
                  onClick={() => setColor(c.value)}
                />
              )}
            </For>
            <button type="button" class="toolbar-btn" onClick={clear}>지우기</button>
            <button type="button" class="toolbar-btn" onClick={() => void importImage()}>이미지에서 가져오기</button>
            <span class="spacer" />
            <button type="button" class="toolbar-btn" onClick={props.onClose}>취소</button>
            <button type="button" class="toolbar-btn" disabled={empty()} onClick={() => void useDrawn()}>적용</button>
          </div>
          <Show when={error()}><div class="signature-error">{error()}</div></Show>
          <Show when={saved().length > 0}>
            <div class="signature-saved" aria-label="저장된 서명">
              <For each={saved()}>
                {(src) => (
                  <div class="signature-saved-item">
                    <button type="button" class="pick" title="이 서명 사용" onClick={() => void useSaved(src)}>
                      <img src={src} alt="저장된 서명" />
                    </button>
                    <button type="button" class="remove" title="삭제" aria-label="서명 삭제" onClick={() => setSaved(removeSignature(src))}>×</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
