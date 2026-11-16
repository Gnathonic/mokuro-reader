import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get, writable } from 'svelte/store';

const settingsStore = vi.hoisted(() => {
  // A fresh writable per suite; the toggles only read `continuousScroll` plus
  // the boolean keys they list.
  let store: ReturnType<typeof import('svelte/store').writable<Record<string, unknown>>>;
  return {
    get: () => store,
    set: (s: typeof store) => (store = s)
  };
});

vi.mock('#lib/settings/index.js', async () => {
  const { writable, readable } = await import('svelte/store');
  const store = writable<Record<string, unknown>>({
    defaultFullscreen: false,
    textBoxBorders: false,
    displayOCR: true,
    alwaysShowOCR: false,
    boldFont: false,
    pageNum: true,
    charCount: false,
    bounds: false,
    mobile: false,
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
  });
  settingsStore.set(store);
  return {
    settings: store,
    nightModeActive: readable(false),
    invertColorsActive: readable(false),
    grayscaleActive: readable(false),
    updateSetting: vi.fn()
  };
});

vi.mock('../ScheduledFilterCard.svelte', async () => {
  const mod = await import('./__stub__/Empty.svelte');
  return { default: mod.default };
});

import ReaderToggles from '../ReaderToggles.svelte';
import { editModeActive, editModeRequest, setEditModeActive } from '#lib/reader/edit/edit-mode.js';

afterEach(() => {
  cleanup();
  setEditModeActive(false);
});

describe('ReaderToggles — Edit OCR text', () => {
  it('shows the toggle with its E shortcut, reflecting the reader edit state', async () => {
    const { getByText, getByLabelText } = render(ReaderToggles);
    const label = getByText('Edit OCR text');
    expect(label.textContent).toContain('(E)');
    const input = getByLabelText(/Edit OCR text/) as HTMLInputElement;
    expect(input.checked).toBe(false);
    setEditModeActive(true);
    await tick();
    expect(input.checked).toBe(true);
  });

  it('changing it requests edit mode on / off', async () => {
    const { getByLabelText } = render(ReaderToggles);
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
    settingsStore.get().update((s) => ({ ...s, continuousScroll: true }));
    const { getByLabelText, getByText } = render(ReaderToggles);
    const input = getByLabelText(/Edit OCR text/) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(getByText(/paged mode only/i)).toBeTruthy();
  });
});

describe('ReaderToggles — reading timer', () => {
  it('carries the cutoff and the long-pause question as one "Reading timer" group', () => {
    const { getByRole, getByLabelText, queryByLabelText } = render(ReaderToggles);
    expect(getByRole('heading', { name: 'Reading timer' })).toBeTruthy();
    const cutoff = getByLabelText('Stop the timer after');
    const ask = getByLabelText('Ask if I’m still reading');
    expect(cutoff.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The controls it replaced are gone.
    expect(queryByLabelText('Automatic idle cutoff')).toBeNull();
    expect(queryByLabelText('When a page stays open past the cutoff')).toBeNull();
  });
});

describe('ReaderToggles — page keys scroll tall pages (#283)', () => {
  it('lists the toggle next to the other input toggles and writes the setting', async () => {
    const { updateSetting } = await import('#lib/settings/index.js');
    vi.mocked(updateSetting).mockClear();
    settingsStore.get().update((s) => ({ ...s, continuousScroll: false }));
    const { getByLabelText } = render(ReaderToggles);
    const input = getByLabelText(
      /Page Up\/Down scroll tall pages before turning/
    ) as HTMLInputElement;
    expect(input.checked).toBe(true);
    const swap = getByLabelText(/Swap mouse wheel scroll\/zoom/);
    expect(swap.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await fireEvent.click(input);
    expect(updateSetting).toHaveBeenCalledWith('pageKeysScrollFirst', false);
  });

  it('stays visible in continuous scroll mode (the rule applies there too)', () => {
    settingsStore.get().update((s) => ({ ...s, continuousScroll: true }));
    const { getByLabelText } = render(ReaderToggles);
    expect(getByLabelText(/Page Up\/Down scroll tall pages before turning/)).toBeTruthy();
  });
});
