import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

const mocks = vi.hoisted(() => ({ updateSetting: vi.fn() }));

vi.mock('$lib/settings', async () => {
  const { writable } = await import('svelte/store');
  return {
    settings: writable({ pageBrightness: 130, pageContrast: 100 }),
    updateSetting: mocks.updateSetting
  };
});

import PageAdjustCard from '../PageAdjustCard.svelte';

afterEach(() => {
  cleanup();
  mocks.updateSetting.mockReset();
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
});
