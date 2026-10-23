import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { ArrowDown, ArrowUp, FileImage, Images, Trash2, Upload, X } from "lucide-solid";
import { open, readFile } from "../platform/desktop";
import { openImagesAsPdf } from "../ipc/pdf";
import { fileNameFromPath } from "../state/document";
import {
  IMAGE_EXTENSIONS, addImagePaths, createUrlRegistry, imageImportBusy, imageImportError, imageImportOpen, imagePaths, moveImage, moveImageTo,
  setImageImportBusy, setImageImportError, setImageImportOpen, setImagePaths,
} from "./importState";
import "./images.css";

export function ImageImportDialog() {
  let dialog!: HTMLDialogElement;
  const [name, setName] = createSignal("이미지 모음");
  createEffect(() => {
    if (imageImportOpen()) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) dialog.close();
  });
  const registry = createUrlRegistry(blob => URL.createObjectURL(blob), url => URL.revokeObjectURL(url));
  const [thumbs, setThumbs] = createSignal<Record<string, string>>({});
  const [broken, setBroken] = createSignal<Record<string, true>>({});
  const [dragFrom, setDragFrom] = createSignal<number | null>(null);
  const [dropAt, setDropAt] = createSignal<number | null>(null);
  const loading = new Set<string>();
  const clearThumbs = () => { registry.clear(); loading.clear(); setThumbs({}); setBroken({}); };
  createEffect(() => {
    const paths = imagePaths();
    const open = imageImportOpen();
    if (!open) { clearThumbs(); return; }
    for (const key of registry.keys()) if (!paths.includes(key)) {
      registry.remove(key);
      setThumbs(({ [key]: _, ...rest }) => rest);
    }
    for (const path of paths) {
      if (registry.get(path) || loading.has(path)) continue;
      loading.add(path);
      void readFile(path).then(data => {
        loading.delete(path);
        if (!imageImportOpen() || !imagePaths().includes(path)) return;
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
        setThumbs(current => ({ ...current, [path]: registry.add(path, new Blob([bytes as BlobPart])) }));
      }).catch(() => { loading.delete(path); setBroken(current => ({ ...current, [path]: true })); });
    }
  });
  onCleanup(clearThumbs);
  const endDrag = () => { setDragFrom(null); setDropAt(null); };
  const drop = (target: number) => {
    const from = dragFrom();
    endDrag();
    if (from !== null) moveImageTo(from, target);
  };
  const close = () => { if (!imageImportBusy()) setImageImportOpen(false); };
  const pickImages = async () => {
    if (imageImportBusy()) return;
    try {
      const picked = await open({ multiple: true, title: "PDF로 만들 이미지 선택", filters: [{ name: "이미지", extensions: IMAGE_EXTENSIONS }] });
      if (picked) addImagePaths(Array.isArray(picked) ? picked : [picked]);
    } catch (error) { setImageImportError(`이미지 선택 실패: ${String(error)}`); }
  };
  const convert = async () => {
    if (imageImportBusy() || !imagePaths().length) return;
    setImageImportBusy(true);
    setImageImportError("");
    try {
      await openImagesAsPdf([...imagePaths()], name());
      setImagePaths([]);
      setName("이미지 모음");
      setImageImportOpen(false);
    } catch (error) { setImageImportError(`변환 실패: ${String(error)}`); }
    finally { setImageImportBusy(false); }
  };
  return (
    <dialog ref={dialog} class="image-import" aria-labelledby="image-import-title"
      onKeyDown={event => event.stopPropagation()}
      onCancel={event => { event.preventDefault(); close(); }} onClose={() => setImageImportOpen(false)}>
      <header class="image-import-header">
        <h2 id="image-import-title"><Images size={20} /> 이미지 → PDF</h2>
        <button type="button" onClick={close} disabled={imageImportBusy()} aria-label="닫기"><X size={18} /></button>
      </header>
      <div class="image-import-body">
        <p class="image-import-help">PNG · JPG · HEIC · WebP 등 (HEIC·TIFF는 운영체제가 지원할 때) 이미지를 목록 순서대로 PDF로 만듭니다.<br />이미지 방향에 맞춘 A4 한 페이지 · 비율 유지 · 여백 10mm<br />최대 100장 / 총 200MB</p>
        <div class="image-import-drop" aria-label="이미지 드롭 영역" aria-disabled={imageImportBusy()}>
          <Upload size={26} />
          <p>이미지를 여기에 끌어다 놓으세요.</p>
          <button type="button" onClick={pickImages} disabled={imageImportBusy()}>이미지 추가</button>
        </div>
        <div class="image-import-list-header">
          <span>{imagePaths().length ? `${imagePaths().length}장 · 위에서 아래 순서로 열립니다.` : "이미지를 추가해 주세요."}</span>
          <button type="button" disabled={imageImportBusy() || !imagePaths().length} onClick={() => { setImagePaths([]); setImageImportError(""); }}>전체 비우기</button>
        </div>
        <ol class="image-import-list">
          <For each={imagePaths()}>{(path, index) => (
            <li classList={{ dragging: dragFrom() === index(), "drop-before": dropAt() === index() && dragFrom() !== null && dragFrom()! > index(), "drop-after": dropAt() === index() && dragFrom() !== null && dragFrom()! < index() }}
              onPointerEnter={() => { if (dragFrom() !== null) setDropAt(index()); }}
              onPointerUp={() => { if (dragFrom() !== null) drop(index()); }}>
              <span class="image-import-grip" aria-hidden="true" title="끌어서 순서 변경"
                onPointerDown={event => { if (imageImportBusy()) return; event.preventDefault(); setDragFrom(index()); setDropAt(index()); window.addEventListener("pointerup", endDrag, { once: true }); }}>⠿</span>
              <Show when={thumbs()[path] && !broken()[path]} fallback={<span class="image-import-thumb"><FileImage size={22} /></span>}>
                <img class="image-import-thumb" src={thumbs()[path]} alt="" draggable={false} onError={() => setBroken(current => ({ ...current, [path]: true }))} />
              </Show>
              <span class="image-import-file" title={path}>{index() + 1}. {fileNameFromPath(path)}</span>
              <button type="button" aria-label={`${index() + 1}번 이미지 위로 이동`} disabled={imageImportBusy() || index() === 0} onClick={() => moveImage(index(), -1)}><ArrowUp size={15} /></button>
              <button type="button" aria-label={`${index() + 1}번 이미지 아래로 이동`} disabled={imageImportBusy() || index() === imagePaths().length - 1} onClick={() => moveImage(index(), 1)}><ArrowDown size={15} /></button>
              <button type="button" aria-label={`${index() + 1}번 이미지 삭제`} disabled={imageImportBusy()} onClick={() => setImagePaths(paths => paths.filter(item => item !== path))}><Trash2 size={15} /></button>
            </li>
          )}</For>
        </ol>
        <label class="image-import-name">문서 이름
          <input value={name()} onInput={event => setName(event.currentTarget.value)} disabled={imageImportBusy()} placeholder="이미지 모음" />
        </label>
        <p class="image-import-help">편집기로 열면 기존 PDF 도구를 그대로 사용할 수 있습니다.<br />‘저장’으로 편집할 수 있는 문서를 보관하고, ‘주석 포함 PDF’로 공유하세요.</p>
        <p class="image-import-error" role="alert">{imageImportError()}</p>
      </div>
      <footer class="image-import-footer">
        <button type="button" onClick={close} disabled={imageImportBusy()}>닫기</button>
        <button type="button" class="image-import-submit" onClick={convert} disabled={imageImportBusy() || !imagePaths().length}>{imageImportBusy() ? "PDF 만드는 중…" : "편집기로 열기"}</button>
      </footer>
    </dialog>
  );
}
