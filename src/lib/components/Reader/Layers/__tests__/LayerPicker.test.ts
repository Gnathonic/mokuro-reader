import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';

vi.mock('$lib/catalog/db', () => ({ db: {} }));

import LayerPicker from '../LayerPicker.svelte';

afterEach(cleanup);
const layers = [
  { layer_id: 'original', name: 'Original', kind: 'original' as const, updated_at: 'x' },
  { layer_id: 'english', name: 'English', kind: 'translation' as const, updated_at: 'x' },
  { layer_id: 'fix', name: 'Fix', kind: 'edit' as const, updated_at: 'x' }
];

describe('LayerPicker', () => {
  it('lists Primary and every layer with its kind, marks the current one, and selects', async () => {
    const onSelect = vi.fn();
    const { getByRole, getAllByRole, getByText } = render(LayerPicker, {
      props: {
        layers,
        current: 'english',
        primaryName: 'mokuro 0.2.2',
        onSelect,
        onAction: vi.fn(),
        onClose: vi.fn()
      }
    });
    const radios = getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
      'false'
    ]);
    expect(getByText('Translation')).toBeTruthy();
    // The primary row is named after the mokuro version; "Primary" stays its badge.
    expect(getByText('mokuro 0.2.2')).toBeTruthy();
    await fireEvent.click(getByRole('radio', { name: /mokuro 0\.2\.2/ }));
    expect(onSelect).toHaveBeenCalledWith(null);
    await fireEvent.click(getByRole('radio', { name: /Original/ }));
    expect(onSelect).toHaveBeenCalledWith('original');
  });

  it('offers rename/promote/export/delete on a layer, only export on original, and New layer', async () => {
    const onAction = vi.fn();
    const { getByLabelText, queryByLabelText } = render(LayerPicker, {
      props: { layers, current: null, onSelect: vi.fn(), onAction, onClose: vi.fn() }
    });
    await fireEvent.click(getByLabelText('Promote layer Fix'));
    expect(onAction).toHaveBeenCalledWith('promote', 'fix');
    expect(queryByLabelText('Rename layer Original')).toBeNull();
    expect(queryByLabelText('Delete layer Original')).toBeNull();
    expect(getByLabelText('Export layer Original')).toBeTruthy();
    await fireEvent.click(getByLabelText('New layer'));
    expect(onAction).toHaveBeenCalledWith('new', null);
  });
});

describe('LayerPicker — a translation cannot become the primary', () => {
  it('disables Promote on a translation layer (by kind or tr-<lang> id) and says why', async () => {
    const onAction = vi.fn();
    const { getByLabelText } = render(LayerPicker, {
      props: {
        layers: [
          ...layers,
          // Kind says "edit", the id says translation — as a cloud pull would file it.
          { layer_id: 'tr-en', name: 'Pulled', kind: 'edit' as const, updated_at: 'x' }
        ],
        current: null,
        onSelect: vi.fn(),
        onAction,
        onClose: vi.fn()
      }
    });
    for (const name of ['English', 'Pulled']) {
      const button = getByLabelText(`Promote layer ${name}`) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toMatch(/translation/i);
      await fireEvent.click(button);
    }
    expect(onAction).not.toHaveBeenCalled();
    const ok = getByLabelText('Promote layer Fix') as HTMLButtonElement;
    expect(ok.disabled).toBe(false);
    expect(ok.title).toBe('Promote to primary');
  });
});

describe('LayerPicker — keyboard escape hatch', () => {
  it('carries data-popover on its root so reader shortcuts ignore it', () => {
    const { getByRole } = render(LayerPicker, {
      props: { layers, current: null, onSelect: vi.fn(), onAction: vi.fn(), onClose: vi.fn() }
    });
    expect(getByRole('dialog').hasAttribute('data-popover')).toBe(true);
  });

  it('closes on Escape even when focus never entered the picker', async () => {
    const onClose = vi.fn();
    render(LayerPicker, {
      props: { layers, current: null, onSelect: vi.fn(), onAction: vi.fn(), onClose }
    });
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
