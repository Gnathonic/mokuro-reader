import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import ReadingTimerSetting from '../ReadingTimerSetting.svelte';
import { askOnLongPause, setTrackingStates, trackingState } from '$lib/settings/tracking-data';

const T1 = '2026-10-01T00:00:00.000Z';
const STOP = 'Stop the timer after';
const ASK = 'Ask if I’m still reading';

beforeEach(() => setTrackingStates({}));

const select = (getByLabelText: (text: string) => HTMLElement) =>
  getByLabelText(STOP) as HTMLSelectElement;

describe('ReadingTimerSetting', () => {
  it('is one "Reading timer" group that says what the cutoff does', () => {
    const { getByRole, getByText } = render(ReadingTimerSetting);
    expect(getByRole('heading', { name: 'Reading timer' })).toBeTruthy();
    expect(
      getByText(
        'If a page stays open longer than this without a page turn, the extra time isn’t counted. Automatic works it out from how much text is on the page and your reading speed.'
      )
    ).toBeTruthy();
  });

  it('defaults to an automatic cutoff and asking, with no reset', () => {
    const { getByLabelText, queryByRole } = render(ReadingTimerSetting);
    expect(select(getByLabelText).value).toBe('auto');
    expect((getByLabelText(ASK) as HTMLInputElement).checked).toBe(true);
    expect(queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('offers Automatic and fixed minutes; choosing stores a synced cutoff, Automatic clears it', async () => {
    const { getByLabelText } = render(ReadingTimerSetting);
    const stop = select(getByLabelText);
    expect(Array.from(stop.options).map((o) => o.textContent?.trim())).toEqual([
      'Automatic',
      '2 minutes',
      '3 minutes',
      '5 minutes',
      '10 minutes',
      '15 minutes',
      '20 minutes',
      '30 minutes',
      '45 minutes',
      '60 minutes'
    ]);
    stop.value = '10';
    await fireEvent.change(stop);
    expect(get(trackingState).idle?.override_minutes).toBe(10);
    stop.value = 'auto';
    await fireEvent.change(stop);
    // Written as an explicit null, so it beats an older fixed cutoff from another device.
    expect(get(trackingState).idle?.override_minutes).toBeNull();
  });

  it('shows a stored fixed cutoff, even one that is not on the list', () => {
    setTrackingStates({ idle: { override_minutes: 7, lastUpdated: T1 } });
    const { getByLabelText } = render(ReadingTimerSetting);
    const stop = select(getByLabelText);
    expect(stop.value).toBe('7');
    expect(stop.selectedOptions[0].textContent?.trim()).toBe('7 minutes');
  });

  it('turning asking off and on is a synced setting', async () => {
    const { getByLabelText } = render(ReadingTimerSetting);
    await fireEvent.click(getByLabelText(ASK));
    expect(get(askOnLongPause)).toBe(false);
    expect(get(trackingState).pauses?.ask).toBe(false);
    await fireEvent.click(getByLabelText(ASK));
    expect(get(askOnLongPause)).toBe(true);
  });

  it('says how much "Still reading" stretched the automatic cutoff, and Reset puts it back', async () => {
    setTrackingStates({ idle: { k: 4.5, lastUpdated: T1 } });
    const { getByText, getByRole, queryByText } = render(ReadingTimerSetting);
    expect(
      getByText('Your “Still reading” answers made the automatic cutoff 1.5× longer.')
    ).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: 'Reset' }));
    expect(get(trackingState).idle?.k).toBe(3);
    expect(get(trackingState).idle!.lastUpdated > T1).toBe(true);
    await tick();
    expect(queryByText(/made the automatic cutoff/)).toBeNull();
  });

  it('has no reset under a fixed cutoff, which "Still reading" never stretches', () => {
    setTrackingStates({ idle: { k: 4.5, override_minutes: 7, lastUpdated: T1 } });
    const { queryByRole, queryByText } = render(ReadingTimerSetting);
    expect(queryByText(/made the automatic cutoff/)).toBeNull();
    expect(queryByRole('button', { name: 'Reset' })).toBeNull();
  });
});
