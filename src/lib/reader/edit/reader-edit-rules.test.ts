import { describe, expect, it, vi } from 'vitest';
import {
  beforeLayerMutation,
  flushOnPageHide,
  layerUiKeyAction,
  registerBeforeLayerMutation
} from './reader-edit-rules';

describe('flushOnPageHide', () => {
  function setHidden(hidden: boolean) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  }

  it('flushes when the tab is hidden and on pagehide, not when it becomes visible', () => {
    const flush = vi.fn();
    const stop = flushOnPageHide(flush);
    try {
      setHidden(false);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(flush).not.toHaveBeenCalled();

      setHidden(true);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(flush).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new Event('pagehide'));
      expect(flush).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      setHidden(false);
    }
  });

  it('stops listening once detached', () => {
    const flush = vi.fn();
    const stop = flushOnPageHide(flush);
    stop();
    setHidden(true);
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    } finally {
      setHidden(false);
    }
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('layerUiKeyAction', () => {
  const closed = { pickerOpen: false, namePromptOpen: false };

  it('passes every key through when no layer UI is open', () => {
    expect(layerUiKeyAction('Escape', closed)).toBe('pass');
    expect(layerUiKeyAction('ArrowLeft', closed)).toBe('pass');
  });

  it('with the picker open, Escape closes it and every other shortcut is swallowed', () => {
    const open = { pickerOpen: true, namePromptOpen: false };
    expect(layerUiKeyAction('Escape', open)).toBe('close-picker');
    expect(layerUiKeyAction('ArrowLeft', open)).toBe('swallow');
    expect(layerUiKeyAction('KeyE', open)).toBe('swallow');
  });

  it('the name prompt owns its own Escape (native dialog): everything is swallowed', () => {
    const open = { pickerOpen: false, namePromptOpen: true };
    expect(layerUiKeyAction('Escape', open)).toBe('swallow');
    expect(layerUiKeyAction('Space', open)).toBe('swallow');
    // The prompt sits above the picker when both are up.
    expect(layerUiKeyAction('Escape', { pickerOpen: true, namePromptOpen: true })).toBe('swallow');
  });
});

describe('beforeLayerMutation', () => {
  it('resolves at once when no reader has registered (nothing can be unsaved)', async () => {
    await expect(beforeLayerMutation('promote')).resolves.toBeUndefined();
  });

  it('awaits the registered reader hook with the action, until it is unregistered', async () => {
    const seen: string[] = [];
    let settled = false;
    const unregister = registerBeforeLayerMutation(async (action) => {
      seen.push(action);
      await Promise.resolve();
      settled = true;
    });
    await beforeLayerMutation('new');
    expect(seen).toEqual(['new']);
    expect(settled).toBe(true);

    unregister();
    await beforeLayerMutation('delete');
    expect(seen).toEqual(['new']);
  });

  it("a stale unregister never removes a newer reader's hook", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const unregisterFirst = registerBeforeLayerMutation(first);
    const unregisterSecond = registerBeforeLayerMutation(second);
    unregisterFirst();
    await beforeLayerMutation('promote');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('promote');
    unregisterSecond();
  });
});
