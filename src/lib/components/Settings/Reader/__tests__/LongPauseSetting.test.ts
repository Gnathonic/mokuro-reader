import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import LongPauseSetting from '../LongPauseSetting.svelte';
import { setTrackingStates, trackingState } from '$lib/settings/tracking-data';

const T1 = '2026-10-01T00:00:00.000Z';
const LABEL = 'When a page stays open past the cutoff';

beforeEach(() => setTrackingStates({}));

describe('LongPauseSetting', () => {
  it('asks by default, offering the three standing answers', () => {
    const { getByLabelText } = render(LongPauseSetting);
    const select = getByLabelText(LABEL) as HTMLSelectElement;
    expect(select.value).toBe('ask');
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'ask',
      'full',
      'typical',
      'none'
    ]);
  });

  it('choosing an answer stores a synced standing default; "Ask me" clears it', async () => {
    const { getByLabelText } = render(LongPauseSetting);
    const select = getByLabelText(LABEL) as HTMLSelectElement;
    select.value = 'typical';
    await fireEvent.change(select);
    expect(get(trackingState).pauses?.default).toBe('typical');
    select.value = 'ask';
    await fireEvent.change(select);
    expect(get(trackingState).pauses?.default).toBeNull();
  });

  it('shows the stored default', () => {
    setTrackingStates({ pauses: { default: 'none', lastUpdated: T1 } });
    const { getByLabelText } = render(LongPauseSetting);
    expect((getByLabelText(LABEL) as HTMLSelectElement).value).toBe('none');
  });

  it('has no reset while the cutoff is at its default width', () => {
    const { queryByText, queryByRole } = render(LongPauseSetting);
    expect(queryByText(/Cutoff widened/)).toBeNull();
    expect(queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('shows a widened cutoff, and Reset puts k back to 3 keeping the manual cutoff', async () => {
    setTrackingStates({ idle: { k: 4.5, override_minutes: 7, lastUpdated: T1 } });
    const { getByText, getByRole, queryByText } = render(LongPauseSetting);
    expect(getByText('Cutoff widened ×4.5')).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: 'Reset' }));
    expect(get(trackingState).idle).toMatchObject({ k: 3, override_minutes: 7 });
    expect(get(trackingState).idle!.lastUpdated > T1).toBe(true);
    await tick();
    expect(queryByText(/Cutoff widened/)).toBeNull();
  });
});
