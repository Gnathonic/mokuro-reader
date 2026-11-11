import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';

const mocks = vi.hoisted(() => ({ store: undefined as any, updateSetting: undefined as any }));

vi.mock('$lib/settings', async () => {
  const { writable, readable } = await import('svelte/store');
  mocks.store = writable<Record<string, unknown>>({
    tapPageEdgesToTurn: true,
    continuousScroll: false,
    nightModeSchedule: { enabled: false },
    invertColorsSchedule: { enabled: false },
    grayscaleSchedule: { enabled: false }
  });
  mocks.updateSetting = vi.fn();
  return {
    settings: mocks.store,
    nightModeActive: readable(false),
    invertColorsActive: readable(false),
    grayscaleActive: readable(false),
    updateSetting: mocks.updateSetting
  };
});

vi.mock('../ScheduledFilterCard.svelte', async () => {
  const mod = await import('./__stub__/Empty.svelte');
  return { default: mod.default };
});

import ReaderToggles from '../ReaderToggles.svelte';

afterEach(() => {
  cleanup();
  mocks.updateSetting.mockClear();
  mocks.store.update((s: Record<string, unknown>) => ({
    ...s,
    tapPageEdgesToTurn: true,
    continuousScroll: false
  }));
});

describe('ReaderToggles — Tap page edges to turn pages (#54)', () => {
  it('is on by default and switching it off writes false', async () => {
    const { getByLabelText } = render(ReaderToggles);
    const input = getByLabelText(/Tap page edges to turn pages/) as HTMLInputElement;
    expect(input.checked).toBe(true);
    await fireEvent.click(input);
    expect(mocks.updateSetting).toHaveBeenCalledWith('tapPageEdgesToTurn', false);
  });

  it('reflects an off profile and switching it on writes true', async () => {
    mocks.store.update((s: Record<string, unknown>) => ({ ...s, tapPageEdgesToTurn: false }));
    const { getByLabelText } = render(ReaderToggles);
    const input = getByLabelText(/Tap page edges to turn pages/) as HTMLInputElement;
    expect(input.checked).toBe(false);
    await fireEvent.click(input);
    expect(mocks.updateSetting).toHaveBeenCalledWith('tapPageEdgesToTurn', true);
  });

  it('does not promise page-turn gestures the reader lacks without Mobile', () => {
    // Swipe-to-flip runs only with `mobile` on (PagedViewport's onPanEnd) and
    // the paged wheel pans/zooms, never turns — a Desktop-profile tablet user
    // reading "swipes still work" would turn this off and be left with no
    // touch page turn at all.
    const { getByText } = render(ReaderToggles);
    const text = getByText(/turns pages by accident/).textContent ?? '';
    expect(text).toMatch(/swipes do only with Mobile on/);
    expect(text).not.toMatch(/wheel/i);
  });

  it('is hidden in continuous scroll, which has no tap-to-turn zones', () => {
    mocks.store.update((s: Record<string, unknown>) => ({ ...s, continuousScroll: true }));
    const { queryByLabelText } = render(ReaderToggles);
    expect(queryByLabelText(/Tap page edges to turn pages/)).toBeNull();
  });
});
