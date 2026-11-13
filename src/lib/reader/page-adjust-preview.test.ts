import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  PREVIEW_AFTER_CHANGE_MS,
  pageAdjustPreviewing,
  previewAfterChange,
  previewWhileAdjusting
} from './page-adjust-preview';

const cleanups: (() => void)[] = [];

function slider(): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'range';
  document.body.appendChild(el);
  cleanups.push(previewWhileAdjusting(el), () => el.remove());
  return el;
}

function pointer(type: string, target: EventTarget, init: PointerEventInit = {}) {
  // jsdom has no PointerEvent constructor everywhere; a MouseEvent carries the fields we read.
  const Ctor = (globalThis.PointerEvent ?? MouseEvent) as typeof MouseEvent;
  const ev = new Ctor(type, { bubbles: true, button: 0, ...init });
  if (!('pointerType' in ev)) Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
  if (!('pointerId' in ev)) Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1 });
  target.dispatchEvent(ev);
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.useRealTimers();
});

describe('page adjust preview (#363)', () => {
  it('is off until a slider is touched', () => {
    slider();
    expect(get(pageAdjustPreviewing)).toBe(false);
  });

  it('holds from pointer down until the pointer is released anywhere', () => {
    const el = slider();
    pointer('pointerdown', el);
    expect(get(pageAdjustPreviewing)).toBe(true);
    pointer('pointerup', document.body);
    expect(get(pageAdjustPreviewing)).toBe(false);
  });

  it('ends on pointercancel too', () => {
    const el = slider();
    pointer('pointerdown', el);
    pointer('pointercancel', window);
    expect(get(pageAdjustPreviewing)).toBe(false);
  });

  it('ignores a secondary mouse button', () => {
    const el = slider();
    pointer('pointerdown', el, { button: 2 });
    expect(get(pageAdjustPreviewing)).toBe(false);
  });

  it('holds from an adjusting key until the slider loses focus', () => {
    const el = slider();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(get(pageAdjustPreviewing)).toBe(false);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(get(pageAdjustPreviewing)).toBe(true);
    el.dispatchEvent(new FocusEvent('blur'));
    expect(get(pageAdjustPreviewing)).toBe(false);
  });

  it('stays on while any slider is still held', () => {
    const a = slider();
    const b = slider();
    pointer('pointerdown', a);
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    b.dispatchEvent(new FocusEvent('blur'));
    expect(get(pageAdjustPreviewing)).toBe(true);
    pointer('pointerup', window);
    expect(get(pageAdjustPreviewing)).toBe(false);
  });

  it('clears when the slider goes away mid-drag (drawer closed)', () => {
    const el = slider();
    pointer('pointerdown', el);
    cleanups.shift()!(); // the attachment's own cleanup
    expect(get(pageAdjustPreviewing)).toBe(false);
  });

  it("ignores another pointer's release while the slider is still held", () => {
    // A second finger, or the mouse on a touch laptop, must not end the drag.
    const el = slider();
    pointer('pointerdown', el, { pointerId: 7 });
    pointer('pointerdown', document.body, { pointerId: 8 });
    pointer('pointerup', document.body, { pointerId: 8 });
    expect(get(pageAdjustPreviewing)).toBe(true);
    pointer('pointercancel', window, { pointerId: 9 });
    expect(get(pageAdjustPreviewing)).toBe(true);
    pointer('pointerup', document.body, { pointerId: 7 });
    expect(get(pageAdjustPreviewing)).toBe(false);
  });

  it('holds until every pointer pressing the slider is released', () => {
    const el = slider();
    pointer('pointerdown', el, { pointerId: 1 });
    pointer('pointerdown', el, { pointerId: 2 });
    pointer('pointerup', window, { pointerId: 1 });
    expect(get(pageAdjustPreviewing)).toBe(true);
    pointer('pointercancel', window, { pointerId: 2 });
    expect(get(pageAdjustPreviewing)).toBe(false);
  });
});

describe('preview after an on/off flip (#362 + #363)', () => {
  function toggle(): HTMLInputElement {
    const el = document.createElement('input');
    el.type = 'checkbox';
    document.body.appendChild(el);
    cleanups.push(previewAfterChange(el), () => el.remove());
    return el;
  }

  it('clears the dim for a moment after each change, restarting on every flip', () => {
    vi.useFakeTimers();
    const el = toggle();
    expect(get(pageAdjustPreviewing)).toBe(false);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    expect(get(pageAdjustPreviewing)).toBe(true);
    vi.advanceTimersByTime(PREVIEW_AFTER_CHANGE_MS - 100);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    vi.advanceTimersByTime(PREVIEW_AFTER_CHANGE_MS - 100);
    expect(get(pageAdjustPreviewing)).toBe(true);
    vi.advanceTimersByTime(100);
    expect(get(pageAdjustPreviewing)).toBe(false);
  });

  it('clears when the toggle goes away (drawer closed) before the moment ends', () => {
    vi.useFakeTimers();
    const el = toggle();
    el.dispatchEvent(new Event('change', { bubbles: true }));
    cleanups.shift()!();
    expect(get(pageAdjustPreviewing)).toBe(false);
    vi.advanceTimersByTime(PREVIEW_AFTER_CHANGE_MS);
    expect(get(pageAdjustPreviewing)).toBe(false);
  });
});
