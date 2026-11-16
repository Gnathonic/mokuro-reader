import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';

const mocks = vi.hoisted(() => ({ updateSetting: vi.fn() }));

vi.mock('#lib/settings/index.js', async () => {
  const { writable } = await import('svelte/store');
  return {
    settings: writable({ pageBrightness: 130, pageContrast: 100, pageInkColor: 'auto' }),
    updateSetting: mocks.updateSetting
  };
});

import PageAdjustCard from '../PageAdjustCard.svelte';
import { closePageAdjustPanel, pageAdjustPanelOpen } from '#lib/reader/page-adjust-panel.js';
import { currentView } from '#lib/util/hash-router.js';
import { settings } from '#lib/settings/index.js';
import type { Writable } from 'svelte/store';

const store = settings as unknown as Writable<Record<string, unknown>>;
const base = { pageBrightness: 130, pageContrast: 100, pageInkColor: 'auto' };

afterEach(() => {
  cleanup();
  mocks.updateSetting.mockReset();
  store.set({ ...base });
  closePageAdjustPanel();
  currentView.set({ type: 'catalog' });
});

describe('PageAdjustCard (#256)', () => {
  it('shows the current brightness and contrast', async () => {
    const { getByText } = render(PageAdjustCard);
    expect(getByText('Brightness 130% · Contrast 100%')).toBeTruthy();
    store.set({ ...base, pageBrightness: 'junk', pageContrast: 150 });
    await tick();
    // Unset or garbage reads as 100%, like the filter itself.
    expect(getByText('Brightness 100% · Contrast 150%')).toBeTruthy();
  });

  it('has no brightness/contrast sliders: they live over the page (#363)', () => {
    const { queryByRole } = render(PageAdjustCard);
    expect(queryByRole('slider', { name: /Brightness/ })).toBeNull();
    expect(queryByRole('slider', { name: /Contrast/ })).toBeNull();
  });

  it('in the reader, opens the page image panel (#363)', async () => {
    currentView.set({ type: 'reader', seriesId: 's', volumeId: 'v' });
    const { getByRole } = render(PageAdjustCard);
    expect(get(pageAdjustPanelOpen)).toBe(false);
    await fireEvent.click(getByRole('button', { name: /Adjust over the page/ }));
    expect(get(pageAdjustPanelOpen)).toBe(true);
    // Opening it writes nothing.
    expect(mocks.updateSetting).not.toHaveBeenCalled();
  });

  it('outside the reader, says where the values are adjusted instead', () => {
    const { queryByRole, getByText } = render(PageAdjustCard);
    expect(queryByRole('button', { name: /Adjust over the page/ })).toBeNull();
    expect(getByText(/in the reader: press A/)).toBeTruthy();
  });

  it('switches the adjustment off and on without touching the values (#362)', async () => {
    const { getByRole } = render(PageAdjustCard);
    const toggle = getByRole('checkbox', { name: /Brightness & contrast/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await fireEvent.click(toggle);
    expect(mocks.updateSetting).toHaveBeenCalledWith('pageAdjustEnabled', false);
    expect(mocks.updateSetting).not.toHaveBeenCalledWith('pageBrightness', expect.anything());

    store.set({ ...base, pageAdjustEnabled: false });
    await tick();
    expect(toggle.checked).toBe(false);
    mocks.updateSetting.mockClear();
    await fireEvent.click(toggle);
    expect(mocks.updateSetting).toHaveBeenCalledWith('pageAdjustEnabled', true);
  });

  it('offers ink color off/auto/seven colors, showing the stored choice', () => {
    const { getByLabelText } = render(PageAdjustCard);
    const select = getByLabelText(/Magazine print effect/) as HTMLSelectElement;
    expect(select.value).toBe('auto');
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'off',
      'auto',
      'red',
      'orange',
      'yellow',
      'green',
      'blue',
      'violet',
      'pink'
    ]);
  });

  it('writes the chosen ink color', async () => {
    const { getByLabelText } = render(PageAdjustCard);
    const select = getByLabelText(/Magazine print effect/) as HTMLSelectElement;
    select.value = 'green';
    await fireEvent.change(select);
    expect(mocks.updateSetting).toHaveBeenCalledWith('pageInkColor', 'green');
  });

  it('shows the print effect controls only while the effect is on', async () => {
    store.set({ ...base, pageInkColor: 'off' });
    const { queryByLabelText } = render(PageAdjustCard);
    expect(queryByLabelText(/Ink strength/)).toBeNull();
    expect(queryByLabelText(/Paper tint/)).toBeNull();
    expect(queryByLabelText(/Paper age/)).toBeNull();
    store.set({ ...base, pageInkColor: 'blue' });
    await tick();
    expect(queryByLabelText('Ink strength: 0')).not.toBeNull();
    expect(queryByLabelText('Paper tint: 8%')).not.toBeNull();
    expect(queryByLabelText('Paper age: 0')).not.toBeNull();
  });

  it('gives each control its range and shows stored values', () => {
    store.set({ ...base, pageInkStrength: 40, pagePaperTint: 30, pagePaperAge: 55 });
    const { getByLabelText } = render(PageAdjustCard);
    const strength = getByLabelText('Ink strength: +40') as HTMLInputElement;
    expect([strength.min, strength.max, strength.value]).toEqual(['-100', '100', '40']);
    const tint = getByLabelText('Paper tint: 30%') as HTMLInputElement;
    expect([tint.min, tint.max, tint.value]).toEqual(['0', '30', '30']);
    const age = getByLabelText('Paper age: 55') as HTMLInputElement;
    expect([age.min, age.max, age.value]).toEqual(['0', '100', '55']);
  });

  it('writes the controls live and resets each to its default', async () => {
    store.set({ ...base, pageInkStrength: -60, pagePaperTint: 8, pagePaperAge: 0 });
    const { getByLabelText, getByRole } = render(PageAdjustCard);
    const age = getByLabelText('Paper age: 0') as HTMLInputElement;
    age.value = '70';
    await fireEvent.input(age);
    expect(mocks.updateSetting).toHaveBeenCalledWith('pagePaperAge', 70);
    expect(getByRole('button', { name: 'Reset paper tint' }).hasAttribute('disabled')).toBe(true);
    await fireEvent.click(getByRole('button', { name: 'Reset ink strength' }));
    expect(mocks.updateSetting).toHaveBeenCalledWith('pageInkStrength', 0);
  });
});
