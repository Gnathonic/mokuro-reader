import { describe, expect, it, vi } from 'vitest';
import { OCR_LAYER_ID } from '$lib/engines/engine-runs';
import {
  beforeLayerMutation,
  engineRunEditBlock,
  engineRunTouchesLayer,
  flushOnPageHide,
  layerUiKeyAction,
  registerBeforeLayerMutation,
  resolveEngineRunPages
} from './reader-edit-rules';

describe('resolveEngineRunPages', () => {
  it('targets the page the editor was on BEFORE the session closes (right page of a spread)', async () => {
    // Mirrors Reader: with a session open the active page is the right-hand
    // page (5); once the session is gone the reader falls back to its base
    // index (4) — the left page.
    let sessionOpen = true;
    const pages = await resolveEngineRunPages({
      scope: 'page',
      pageCount: 10,
      activePage: () => (sessionOpen ? 5 : 4),
      closeSession: async () => {
        sessionOpen = false;
      }
    });
    expect(pages).toEqual([5]);
    expect(sessionOpen).toBe(false);
  });

  it('a volume run covers every page and still closes the session first', async () => {
    const closeSession = vi.fn(async () => {});
    const pages = await resolveEngineRunPages({
      scope: 'volume',
      pageCount: 3,
      activePage: () => 1,
      closeSession
    });
    expect(pages).toEqual([0, 1, 2]);
    expect(closeSession).toHaveBeenCalledTimes(1);
  });
});

describe('engineRunTouchesLayer', () => {
  it('an OCR run writes only its own layer', () => {
    expect(engineRunTouchesLayer('ocr', OCR_LAYER_ID)).toBe(true);
    expect(engineRunTouchesLayer('ocr', null)).toBe(false);
    expect(engineRunTouchesLayer('ocr', 'my-edit')).toBe(false);
  });

  it('a translation run counts for every layer (its target id depends on prefs)', () => {
    expect(engineRunTouchesLayer('translate', null)).toBe(true);
    expect(engineRunTouchesLayer('translate', 'tr-en')).toBe(true);
    expect(engineRunTouchesLayer('translate', OCR_LAYER_ID)).toBe(true);
  });
});

describe('engineRunEditBlock', () => {
  it('no run, or a run on another volume, never blocks', () => {
    expect(engineRunEditBlock(null, 'v1', null)).toBeNull();
    expect(engineRunEditBlock({ kind: 'translate', volumeUuid: 'v2' }, 'v1', null)).toBeNull();
    expect(engineRunEditBlock({ kind: 'ocr', volumeUuid: 'v2' }, 'v1', OCR_LAYER_ID)).toBeNull();
    expect(engineRunEditBlock({ kind: 'ocr', volumeUuid: 'v1' }, undefined, null)).toBeNull();
  });

  it('a translation run on this volume blocks editing, with a reason naming it', () => {
    const reason = engineRunEditBlock({ kind: 'translate', volumeUuid: 'v1' }, 'v1', null);
    expect(reason).toMatch(/translation/i);
    expect(engineRunEditBlock({ kind: 'translate', volumeUuid: 'v1' }, 'v1', 'tr-en')).toBe(reason);
  });

  it('an OCR run on this volume blocks the layer it writes, not the others', () => {
    expect(engineRunEditBlock({ kind: 'ocr', volumeUuid: 'v1' }, 'v1', OCR_LAYER_ID)).toMatch(
      /OCR/
    );
    expect(engineRunEditBlock({ kind: 'ocr', volumeUuid: 'v1' }, 'v1', null)).toBeNull();
    expect(engineRunEditBlock({ kind: 'ocr', volumeUuid: 'v1' }, 'v1', 'my-edit')).toBeNull();
  });
});

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
