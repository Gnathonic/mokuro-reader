import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import QuickAccess from '../QuickAccess.svelte';
import { isReader } from '$lib/util';
import * as hashRouter from '$lib/util/hash-router';

vi.mock('$lib/util', () => ({
  isReader: vi.fn()
}));

vi.mock('$lib/util/hash-router', () => ({
  navigateBack: vi.fn()
}));

describe('QuickAccess', () => {
  it('should call navigateBack when closing reader', async () => {
    // Mock isReader to return true
    vi.mocked(isReader).mockReturnValue(true);

    const { getByText } = render(QuickAccess);
    const closeButton = getByText('Close reader');

    await fireEvent.click(closeButton);

    // Should call navigateBack
    expect(hashRouter.navigateBack).toHaveBeenCalled();
  });
});
