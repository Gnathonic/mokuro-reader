import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import QuickAccess from '../QuickAccess.svelte';
import { isReader } from '#lib/util/index.js';
import * as hashRouter from '#lib/util/hash-router.js';

vi.mock('#lib/util/index.js', () => ({
  isReader: vi.fn()
}));

vi.mock('#lib/util/hash-router.js', () => ({
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
