import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import ScheduledFilterCard from '../ScheduledFilterCard.svelte';

const baseProps = {
  title: 'Black & white',
  enableLabel: 'Enable black & white',
  hotkeyHint: 'G',
  settingKey: 'grayscale',
  scheduleKey: 'grayscaleSchedule'
} as const;

describe('ScheduledFilterCard', () => {
  it('renders the title and the manual hotkey hint', () => {
    const { getByText } = render(ScheduledFilterCard, {
      props: { ...baseProps, active: false }
    });
    expect(getByText('Black & white')).toBeTruthy();
    expect(getByText('Manual (G)')).toBeTruthy();
  });

  it('shows the active indicator when active', () => {
    const { getByText } = render(ScheduledFilterCard, {
      props: { ...baseProps, active: true }
    });
    expect(getByText('(active)')).toBeTruthy();
  });
});
