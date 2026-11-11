import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCapture } from './capture-session';

function press(init: KeyboardEventInit, target: EventTarget = document.body) {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

describe('startCapture', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    localStorage.clear();
  });

  it('records the first non-modifier key with the modifiers held, and swallows it', () => {
    const onChord = vi.fn();
    const later = vi.fn();
    window.addEventListener('keydown', later);
    stop = startCapture(null, { onChord, onCancel: vi.fn() });
    const shift = press({ code: 'ShiftLeft', key: 'Shift', shiftKey: true });
    expect(onChord).not.toHaveBeenCalled();
    expect(shift.defaultPrevented).toBe(true);
    const d = press({ code: 'KeyD', key: 'D', shiftKey: true });
    expect(onChord).toHaveBeenCalledWith('Shift+KeyD');
    expect(d.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    window.removeEventListener('keydown', later);
    // Recording ended: the next key is the page's again.
    const next = press({ code: 'KeyD', key: 'd' });
    expect(next.defaultPrevented).toBe(false);
    expect(onChord).toHaveBeenCalledOnce();
  });

  it('Escape cancels and is swallowed', () => {
    const onCancel = vi.fn();
    const onChord = vi.fn();
    stop = startCapture(null, { onChord, onCancel });
    const esc = press({ code: 'Escape', key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onChord).not.toHaveBeenCalled();
    expect(esc.defaultPrevented).toBe(true);
  });

  it('Tab passes through (focus moves) and ends recording', () => {
    const onCancel = vi.fn();
    stop = startCapture(null, { onChord: vi.fn(), onCancel });
    const tab = press({ code: 'Tab', key: 'Tab' });
    expect(tab.defaultPrevented).toBe(false);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('a press outside the owner cancels; inside it does not', () => {
    const owner = document.createElement('button');
    const outside = document.createElement('div');
    document.body.append(owner, outside);
    const onCancel = vi.fn();
    stop = startCapture(owner, { onChord: vi.fn(), onCancel });
    owner.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onCancel).not.toHaveBeenCalled();
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onCancel).toHaveBeenCalledOnce();
    owner.remove();
    outside.remove();
  });

  it('learns the glyph a layout key prints', async () => {
    const { labelForCode } = await import('./key-labels');
    stop = startCapture(null, { onChord: vi.fn(), onCancel: vi.fn() });
    press({ code: 'KeyQ', key: 'a' });
    expect(labelForCode('KeyQ')).toBe('A');
    expect(JSON.parse(localStorage.getItem('keyLabels') ?? '{}')).toEqual({ KeyQ: 'a' });
  });
});
