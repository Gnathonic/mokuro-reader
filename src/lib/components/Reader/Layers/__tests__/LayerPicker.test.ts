import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';

vi.mock('$lib/catalog/db', () => ({ db: {} }));

import LayerPicker from '../LayerPicker.svelte';

afterEach(cleanup);
const layers = [
  { layer_id: 'original', name: 'Original', kind: 'original' as const, updated_at: 'x' },
  { layer_id: 'english', name: 'English', kind: 'translation' as const, updated_at: 'x' }
];

describe('LayerPicker', () => {
  it('lists Primary and every layer with its kind, marks the current one, and selects', async () => {
    const onSelect = vi.fn();
    const { getByRole, getAllByRole, getByText } = render(LayerPicker, {
      props: { layers, current: 'english', onSelect, onAction: vi.fn(), onClose: vi.fn() }
    });
    const radios = getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
    expect(getByText('Translation')).toBeTruthy();
    await fireEvent.click(getByRole('radio', { name: /Primary/ }));
    expect(onSelect).toHaveBeenCalledWith(null);
    await fireEvent.click(getByRole('radio', { name: /Original/ }));
    expect(onSelect).toHaveBeenCalledWith('original');
  });

  it('offers rename/promote/export/delete on a layer, only export on original, and New layer', async () => {
    const onAction = vi.fn();
    const { getByLabelText, queryByLabelText } = render(LayerPicker, {
      props: { layers, current: null, onSelect: vi.fn(), onAction, onClose: vi.fn() }
    });
    await fireEvent.click(getByLabelText('Promote layer English'));
    expect(onAction).toHaveBeenCalledWith('promote', 'english');
    expect(queryByLabelText('Rename layer Original')).toBeNull();
    expect(queryByLabelText('Delete layer Original')).toBeNull();
    expect(getByLabelText('Export layer Original')).toBeTruthy();
    await fireEvent.click(getByLabelText('New layer'));
    expect(onAction).toHaveBeenCalledWith('new', null);
  });
});
