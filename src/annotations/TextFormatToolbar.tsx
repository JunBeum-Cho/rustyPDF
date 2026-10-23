import { ColorPalette } from "./ColorPalette";
import { shortcutLabel } from "../platform/shortcuts";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  Underline,
} from "lucide-solid";
import { activeTab } from "../state/document";
import {
  alignSelectedText,
  annotationStore,
  hasSelectedTextAnnotation,
  setAnnotationFontFamily,
  setAnnotationFontSize,
  setAnnotationColor,
  setAnnotationUiColor,
  setAnnotationUiFontFamily,
  setAnnotationUiFontSize,
  toggleSelectedTextBold,
  toggleSelectedTextItalic,
  toggleSelectedTextUnderline,
} from "./store";
import {
  COMMON_FONTS,
  alignCenter,
  alignLeft,
  alignRight,
  getActiveEditor,
  queryTextFormatState,
  sameValueOrNull,
  setFontFamily,
  setFontSizePx,
  setFontColor,
  type TextFormatState,
  toggleBold,
  toggleItalic,
  toggleUnderline,
} from "./textFormat";

const ICON = 14;

/** Text controls inside the floating annotation menu. */
export function TextFormatToolbar() {
  const [editorFormatState, setEditorFormatState] =
    createSignal<TextFormatState | null>(null);
  let pendingFormatSync = 0;

  const syncFormatState = () => {
    pendingFormatSync = 0;
    setEditorFormatState(queryTextFormatState());
  };

  const scheduleFormatSync = () => {
    if (pendingFormatSync) cancelAnimationFrame(pendingFormatSync);
    pendingFormatSync = requestAnimationFrame(syncFormatState);
  };

  const selectedAnnotationFormatState = createMemo<TextFormatState | null>(() => {
    const tab = activeTab();
    if (!tab) return null;
    const selected = new Set(tab.annotations.selectedIds);
    const annotations = tab.annotations.items.filter(
      (a) => a.type === "text" && selected.has(a.id),
    );
    if (annotations.length === 0) return null;
    const aligns = annotations.map((a) => a.style.textAlign ?? "left");
    const families = annotations.map((a) => a.style.fontFamily ?? null);
    const sizes = annotations.map((a) => a.style.fontSize ?? null);
    return {
      bold: annotations.every(
        (a) => a.style.fontWeight === "700" || a.style.fontWeight === "bold",
      ),
      italic: annotations.every((a) => a.style.fontStyle === "italic"),
      underline: annotations.every(
        (a) => a.style.textDecoration === "underline",
      ),
      align: sameValueOrNull(aligns),
      fontFamily: sameValueOrNull(families),
      fontSizePx: sameValueOrNull(sizes),
      color: sameValueOrNull(annotations.map((a) => a.style.color)),
    };
  });

  const formatState = createMemo(() => {
    const tab = activeTab();
    if (tab?.annotations.editingId) {
      return editorFormatState() ?? selectedAnnotationFormatState();
    }
    return selectedAnnotationFormatState();
  });

  createEffect(() => {
    const tab = activeTab();
    const editingId = tab?.annotations.editingId;
    const selectedIds = tab?.annotations.selectedIds.join(",");
    if (editingId || selectedIds) {
      scheduleFormatSync();
      return;
    }
    setEditorFormatState(null);
  });

  onMount(() => {
    scheduleFormatSync();
    document.addEventListener("selectionchange", scheduleFormatSync);
    document.addEventListener("focusin", scheduleFormatSync);
    document.addEventListener("focusout", scheduleFormatSync);
    document.addEventListener("keyup", scheduleFormatSync);
    document.addEventListener("mouseup", scheduleFormatSync);
    document.addEventListener("input", scheduleFormatSync);
  });

  onCleanup(() => {
    if (pendingFormatSync) cancelAnimationFrame(pendingFormatSync);
    document.removeEventListener("selectionchange", scheduleFormatSync);
    document.removeEventListener("focusin", scheduleFormatSync);
    document.removeEventListener("focusout", scheduleFormatSync);
    document.removeEventListener("keyup", scheduleFormatSync);
    document.removeEventListener("mouseup", scheduleFormatSync);
    document.removeEventListener("input", scheduleFormatSync);
  });

  // Formatting buttons must NOT steal focus from the contenteditable.
  // Native controls such as <select> and <input> must keep their default
  // mousedown behavior, otherwise the dropdown/spinner never opens.
  const guardFocus = (event: MouseEvent) => event.preventDefault();

  const action = (fn: () => void) => (event: MouseEvent) => {
    event.preventDefault();
    fn();
    scheduleFormatSync();
  };

  const applyFontFamily = (fontFamily: string) => {
    if (getActiveEditor()) {
      setAnnotationUiFontFamily(fontFamily);
      setFontFamily(fontFamily);
      return;
    }
    setAnnotationFontFamily(fontFamily);
  };

  const applyFontSize = (fontSize: number) => {
    if (getActiveEditor()) {
      setAnnotationUiFontSize(fontSize);
      setFontSizePx(fontSize);
      return;
    }
    setAnnotationFontSize(fontSize);
  };

  const applyColor = (color: string) => {
    if (getActiveEditor()) {
      setAnnotationUiColor(color);
      setFontColor(color);
    } else {
      setAnnotationColor(color);
    }
    scheduleFormatSync();
  };

  const fontFamily = () => formatState()?.fontFamily ?? annotationStore.fontFamily;
  const textColor = () => formatState()?.color ?? annotationStore.textColor;

  const applyBold = () => {
    if (getActiveEditor()) {
      toggleBold();
      return;
    }
    if (hasSelectedTextAnnotation()) toggleSelectedTextBold();
  };

  const applyItalic = () => {
    if (getActiveEditor()) {
      toggleItalic();
      return;
    }
    if (hasSelectedTextAnnotation()) toggleSelectedTextItalic();
  };

  const applyUnderline = () => {
    if (getActiveEditor()) {
      toggleUnderline();
      return;
    }
    if (hasSelectedTextAnnotation()) toggleSelectedTextUnderline();
  };

  const applyAlign = (align: "left" | "center" | "right") => {
    if (getActiveEditor()) {
      if (align === "left") alignLeft();
      if (align === "center") alignCenter();
      if (align === "right") alignRight();
      return;
    }
    if (hasSelectedTextAnnotation()) alignSelectedText(align);
  };

  return (
      <div class="text-format-toolbar" aria-label="텍스트 서식">
        <div class="text-color-group" role="group" aria-label="글자색">
          <ColorPalette label="글자색" value={textColor()} onChange={applyColor} />
        </div>
        <select
          class="text-format-select"
          title="오프라인 내장 글꼴 · 기존 글꼴은 Noto Sans KR 또는 Noto Serif KR로 대체됩니다."
          value={fontFamily()}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value) applyFontFamily(value);
            scheduleFormatSync();
          }}
        >
          <option value="">폰트</option>
          {!(COMMON_FONTS as readonly string[]).includes(fontFamily()) && <option value={fontFamily()}>{fontFamily()}</option>}
          {COMMON_FONTS.map((font) => (
            <option value={font} style={{ "font-family": font }}>
              {font}
            </option>
          ))}
        </select>

        <label class="annotation-number" title="글자 크기 (선택 영역만)">
          <span>크기</span>
          <input
            type="number"
            min="4"
            max="120"
            value={formatState()?.fontSizePx ?? annotationStore.fontSize}
            onInput={(event) => {
              const px = Number(event.currentTarget.value);
              if (Number.isFinite(px) && px >= 4) applyFontSize(px);
              scheduleFormatSync();
            }}
          />
        </label>

        <div class="text-format-group" role="group" aria-label="텍스트 스타일">
          <button
            type="button"
            title={`굵게 (${shortcutLabel("B")})`}
            aria-pressed={formatState()?.bold ? "true" : "false"}
            classList={{ active: formatState()?.bold ?? false }}
            onMouseDown={guardFocus}
            onClick={action(applyBold)}
          >
            <Bold size={ICON} />
          </button>
          <button
            type="button"
            title={`기울임 (${shortcutLabel("I")})`}
            aria-pressed={formatState()?.italic ? "true" : "false"}
            classList={{ active: formatState()?.italic ?? false }}
            onMouseDown={guardFocus}
            onClick={action(applyItalic)}
          >
            <Italic size={ICON} />
          </button>
          <button
            type="button"
            title={`밑줄 (${shortcutLabel("U")})`}
            aria-pressed={formatState()?.underline ? "true" : "false"}
            classList={{ active: formatState()?.underline ?? false }}
            onMouseDown={guardFocus}
            onClick={action(applyUnderline)}
          >
            <Underline size={ICON} />
          </button>
        </div>

        <div class="text-format-group" role="group" aria-label="정렬">
          <button
            type="button"
            title="왼쪽 정렬"
            aria-pressed={formatState()?.align === "left" ? "true" : "false"}
            classList={{ active: formatState()?.align === "left" }}
            onMouseDown={guardFocus}
            onClick={action(() => applyAlign("left"))}
          >
            <AlignLeft size={ICON} />
          </button>
          <button
            type="button"
            title="가운데 정렬"
            aria-pressed={formatState()?.align === "center" ? "true" : "false"}
            classList={{ active: formatState()?.align === "center" }}
            onMouseDown={guardFocus}
            onClick={action(() => applyAlign("center"))}
          >
            <AlignCenter size={ICON} />
          </button>
          <button
            type="button"
            title="오른쪽 정렬"
            aria-pressed={formatState()?.align === "right" ? "true" : "false"}
            classList={{ active: formatState()?.align === "right" }}
            onMouseDown={guardFocus}
            onClick={action(() => applyAlign("right"))}
          >
            <AlignRight size={ICON} />
          </button>
        </div>
      </div>
  );
}
