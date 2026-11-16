import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';

const mocks = vi.hoisted(() => ({ store: undefined as any, updateSetting: undefined as any }));

const BASE: Record<string, unknown> = {
  defaultFullscreen: false,
  textBoxBorders: false,
  displayOCR: true,
  alwaysShowOCR: false,
  boldFont: false,
  fontSize: 'auto',
  pageNum: true,
  charCount: false,
  bounds: false,
  mobile: false,
  tapOutsideImageToTurn: true,
  edgeButtonWidth: 40,
  swipeThreshold: 35,
  showTimer: false,
  quickActions: true,
  swapWheelBehavior: false,
  pageKeysScrollFirst: true,
  disableAnimations: false,
  textBoxContextMenu: false,
  continuousScroll: false,
  nightMode: false,
  invertColors: false,
  grayscale: false,
  nightModeSchedule: { enabled: false },
  invertColorsSchedule: { enabled: false },
  grayscaleSchedule: { enabled: false }
};

vi.mock('#lib/settings/index.js', async () => {
  const { writable, readable } = await import('svelte/store');
  mocks.store = writable<Record<string, unknown>>({});
  mocks.updateSetting = vi.fn();
  return {
    settings: mocks.store,
    nightModeActive: readable(false),
    invertColorsActive: readable(false),
    grayscaleActive: readable(false),
    updateSetting: mocks.updateSetting,
    EDGE_STRIP_MAX: 100
  };
});

vi.mock('../ScheduledFilterCard.svelte', async () => {
  const mod = await import('./__stub__/Empty.svelte');
  return { default: mod.default };
});

import ReaderControlsSettings from '../ReaderControlsSettings.svelte';
import ReaderTextSettings from '../ReaderTextSettings.svelte';
import ReaderOverlaySettings from '../ReaderOverlaySettings.svelte';
import PageTurnSettings from '../PageTurnSettings.svelte';
import { editModeActive, editModeRequest, setEditModeActive } from '#lib/reader/edit/edit-mode.js';

function use(overrides: Record<string, unknown> = {}) {
  mocks.store.set({ ...BASE, ...overrides });
}

/** Render a section and open its accordion item (closed by default). */
async function renderSection(component: any, header: string) {
  const result = render(component);
  await fireEvent.click(result.getByRole('button', { name: header }));
  await tick();
  return result;
}

afterEach(() => {
  cleanup();
  mocks.updateSetting.mockClear();
  setEditModeActive(false);
});

describe('Tap to turn pages — one group, one region per control (#54)', () => {
  it('holds the background toggle and the page-edge slider together', () => {
    use();
    const { getByRole } = render(PageTurnSettings);
    const heading = getByRole('heading', { name: 'Tap to turn pages' });
    const group = heading.parentElement!;
    expect(within(group).getByLabelText(/Tap beside or below the page/)).toBeTruthy();
    expect(within(group).getByLabelText(/Page edge zone/)).toBeTruthy();
  });

  it('the toggle reads and writes tapOutsideImageToTurn', async () => {
    use({ tapOutsideImageToTurn: false });
    const { getByLabelText } = render(PageTurnSettings);
    const toggle = getByLabelText(/Tap beside or below the page/) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await fireEvent.click(toggle);
    expect(mocks.updateSetting).toHaveBeenCalledWith('tapOutsideImageToTurn', true);
  });

  it('the slider runs 0–100, shows its width, and says off at 0', async () => {
    use({ edgeButtonWidth: 40 });
    const { getByLabelText, getByText } = render(PageTurnSettings);
    const slider = getByLabelText(/Page edge zone/) as HTMLInputElement;
    expect([slider.min, slider.max, slider.value]).toEqual(['0', '100', '40']);
    expect(getByText(/Page edge zone: 40px/)).toBeTruthy();

    slider.value = '0';
    await fireEvent.input(slider);
    expect(getByText(/Page edge zone: off/)).toBeTruthy();
    expect(mocks.updateSetting).not.toHaveBeenCalled(); // dragging writes nothing
    await fireEvent.change(slider);
    expect(mocks.updateSetting).toHaveBeenCalledWith('edgeButtonWidth', 0);
  });

  it('follows a profile switch (the slider is not a stale copy)', async () => {
    use({ edgeButtonWidth: 40 });
    const { getByLabelText } = render(PageTurnSettings);
    use({ edgeButtonWidth: 12 });
    await tick();
    expect((getByLabelText(/Page edge zone/) as HTMLInputElement).value).toBe('12');
  });

  it('names the screen edge only where those strips exist (desktop)', async () => {
    use({ mobile: false });
    const desktop = render(PageTurnSettings);
    expect(desktop.getByText(/screen edge over a zoomed-in page/)).toBeTruthy();
    cleanup();
    use({ mobile: true });
    const mobile = render(PageTurnSettings);
    expect(mobile.queryByText(/screen edge/)).toBeNull();
  });

  it('does not promise page-turn gestures the reader lacks without Mobile', () => {
    // Swipe-to-flip runs only with `mobile` on (PagedViewport's onPanEnd).
    use();
    const { getByText } = render(PageTurnSettings);
    expect(getByText(/swipes do with Mobile on/)).toBeTruthy();
  });
});

describe('Controls section', () => {
  it('gathers the reader-input options, tap-to-turn among them', async () => {
    use();
    const { getByLabelText, getByRole } = await renderSection(ReaderControlsSettings, 'Controls');
    const order = [
      getByLabelText(/^Mobile/),
      getByLabelText(/^Bounds/),
      getByRole('heading', { name: 'Tap to turn pages' }),
      getByLabelText(/Swipe threshold/),
      getByLabelText(/Swap mouse wheel scroll\/zoom/),
      getByLabelText(/Page Up\/Down scroll tall pages before turning/)
    ];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
  });

  it('page keys: writes the setting (#283)', async () => {
    use();
    const { getByLabelText } = await renderSection(ReaderControlsSettings, 'Controls');
    const input = getByLabelText(/Page Up\/Down scroll/) as HTMLInputElement;
    expect(input.checked).toBe(true);
    await fireEvent.click(input);
    expect(mocks.updateSetting).toHaveBeenCalledWith('pageKeysScrollFirst', false);
  });

  it('continuous scroll hides the paged-only controls, keeps wheel and keys', async () => {
    use({ continuousScroll: true });
    const { queryByLabelText, queryByRole, getByLabelText } = await renderSection(
      ReaderControlsSettings,
      'Controls'
    );
    expect(queryByRole('heading', { name: 'Tap to turn pages' })).toBeNull();
    expect(queryByLabelText(/^Mobile/)).toBeNull();
    expect(queryByLabelText(/^Bounds/)).toBeNull();
    expect(queryByLabelText(/Swipe threshold/)).toBeNull();
    expect(getByLabelText(/Swap mouse wheel/)).toBeTruthy();
    expect(getByLabelText(/Page Up\/Down scroll/)).toBeTruthy();
  });

  it('the swipe threshold is disabled without Mobile', async () => {
    use({ mobile: false });
    const { getByLabelText } = await renderSection(ReaderControlsSettings, 'Controls');
    expect((getByLabelText(/Swipe threshold/) as HTMLInputElement).disabled).toBe(true);
  });
});

describe('Text & OCR section — Edit OCR text', () => {
  it('shows the toggle with its E shortcut, reflecting the reader edit state', async () => {
    use();
    const { getByText, getByLabelText } = await renderSection(ReaderTextSettings, 'Text & OCR');
    expect(getByText('Edit OCR text').textContent).toContain('(E)');
    const input = getByLabelText(/Edit OCR text/) as HTMLInputElement;
    expect(input.checked).toBe(false);
    setEditModeActive(true);
    await tick();
    expect(input.checked).toBe(true);
  });

  it('changing it requests edit mode on / off', async () => {
    use();
    const { getByLabelText } = await renderSection(ReaderTextSettings, 'Text & OCR');
    const input = getByLabelText(/Edit OCR text/) as HTMLInputElement;
    const seq = get(editModeRequest).seq;
    await fireEvent.click(input);
    expect(get(editModeRequest)).toMatchObject({ on: true, seq: seq + 1 });
    setEditModeActive(true);
    await tick();
    await fireEvent.click(input);
    expect(get(editModeRequest)).toMatchObject({ on: false, seq: seq + 2 });
    expect(get(editModeActive)).toBe(true); // only the reader flips the active state
  });

  it('is disabled with a hint in continuous scroll mode', async () => {
    use({ continuousScroll: true });
    const { getByLabelText, getByText } = await renderSection(ReaderTextSettings, 'Text & OCR');
    expect((getByLabelText(/Edit OCR text/) as HTMLInputElement).disabled).toBe(true);
    expect(getByText(/paged mode only/i)).toBeTruthy();
  });

  it('carries the font size with the other text options', async () => {
    use({ fontSize: '24' });
    const { getByLabelText } = await renderSection(ReaderTextSettings, 'Text & OCR');
    const select = getByLabelText('Font size:') as HTMLSelectElement;
    expect(select.value).toBe('24');
    select.value = 'original';
    await fireEvent.change(select);
    expect(mocks.updateSetting).toHaveBeenCalledWith('fontSize', 'original');
  });
});

describe('Overlays & timer section — reading timer', () => {
  it('carries the cutoff and the long-pause question as one "Reading timer" group', async () => {
    use();
    const { getByRole, getByLabelText, queryByLabelText } = await renderSection(
      ReaderOverlaySettings,
      'Overlays & timer'
    );
    expect(getByRole('heading', { name: 'Reading timer' })).toBeTruthy();
    const cutoff = getByLabelText('Stop the timer after');
    const ask = getByLabelText('Ask if I’m still reading');
    expect(cutoff.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getByLabelText('Show timer')).toBeTruthy();
    // The controls it replaced are gone.
    expect(queryByLabelText('Automatic idle cutoff')).toBeNull();
    expect(queryByLabelText('When a page stays open past the cutoff')).toBeNull();
  });
});
