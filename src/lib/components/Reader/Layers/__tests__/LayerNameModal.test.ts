import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$lib/catalog/db', () => ({ db: {} }));
vi.mock('$lib/reader/edit/layers', () => ({
  buildLayerExportFile: vi.fn(),
  createLayer: vi.fn(),
  deleteLayer: vi.fn(),
  promoteLayer: vi.fn(),
  renameLayer: vi.fn()
}));
vi.mock('$lib/util/volume-sidecars', () => ({ downloadFileBlob: vi.fn() }));
vi.mock('$lib/util/modals', () => ({ promptConfirmation: vi.fn() }));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));

import LayerNameModal from '../LayerNameModal.svelte';
import { promptLayerName } from '../layer-actions';

afterEach(cleanup);

describe('LayerNameModal', () => {
  it('shows the prompt, disables OK on a blank name, and resolves name + source', async () => {
    const { getByLabelText, getByText } = render(LayerNameModal);
    const p = promptLayerName({ title: 'New layer', askSource: true });
    await tick();
    const ok = getByLabelText('Confirm layer name') as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    await fireEvent.input(getByLabelText('Layer name'), { target: { value: 'English' } });
    await fireEvent.click(getByText('Empty'));
    await fireEvent.click(ok);
    expect(await p).toEqual({ name: 'English', source: 'empty' });
  });

  it('Cancel resolves null', async () => {
    const { getByText } = render(LayerNameModal);
    const p = promptLayerName({ title: 'Rename', initialName: 'A' });
    await tick();
    await fireEvent.click(getByText('Cancel'));
    expect(await p).toBeNull();
  });
});
