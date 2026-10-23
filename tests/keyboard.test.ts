import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortcutFor } from '../src/platform/shortcuts';

const ev = (o: Record<string, unknown>) => ({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, keyCode: 0, ...o });

test('Korean IME key with physical code KeyP selects pen', () => {
  assert.deepEqual(shortcutFor(ev({ key: 'ㅍ', code: 'KeyP' })), { type: 'tool', tool: 'pen' });
  assert.deepEqual(shortcutFor(ev({ key: 'ㅅ', code: 'KeyT' })), { type: 'tool', tool: 'text' });
});
test('composing events are ignored', () => {
  assert.equal(shortcutFor(ev({ key: 'ㅍ', code: 'KeyP', isComposing: true })), null);
  assert.equal(shortcutFor(ev({ key: 'Process', code: 'KeyP', keyCode: 229 })), null);
});
test('mod+P prints, mod+shift+S saves as, mod+shift+Z redoes', () => {
  assert.deepEqual(shortcutFor(ev({ code: 'KeyP', metaKey: true })), { type: 'print' });
  assert.deepEqual(shortcutFor(ev({ code: 'KeyS', ctrlKey: true, shiftKey: true })), { type: 'save', asNew: true });
  assert.deepEqual(shortcutFor(ev({ code: 'KeyZ', metaKey: true, shiftKey: true })), { type: 'redo' });
  assert.deepEqual(shortcutFor(ev({ code: 'KeyY', metaKey: true })), { type: 'redo' });
});
test('Shift+/ and mod+/ toggle help', () => {
  assert.deepEqual(shortcutFor(ev({ key: '?', code: 'Slash', shiftKey: true })), { type: 'help' });
  assert.deepEqual(shortcutFor(ev({ code: 'Slash', metaKey: true })), { type: 'help' });
});
test('zoom, rotate and delete mapping', () => {
  assert.deepEqual(shortcutFor(ev({ code: 'Equal', metaKey: true, shiftKey: true })), { type: 'zoomIn' });
  assert.deepEqual(shortcutFor(ev({ code: 'NumpadSubtract', ctrlKey: true })), { type: 'zoomOut' });
  assert.deepEqual(shortcutFor(ev({ code: 'KeyR', shiftKey: true })), { type: 'rotate', direction: -1 });
  assert.deepEqual(shortcutFor(ev({ code: 'KeyR' })), { type: 'rotate', direction: 1 });
  assert.deepEqual(shortcutFor(ev({ code: 'Backspace', key: 'Backspace' })), { type: 'deleteAnnotations' });
  assert.deepEqual(shortcutFor(ev({ code: 'Tab', ctrlKey: true, shiftKey: true })), { type: 'cycleTab', direction: -1 });
});
