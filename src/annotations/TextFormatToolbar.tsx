import { Show, createMemo } from "solid-js";
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
  setFontFamily,
  setFontSizePx,
  toggleBold,
  toggleItalic,
  toggleUnderline,
} from "./textFormat";

const ICON = 14;

/**
 * Visible only when a text annotation has the user's attention — either
 * selected or actively being edited.
 */
export function TextFormatToolbar() {
  const isTextContext = createMemo(() => {
    const tab = activeTab();
    if (!tab) return false;
    if (tab.annotations.editingId) {
      const editing = tab.annotations.items.find(
        (a) => a.id === tab.annotations.editingId,
      );
      if (editing?.type === "text") return true;
    }
    if (tab.annotations.selectedIds.length > 0) {
      const selected = tab.annotations.items.filter((a) =>
        tab.annotations.selectedIds.includes(a.id),
      );
      if (selected.some((a) => a.type === "text")) return true;
    }
    return false;
  });

  // Formatting buttons must NOT steal focus from the contenteditable.
  // Native controls such as <select> and <input> must keep their default
  // mousedown behavior, otherwise the dropdown/spinner never opens.
  const guardFocus = (event: MouseEvent) => event.preventDefault();

  const action = (fn: () => void) => (event: MouseEvent) => {
    event.preventDefault();
    fn();
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
    <Show when={isTextContext()}>
      <div class="text-format-toolbar" aria-label="text formatting">
        <select
          class="text-format-select"
          title="폰트"
          value={annotationStore.fontFamily}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value) applyFontFamily(value);
          }}
        >
          <option value="">폰트</option>
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
            min="8"
            max="120"
            value={annotationStore.fontSize}
            onInput={(event) => {
              const px = Number(event.currentTarget.value);
              if (Number.isFinite(px) && px >= 6) applyFontSize(px);
            }}
          />
        </label>

        <div class="text-format-group" role="group" aria-label="텍스트 스타일">
          <button
            type="button"
            title="굵게 (Cmd+B)"
            onMouseDown={guardFocus}
            onClick={action(applyBold)}
          >
            <Bold size={ICON} />
          </button>
          <button
            type="button"
            title="기울임 (Cmd+I)"
            onMouseDown={guardFocus}
            onClick={action(applyItalic)}
          >
            <Italic size={ICON} />
          </button>
          <button
            type="button"
            title="밑줄 (Cmd+U)"
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
            onMouseDown={guardFocus}
            onClick={action(() => applyAlign("left"))}
          >
            <AlignLeft size={ICON} />
          </button>
          <button
            type="button"
            title="가운데 정렬"
            onMouseDown={guardFocus}
            onClick={action(() => applyAlign("center"))}
          >
            <AlignCenter size={ICON} />
          </button>
          <button
            type="button"
            title="오른쪽 정렬"
            onMouseDown={guardFocus}
            onClick={action(() => applyAlign("right"))}
          >
            <AlignRight size={ICON} />
          </button>
        </div>
      </div>
    </Show>
  );
}
