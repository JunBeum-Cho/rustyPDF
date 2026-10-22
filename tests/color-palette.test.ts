import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { THEME_COLORS, STANDARD_COLORS, moveColorFocus, palettePosition } from '../src/annotations/paletteColors';

test('Office palette provides six rows of ten theme colors and ten standard choices', () => {
  assert.equal(THEME_COLORS.length, 60);
  assert.deepEqual(THEME_COLORS.slice(0, 4), ['#ffffff', '#000000', '#e7e6e6', '#44546a']);
  assert.equal(STANDARD_COLORS.length, 10);
  for (const color of [...THEME_COLORS, ...STANDARD_COLORS]) assert.match(color, /^#[0-9a-f]{6}$/);
});
test('keyboard navigation preserves columns and respects row boundaries', () => {
  assert.equal(moveColorFocus(9, 'ArrowRight'), 9);
  assert.equal(moveColorFocus(10, 'ArrowLeft'), 10);
  assert.equal(moveColorFocus(59, 'ArrowDown'), 69);
  assert.equal(moveColorFocus(69, 'ArrowDown'), 69);
  assert.equal(moveColorFocus(21, 'Home'), 20);
  assert.equal(moveColorFocus(21, 'End'), 29);
  assert.equal(moveColorFocus(2, 'ArrowUp'), 2);
});
test('popup fits narrow viewports and flips above the trigger near bottom', () => {
  assert.deepEqual(palettePosition({left: 690, top: 620, bottom: 652}, 720, 680, 250, 246), {left: 462, top: 368});
  assert.deepEqual(palettePosition({left: 12, top: 20, bottom: 52}, 1280, 800, 250, 246), {left: 12, top: 58});
});

test('Enter and Space activate a focused color once without a native click', async () => {
  const { activateColorKey } = await import('../src/annotations/paletteColors');
  const dom = new JSDOM('<button>Blue</button>');
  const button = dom.window.document.querySelector('button')!;
  let applied = 0, bubbled = 0;
  dom.window.document.body.addEventListener('keydown', () => bubbled++);
  button.addEventListener('keydown', event => activateColorKey(event as KeyboardEvent, () => applied++));
  for (const key of ['Enter', ' ']) {
    const before = applied;
    const event = new dom.window.KeyboardEvent('keydown', {key, bubbles:true, cancelable:true});
    button.dispatchEvent(event);
    assert.equal(applied, before + 1);
    assert.equal(event.defaultPrevented, true, 'native click must be suppressed to avoid double application');
    button.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key, repeat:true, bubbles:true, cancelable:true}));
    assert.equal(applied, before + 1, 'held activation must not apply a color twice');
    assert.equal(bubbled, 0);
  }
  const arrow = new dom.window.KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true, cancelable:true});
  button.dispatchEvent(arrow);
  assert.equal(arrow.defaultPrevented, false);
  assert.equal(bubbled, 1);
  assert.equal(applied, 2);
  dom.window.close();
});
