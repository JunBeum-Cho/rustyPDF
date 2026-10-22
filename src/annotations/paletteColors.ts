// Office theme colors, arranged by row so keyboard navigation mirrors the grid.
export const THEME_COLORS = [
  '#ffffff','#000000','#e7e6e6','#44546a','#4472c4','#ed7d31','#a5a5a5','#ffc000','#5b9bd5','#70ad47',
  '#f2f2f2','#7f7f7f','#d0cece','#d6dce4','#d9e2f3','#fbe5d6','#ededed','#fff2cc','#deebf7','#e2efd9',
  '#d9d9d9','#595959','#aeaaaa','#adb9ca','#b4c6e7','#f7cbac','#dbdbdb','#ffe699','#bdd7ee','#c5e0b3',
  '#bfbfbf','#3f3f3f','#757171','#8497b0','#8eaadb','#f4b183','#c9c9c9','#ffd966','#9dc3e6','#a8d08d',
  '#a6a6a6','#262626','#3b3838','#323f4f','#2f5496','#c55a11','#7b7b7b','#bf9000','#2e75b6','#548235',
  '#7f7f7f','#0c0c0c','#161616','#222a35','#1f3864','#833c0b','#525252','#7f6000','#1f4e78','#375623',
];
export const STANDARD_COLORS = ['#c00000','#ff0000','#ffc000','#ffff00','#92d050','#00b050','#00b0f0','#0070c0','#002060','#7030a0'];
export function moveColorFocus(index: number, key: string) {
  const start = Math.floor(index / 10) * 10;
  if (key === 'Home') return start;
  if (key === 'End') return start + 9;
  if (key === 'ArrowLeft') return Math.max(start, index - 1);
  if (key === 'ArrowRight') return Math.min(start + 9, index + 1);
  if (key === 'ArrowUp') return Math.max(index % 10, index - 10);
  if (key === 'ArrowDown') return Math.min(60 + index % 10, index + 10);
  return index;
}
export function palettePosition(anchor: {left: number; top: number; bottom: number}, width: number, height: number, popupWidth: number, popupHeight: number) {
  return {
    left: Math.max(8, Math.min(anchor.left, width - popupWidth - 8)),
    top: Math.max(8, Math.min(anchor.bottom + 6 + popupHeight > height - 8 ? anchor.top - popupHeight - 6 : anchor.bottom + 6, height - popupHeight - 8)),
  };
}

/** Activate explicitly: preserve the selected editor range before native click handling. */
export function activateColorKey(event: Pick<KeyboardEvent, 'key' | 'repeat' | 'preventDefault' | 'stopPropagation'>, apply: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return false;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) apply();
  return true;
}
