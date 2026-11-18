import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';

const mocks = vi.hoisted(() => ({ updateSetting: vi.fn() }));

vi.mock('#lib/settings/index.js', async () => {
  const { writable } = await import('svelte/store');
  return {
    settings: writable({ pageBrightness: 130, pageContrast: 100 }),
    updateSetting: mocks.updateSetting
  };
});

import PageAdjustPanel from '../PageAdjustPanel.svelte';
import {
  closePageAdjustPanel,
  openPageAdjustPanel,
  pageAdjustPanelOpen
} from '#lib/reader/page-adjust-panel.js';
import { settings } from '#lib/settings/index.js';
import type { Writable } from 'svelte/store';

const store = settings as unknown as Writable<Record<string, unknown>>;
const base = { pageBrightness: 130, pageContrast: 100 };

beforeEach(() => openPageAdjustPanel());

afterEach(() => {
  cleanup();
  mocks.updateSetting.mockReset();
  store.set({ ...base });
  closePageAdjustPanel();
});

const slider = (getByLabelText: (t: string) => HTMLElement, name: string) =>
  getByLabelText(name) as HTMLInputElement;

describe('PageAdjustPanel (#362, #363)', () => {
  it('shows each value with a 50–200 step-5 slider', () => {
    const { getByLabelText, container } = render(PageAdjustPanel);
    const brightness = slider(getByLabelText, 'Brightness');
    expect([brightness.min, brightness.max, brightness.step, brightness.value]).toEqual([
      '50',
      '200',
      '5',
      '130'
    ]);
    expect(slider(getByLabelText, 'Contrast').value).toBe('100');
    expect(container.querySelector('[data-value="pageBrightness"]')!.textContent).toBe('130%');
    expect(container.querySelector('[data-value="pageContrast"]')!.textContent).toBe('100%');
  });

  it('writes the setting live while dragging, and only the value while on', async () => {
    const { getByLabelText } = render(PageAdjustPanel);
    const contrast = slider(getByLabelText, 'Contrast');
    contrast.value = '150';
    await fireEvent.input(contrast);
    expect(mocks.updateSetting).toHaveBeenCalledWith('pageContrast', 150);
    expect(mocks.updateSetting).toHaveBeenCalledTimes(1);
  });

  it('moving a slider while switched off switches the adjustment back on', async () => {
    store.set({ ...base, pageAdjustEnabled: false });
    const { getByLabelText } = render(PageAdjustPanel);
    const brightness = slider(getByLabelText, 'Brightness');
    brightness.value = '140';
    await fireEvent.input(brightness);
    expect(mocks.updateSetting).toHaveBeenCalledWith('pageBrightness', 140);
    expect(mocks.updateSetting).toHaveBeenCalledWith('pageAdjustEnabled', true);
  });

  it('resets a changed value to 100; its reset stays in place, disabled, at 100', async () => {
    const { getByRole } = render(PageAdjustPanel);
    const resetBrightness = getByRole('button', { name: 'Reset brightness' });
    const resetContrast = getByRole('button', { name: 'Reset contrast' });
    expect(resetBrightness.hasAttribute('disabled')).toBe(false);
    expect(resetContrast.hasAttribute('disabled')).toBe(true);
    await fireEvent.click(resetBrightness);
    expect(mocks.updateSetting).toHaveBeenCalledWith('pageBrightness', 100);
  });

  it('switches the adjustment off and on; off fades the rows, nothing goes away', async () => {
    const { getByRole, getByLabelText } = render(PageAdjustPanel);
    const toggle = getByRole('checkbox', { name: /Brightness & contrast/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await fireEvent.click(toggle);
    expect(mocks.updateSetting).toHaveBeenCalledWith('pageAdjustEnabled', false);

    store.set({ ...base, pageAdjustEnabled: false });
    await tick();
    expect(toggle.checked).toBe(false);
    const rows = slider(getByLabelText, 'Brightness').closest('.grid')!.parentElement!;
    expect(rows.classList.contains('opacity-50')).toBe(true);
    // Values kept and still shown.
    expect(slider(getByLabelText, 'Brightness').value).toBe('130');
  });

  it('takes keyboard focus on its first slider when it opens', () => {
    const { getByLabelText } = render(PageAdjustPanel);
    expect(document.activeElement).toBe(slider(getByLabelText, 'Brightness'));
  });

  it('Escape closes it — and goes no further (never the reader, never "back")', async () => {
    render(PageAdjustPanel);
    const bubbled = vi.fn();
    window.addEventListener('keydown', bubbled);
    try {
      // From the page (focus outside the panel)…
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })
      );
      expect(get(pageAdjustPanelOpen)).toBe(false);
      expect(bubbled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', bubbled);
    }
  });

  it('Escape closes a reader control opened over it first, unless focus is in the panel', async () => {
    let otherOpen = true;
    const onEscapeElsewhere = vi.fn(() => {
      const had = otherOpen;
      otherOpen = false;
      return had;
    });
    const { getByLabelText } = render(PageAdjustPanel, { onEscapeElsewhere });
    const bubbled = vi.fn();
    window.addEventListener('keydown', bubbled);
    const escape = (at: Element) =>
      at.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })
      );
    try {
      // The page-number popover (say) was opened since: it closes, the panel
      // stays — and the key goes no further ("back" would leave the reader).
      escape(document.body);
      expect(onEscapeElsewhere).toHaveBeenCalledTimes(1);
      expect(get(pageAdjustPanelOpen)).toBe(true);
      // Nothing else open now: the next Escape is the panel's.
      escape(document.body);
      expect(get(pageAdjustPanelOpen)).toBe(false);
      // Typed in the panel itself: the panel's, whatever else is open.
      openPageAdjustPanel();
      await tick();
      otherOpen = true;
      onEscapeElsewhere.mockClear();
      escape(slider(getByLabelText, 'Brightness'));
      expect(onEscapeElsewhere).not.toHaveBeenCalled();
      expect(get(pageAdjustPanelOpen)).toBe(false);
      expect(bubbled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', bubbled);
    }
  });

  it('a control with the focus that handles Escape itself gets it first (the OCR text editor)', async () => {
    const onEscapeElsewhere = vi.fn(() => true);
    render(PageAdjustPanel, { onEscapeElsewhere });
    const bubbled = vi.fn();
    window.addEventListener('keydown', bubbled);
    // Like EditableBlock's line: Escape closes the editor and stops there.
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    const closeEditor = vi.fn((e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
    });
    editor.addEventListener('keydown', closeEditor);
    // One that only prevents the default: it took the key too.
    const field = document.createElement('input');
    field.addEventListener('keydown', (e) => e.preventDefault());
    document.body.append(editor, field);
    const escape = (at: Element) =>
      at.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          bubbles: true,
          cancelable: true
        })
      );
    try {
      escape(editor);
      expect(closeEditor).toHaveBeenCalledTimes(1);
      escape(field);
      expect(onEscapeElsewhere).not.toHaveBeenCalled();
      expect(get(pageAdjustPanelOpen)).toBe(true);
      // Neither went on to "back".
      expect(bubbled).not.toHaveBeenCalled();
      // With the editor closed, the next Escape is the reader's/panel's again.
      escape(document.body);
      expect(onEscapeElsewhere).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', bubbled);
      editor.remove();
      field.remove();
    }
  });

  it('opened while a modal dialog is still closing, it takes focus once the dialog closes', async () => {
    // The drawer's <dialog> is still modal when its card opens the panel, so
    // the page is inert and the first focus() is refused. jsdom does not do
    // inertness: refuse focus by hand while the dialog is up.
    let closed = false;
    const dialog = document.createElement('dialog');
    document.body.append(dialog);
    const matches = Element.prototype.matches;
    const modal = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
      this: Element,
      sel: string
    ) {
      if (sel === ':modal') return this === dialog && !closed;
      return matches.call(this, sel);
    });
    const focus = HTMLElement.prototype.focus;
    const refuse = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions
    ) {
      if (closed) focus.call(this, options);
    });
    try {
      const { getByLabelText } = render(PageAdjustPanel);
      expect(document.activeElement).not.toBe(slider(getByLabelText, 'Brightness'));
      closed = true;
      dialog.dispatchEvent(new Event('close'));
      expect(document.activeElement).toBe(slider(getByLabelText, 'Brightness'));
    } finally {
      refuse.mockRestore();
      modal.mockRestore();
      dialog.remove();
    }
  });

  it('A inside the panel closes it; B flips the adjustment through the reader', async () => {
    const onToggleAdjust = vi.fn();
    const { getByLabelText } = render(PageAdjustPanel, { onToggleAdjust });
    const brightness = slider(getByLabelText, 'Brightness');
    await fireEvent.keyDown(brightness, { key: 'b', code: 'KeyB' });
    expect(onToggleAdjust).toHaveBeenCalledTimes(1);
    expect(get(pageAdjustPanelOpen)).toBe(true);
    // A modifier chord is not the key (a dictionary scan holds Shift).
    await fireEvent.keyDown(brightness, { key: 'A', code: 'KeyA', shiftKey: true });
    expect(get(pageAdjustPanelOpen)).toBe(true);
    await fireEvent.keyDown(brightness, { key: 'a', code: 'KeyA' });
    expect(get(pageAdjustPanelOpen)).toBe(false);
  });

  it('the close button closes it', async () => {
    const { getByRole } = render(PageAdjustPanel);
    await fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(get(pageAdjustPanelOpen)).toBe(false);
  });

  it('stops listening for Escape once it is gone', async () => {
    const { unmount } = render(PageAdjustPanel);
    unmount();
    openPageAdjustPanel();
    const bubbled = vi.fn();
    window.addEventListener('keydown', bubbled);
    try {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })
      );
      expect(bubbled).toHaveBeenCalledTimes(1);
      expect(get(pageAdjustPanelOpen)).toBe(true);
    } finally {
      window.removeEventListener('keydown', bubbled);
    }
  });
});
