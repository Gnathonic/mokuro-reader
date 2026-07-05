import { describe, it, expect, vi } from 'vitest';
import { onNextUserGesture } from './user-gesture';

describe('onNextUserGesture', () => {
  it('runs the callback synchronously inside the next pointerdown', () => {
    const fn = vi.fn();
    onNextUserGesture(fn);

    expect(fn).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pointerdown'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs on keydown too, but only once total', () => {
    const fn = vi.fn();
    onNextUserGesture(fn);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape keydown (does not count as an activation gesture)', () => {
    const fn = vi.fn();
    onNextUserGesture(fn);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(fn).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel() disarms without firing', () => {
    const fn = vi.fn();
    const cancel = onNextUserGesture(fn);

    cancel();
    window.dispatchEvent(new Event('pointerdown'));
    expect(fn).not.toHaveBeenCalled();
  });

  it('re-arming after fire works (new registration)', () => {
    const fn = vi.fn();
    onNextUserGesture(fn);
    window.dispatchEvent(new Event('pointerdown'));

    onNextUserGesture(fn);
    window.dispatchEvent(new Event('pointerdown'));

    expect(fn).toHaveBeenCalledTimes(2);
  });
});
