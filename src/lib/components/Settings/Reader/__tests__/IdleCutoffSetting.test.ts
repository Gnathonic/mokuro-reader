import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import { fireEvent, render } from '@testing-library/svelte';
import { get } from 'svelte/store';
import IdleCutoffSetting from '../IdleCutoffSetting.svelte';
import { setTrackingStates, trackingState } from '$lib/settings/tracking-data';

beforeEach(() => setTrackingStates({}));

describe('IdleCutoffSetting', () => {
  it('is automatic by default, with no slider', () => {
    const { getByLabelText, queryByRole } = render(IdleCutoffSetting);
    expect((getByLabelText('Automatic idle cutoff') as HTMLInputElement).checked).toBe(true);
    expect(queryByRole('slider')).toBeNull();
  });

  it('switching to manual sets a synced override, and the slider changes it', async () => {
    const { getByLabelText, getByRole, getByText } = render(IdleCutoffSetting);
    await fireEvent.click(getByLabelText('Automatic idle cutoff'));
    expect(get(trackingState).idle?.override_minutes).toBe(5);
    const slider = getByRole('slider') as HTMLInputElement;
    await fireEvent.change(slider, { target: { value: '12' } });
    expect(get(trackingState).idle?.override_minutes).toBe(12);
    expect(getByText(/12 minutes/)).toBeTruthy();
  });

  it('switching back to automatic clears the override', async () => {
    setTrackingStates({ idle: { override_minutes: 9, lastUpdated: '2026-10-01T00:00:00.000Z' } });
    const { getByLabelText } = render(IdleCutoffSetting);
    await fireEvent.click(getByLabelText('Automatic idle cutoff'));
    expect(get(trackingState).idle?.override_minutes).toBeNull();
  });
});
