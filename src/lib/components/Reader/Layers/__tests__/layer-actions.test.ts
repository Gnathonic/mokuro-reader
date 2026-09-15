import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { Page } from '$lib/types';

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

import { layerNamePrompt, promptLayerName, runLayerAction } from '../layer-actions';

const page: Page = { version: '0.2.1', img_width: 1, img_height: 1, img_path: 'p', blocks: [] };

function deps(over: Record<string, unknown> = {}) {
  return {
    createLayer: vi.fn(async (_v: string, o: { name: string }) => ({
      layer_id: 'copy-1',
      name: o.name
    })),
    renameLayer: vi.fn(async () => {}),
    deleteLayer: vi.fn(async () => {}),
    promoteLayer: vi.fn(async () => ({ replacedLayerId: null })),
    buildLayerExportFile: vi.fn(async () => new File(['{}'], 'Vol.layer.x.mokuro')),
    download: vi.fn(),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
    ...over
  } as never;
}

describe('promptLayerName', () => {
  it('publishes a prompt and resolves with the modal answer; a second prompt cancels the first', async () => {
    const p1 = promptLayerName({ title: 'New layer', askSource: true });
    expect(get(layerNamePrompt)?.title).toBe('New layer');
    const p2 = promptLayerName({ title: 'Rename' });
    expect(await p1).toBeNull();
    get(layerNamePrompt)!.resolve({ name: 'X', source: 'copy' });
    expect(await p2).toEqual({ name: 'X', source: 'copy' });
    expect(get(layerNamePrompt)).toBeNull();
  });
});

describe('runLayerAction', () => {
  it('new: copy of the displayed pages, then selects the new layer', async () => {
    const d = deps();
    const onSelectLayer = vi.fn();
    const run = runLayerAction('new', {
      volumeUuid: 'v',
      layerId: null,
      displayedPages: [page],
      onSelectLayer,
      deps: d
    });
    get(layerNamePrompt)!.resolve({ name: 'Fix', source: 'copy' });
    await run;
    expect((d as { createLayer: unknown }).createLayer).toHaveBeenCalledWith('v', {
      name: 'Fix',
      pages: [page],
      sourcePages: [page]
    });
    expect(onSelectLayer).toHaveBeenCalledWith('copy-1');
  });

  it('new: empty keeps only image facts', async () => {
    const d = deps();
    const run = runLayerAction('new', {
      volumeUuid: 'v',
      layerId: null,
      displayedPages: [page],
      onSelectLayer: vi.fn(),
      deps: d
    });
    get(layerNamePrompt)!.resolve({ name: 'T', source: 'empty' });
    await run;
    expect((d as { createLayer: unknown }).createLayer).toHaveBeenCalledWith('v', {
      name: 'T',
      pages: 'empty',
      sourcePages: [page]
    });
  });

  it('promote asks first, then selects primary; a declined confirm does nothing', async () => {
    const d = deps();
    const onSelectLayer = vi.fn();
    await runLayerAction('promote', {
      volumeUuid: 'v',
      layerId: 'a',
      displayedPages: [],
      onSelectLayer,
      deps: d
    });
    expect((d as { promoteLayer: unknown }).promoteLayer).toHaveBeenCalledWith('v', 'a');
    expect(onSelectLayer).toHaveBeenCalledWith(null);
    const d2 = deps({ confirm: vi.fn(async () => false) });
    await runLayerAction('promote', {
      volumeUuid: 'v',
      layerId: 'a',
      displayedPages: [],
      onSelectLayer: vi.fn(),
      deps: d2
    });
    expect((d2 as { promoteLayer: unknown }).promoteLayer).not.toHaveBeenCalled();
  });

  it('delete of the displayed layer switches to primary first; export downloads; errors notify', async () => {
    const d = deps();
    const onSelectLayer = vi.fn();
    await runLayerAction('delete', {
      volumeUuid: 'v',
      layerId: 'a',
      displayedPages: [],
      onSelectLayer,
      deps: d
    });
    expect(onSelectLayer).toHaveBeenCalledWith(null);
    expect((d as { deleteLayer: unknown }).deleteLayer).toHaveBeenCalledWith('v', 'a');
    await runLayerAction('export', {
      volumeUuid: 'v',
      layerId: 'a',
      displayedPages: [],
      onSelectLayer,
      deps: d
    });
    expect((d as { download: unknown }).download).toHaveBeenCalled();
    const d3 = deps({
      renameLayer: vi.fn(async () => {
        throw new Error('boom');
      })
    });
    const run = runLayerAction('rename', {
      volumeUuid: 'v',
      layerId: 'a',
      displayedPages: [],
      onSelectLayer,
      deps: d3
    });
    get(layerNamePrompt)!.resolve({ name: 'N', source: 'copy' });
    await run;
    expect((d3 as { notify: unknown }).notify).toHaveBeenCalledWith('boom');
  });

  it('rename/promote/export/delete without a layer id are no-ops', async () => {
    const d = deps();
    for (const a of ['rename', 'promote', 'export', 'delete'] as const) {
      await runLayerAction(a, {
        volumeUuid: 'v',
        layerId: null,
        displayedPages: [],
        onSelectLayer: vi.fn(),
        deps: d
      });
    }
    const m = d as Record<string, ReturnType<typeof vi.fn>>;
    expect(m.renameLayer).not.toHaveBeenCalled();
    expect(m.promoteLayer).not.toHaveBeenCalled();
    expect(m.download).not.toHaveBeenCalled();
    expect(m.deleteLayer).not.toHaveBeenCalled();
  });
});
