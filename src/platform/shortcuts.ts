export function shortcutLabel(key: string, shift = false, platform = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return /Mac|iPhone|iPad/.test(platform) ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}
export function blocksToolShortcut(tag: string, editable: boolean, role: string | null): boolean {
  return editable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(tag) || ['button', 'tab', 'textbox', 'combobox', 'slider', 'menuitem'].includes(role ?? '');
}
