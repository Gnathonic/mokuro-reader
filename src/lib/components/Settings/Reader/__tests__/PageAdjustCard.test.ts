import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

const mocks = vi.hoisted(() => ({ updateSetting: vi.fn() }));

vi.mock('$lib/settings', async () => {
  const { writable } = await import('svelte/store');
  return {
    settings: writable({ pageBrightness: 130, pageContrast: 100, pageInkColor: 'auto' }),
    updateSetting: mocks.updateSetting
  };
});

import PageAdjustCard from '../PageAdjustCard.svelte';
import { settings } from '$lib/settings';
import type { Writable } from 'svelte/store';

const store = settings as unknown as Writable<Record<string, unknown>>;
const base = { pageBrightness: 130, pageContrast: 100, pageInkColor: 'auto' };

afterEach(() => {
  cleanup();
  mocks.updateSetting.mockReset();
  store.set({ ...base });
});

describe('PageAdjustCard (#256)', () => {
  it('shows each value with a 50–200 step-5 slider', () => {
    const { getByLabelText } = render(PageAdjustCard);
    const brightness = getByLabelText('Brightness: 130%') as HTMLInputElement;
    expect(brightness.value).toBe('130');
    expect(brightness.min).toBe('50');
    expect(brightness.max).toBe('200');
    expect(brightness.step).toBe('5');
    expect((getByLabelText('Contrast: 100%') as HTMLInputElement).value).toBe('100');
  });

  it('writes the setting live while dragging', async () => {
    const { getByLabelText } = render(PageAdjustCard);
    const contrast = getByLabelText('Contrast: 100%') as HTMLInputElement;
    contrast.value = '150';
    await fireEvent.input(contrast);
    expect(mocks.updateSetting).toHaveBeenCalledWith('pageContrast', 150);
  });

  it('resets a changed value to 100 and disables reset at 100', async () => {
    const { getByRole } = render(PageAdjustCard);
    const resetBrightness = getByRole('button', { name: 'Reset brightness' });
    const resetContrast = getByRole('button', { name: 'Reset contrast' });
    expect(resetBrightness.hasAttribute('disabled')).toBe(false);
    expect(resetContrast.hasAttribute('disabled')).toBe(true);
    await fireEvent.click(resetBrightness);
    await tick();
    expect(mocks.updateSetting).toHaveBeenCalledWith('pageBrightness', 100);
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
