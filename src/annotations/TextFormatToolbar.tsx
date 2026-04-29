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
import { annotationStore } from "./store";
import {
  COMMON_FONTS,
  alignCenter,
  alignLeft,
  alignRight,
  setFontFamily,
  setFontSizePx,
  toggleBold,
  toggleItalic,
  toggleUnderline,
} from "./textFormat";

const ICON = 14;

/**
 * Visible only when a text annotation has the user's attention — either
 * selected or actively being edited. Each control is wired so it doesn't
 * steal focus from the contenteditable: clicks are dispatched on mousedown
 * with preventDefault so the editor's selection survives.
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

  // Buttons must NOT steal focus from the contenteditable. Mousedown is the
  // first event in the focus-change chain — preventing default there keeps
  // the editor focused so execCommand can target the live selection.
  const guardFocus = (event: MouseEvent) => event.preventDefault();

  const action = (fn: () => void) => (event: MouseEvent) => {
    event.preventDefault();
    fn();
  };

  return (
    <Show when={isTextContext()}>
      <div class="text-format-toolbar" aria-label="text formatting">
        <select
          class="text-format-select"
          title="폰트"
          onMouseDown={guardFocus}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value) setFontFamily(value);
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
            onMouseDown={guardFocus}
            onInput={(event) => {
              const px = Number(event.currentTarget.value);
              if (Number.isFinite(px) && px >= 6) setFontSizePx(px);
            }}
          />
        </label>

        <div class="text-format-group" role="group" aria-label="텍스트 스타일">
          <button
            type="button"
            title="굵게 (Cmd+B)"
            onMouseDown={guardFocus}
            onClick={action(toggleBold)}
          >
            <Bold size={ICON} />
          </button>
          <button
            type="button"
            title="기울임 (Cmd+I)"
            onMouseDown={guardFocus}
            onClick={action(toggleItalic)}
          >
            <Italic size={ICON} />
          </button>
          <button
            type="button"
            title="밑줄 (Cmd+U)"
            onMouseDown={guardFocus}
            onClick={action(toggleUnderline)}
          >
            <Underline size={ICON} />
          </button>
        </div>

        <div class="text-format-group" role="group" aria-label="정렬">
          <button
            type="button"
            title="왼쪽 정렬"
            onMouseDown={guardFocus}
            onClick={action(alignLeft)}
          >
            <AlignLeft size={ICON} />
          </button>
          <button
            type="button"
            title="가운데 정렬"
            onMouseDown={guardFocus}
            onClick={action(alignCenter)}
          >
            <AlignCenter size={ICON} />
          </button>
          <button
            type="button"
            title="오른쪽 정렬"
            onMouseDown={guardFocus}
            onClick={action(alignRight)}
          >
            <AlignRight size={ICON} />
          </button>
        </div>
      </div>
    </Show>
  );
}
