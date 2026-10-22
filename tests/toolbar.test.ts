import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortcutLabel, blocksToolShortcut } from '../src/platform/shortcuts';
test('shortcut labels follow the host platform', () => {
  assert.equal(shortcutLabel('S', false, 'MacIntel'), '⌘S');
  assert.equal(shortcutLabel('S', true, 'Win32'), 'Ctrl+Shift+S');
});
test('tool shortcuts preserve native interactive keys', () => {
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A']) assert.equal(blocksToolShortcut(tag, false, null), true);
  assert.equal(blocksToolShortcut('DIV', true, null), true);
  assert.equal(blocksToolShortcut('DIV', false, 'tab'), true);
  assert.equal(blocksToolShortcut('CANVAS', false, null), false);
});
