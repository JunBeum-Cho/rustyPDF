import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { activeTab } from '../state/document';
import { annotationStore } from './store';
import { THEME_COLORS, STANDARD_COLORS, moveColorFocus, palettePosition, activateColorKey } from './paletteColors';
import './colorPalette.css';

const colors = [...THEME_COLORS, ...STANDARD_COLORS];
const names = ['흰색', '검정', '밝은 회색', '청회색', '파랑', '주황', '회색', '금색', '하늘색', '초록'];
export function ColorPalette(props: {value: string; onChange: (color: string) => void; label: string; disabled?: boolean}) {
  const [open, setOpen] = createSignal(false);
  const [focused, setFocused] = createSignal(0);
  const [position, setPosition] = createSignal({left: 8, top: 8});
  let trigger!: HTMLButtonElement;
  let popup!: HTMLDivElement;
  const close = (restore = false) => { setOpen(false); if (restore) trigger.focus({preventScroll: true}); };
  const focusColor = (index: number) => {
    setFocused(index);
    popup?.querySelectorAll<HTMLButtonElement>('.color-palette-swatch')[index]?.focus({preventScroll: true});
  };
  const toggle = (keyboard: boolean) => {
    if (open()) { close(); return; }
    const current = colors.indexOf(props.value.toLowerCase());
    setFocused(Math.max(0, current));
    setOpen(true);
    if (keyboard) queueMicrotask(() => focusColor(focused()));
  };
  // A document/tool/selection transition invalidates an open formatting popup.
  createEffect(() => {
    const tab = activeTab();
    void tab?.tabId; void tab?.docId; void tab?.revision; void tab?.annotations.editingId; void tab?.annotations.selectedIds.join(',');
    void annotationStore.tool; void props.disabled;
    setOpen(false);
  });
  createEffect(() => {
    if (!open()) return;
    const update = () => {
      if (!trigger.isConnected || trigger.closest('[inert], [aria-hidden="true"]')) { close(); return; }
      setPosition(palettePosition(trigger.getBoundingClientRect(), window.innerWidth, window.innerHeight, popup?.offsetWidth || 250, popup?.offsetHeight || 258));
    };
    const outside = (event: PointerEvent) => {
      if (!trigger.contains(event.target as Node) && !popup?.contains(event.target as Node)) close();
    };
    const focusOutside = (event: FocusEvent) => {
      if (!trigger.contains(event.target as Node) && !popup?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      if (event.key === 'Tab' && !popup?.contains(event.target as Node)) close();
    };
    update();
    queueMicrotask(update);
    const observer = new MutationObserver(update);
    // Floating parents remain mounted during their closing animation.
    for (let parent = trigger.parentElement; parent; parent = parent.parentElement) observer.observe(parent, {attributes: true, attributeFilter: ['inert', 'aria-hidden', 'class']});
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    document.addEventListener('focusin', focusOutside);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    onCleanup(() => {
      observer.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('focusin', focusOutside);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    });
  });
  const dismissKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
  };
  return <>
    <button ref={trigger} type="button" class="color-palette-trigger" disabled={props.disabled}
      title={props.label} aria-label={props.label} aria-haspopup="dialog" aria-expanded={open()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => toggle(event.detail === 0)}
      onKeyDown={(event) => {
        if (open()) dismissKey(event);
        if (event.key === 'ArrowDown') { event.preventDefault(); if (!open()) toggle(true); else focusColor(focused()); }
      }}>
      <span style={{'background-color': props.value}} /><span class="color-palette-chevron" aria-hidden="true">▾</span>
    </button>
    <Show when={open()}><Portal>
      <div class="annotation-toolbar color-palette-host">
        <div ref={popup} class="color-palette-popup" role="dialog" aria-label={`${props.label} 선택`}
          style={{left: `${position().left}px`, top: `${position().top}px`}}
          onKeyDown={dismissKey}>
          <div class="color-palette-heading">테마 색</div>
          <div class="color-palette-grid" role="group" aria-label="테마 색">
            {colors.map((color, index) => <>
              {index === 60 && <div class="color-palette-heading color-palette-standard">표준 색</div>}
              <button type="button" class="color-palette-swatch" style={{'background-color': color}}
                title={`${index < 60 ? `${names[index % 10]}${index >= 10 ? ` 변형 ${Math.floor(index / 10)}` : ''}` : '표준 색'} ${color.toUpperCase()}`}
                aria-label={`${index < 60 ? '테마' : '표준'} ${color.toUpperCase()}`}
                aria-pressed={props.value.toLowerCase() === color} tabIndex={focused() === index ? 0 : -1}
                onFocus={() => setFocused(index)} onMouseDown={(event) => event.preventDefault()}
                onKeyDown={(event) => {
                  if (activateColorKey(event, () => { props.onChange(color); close(); })) return;
                  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
                    event.preventDefault(); event.stopPropagation(); focusColor(moveColorFocus(index, event.key));
                  }
                }}
                onClick={() => { props.onChange(color); close(); }}>
                {props.value.toLowerCase() === color ? <span aria-hidden="true" style={{color: index === 1 || ['#000000','#002060','#7030a0'].includes(color) ? '#ffffff' : '#111111'}}>✓</span> : null}
              </button>
            </>)}
          </div>
          <label class="color-palette-custom">다른 색… <span>{props.value.toUpperCase()}</span>
            <input type="color" aria-label={`${props.label} 사용자 지정`} value={props.value}
              onInput={(event) => props.onChange(event.currentTarget.value)} />
          </label>
        </div>
      </div>
    </Portal></Show>
  </>;
}
