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
vi.mock('$lib/metadata/layer-sync', () => ({
  deleteCloudLayerFile: vi.fn(async () => 'gone'),
  clearPendingLayerDelete: vi.fn()
}));

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
    deleteCloudLayerFile: vi.fn(async () => 'gone'),
    clearPendingLayerDelete: vi.fn(),
    promoteLayer: vi.fn(async () => ({ replacedLayerId: null })),
    buildLayerExportFile: vi.fn(async () => new File(['{}'], 'Vol.x.mokuro')),
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
    // The cloud copy goes first — otherwise the next listing pulls it back.
    const dd = d as {
      deleteLayer: ReturnType<typeof vi.fn>;
      deleteCloudLayerFile: ReturnType<typeof vi.fn>;
    };
    expect(dd.deleteCloudLayerFile).toHaveBeenCalledWith('v', 'a');
    expect(dd.deleteLayer).toHaveBeenCalledWith('v', 'a');
    expect(dd.deleteCloudLayerFile.mock.invocationCallOrder[0]).toBeLessThan(
      dd.deleteLayer.mock.invocationCallOrder[0]
    );
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

  // An open edit session holds unsaved boxes: a promote/copy/delete that read or
  // wrote the layer rows first would act on the pre-edit pages, and the late
  // flush would then land on a row that was swapped or deleted under it.
  it('awaits onBeforeMutate before promote / create / delete touch a layer row', async () => {
    for (const [action, method] of [
      ['promote', 'promoteLayer'],
      ['new', 'createLayer'],
      ['delete', 'deleteLayer']
    ] as const) {
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const onBeforeMutate = vi.fn(async () => {
        order.push('flush:start');
        await gate;
        order.push('flush:done');
      });
      const base = deps() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      const d = deps({
        [method]: vi.fn(async (...args: unknown[]) => {
          order.push(method);
          return base[method](...args);
        }),
        deleteCloudLayerFile: vi.fn(async () => {
          order.push('deleteCloudLayerFile');
        })
      });
      const run = runLayerAction(action, {
        volumeUuid: 'v',
        layerId: 'a',
        displayedPages: [page],
        onSelectLayer: vi.fn(() => {
          order.push('select');
        }),
        onBeforeMutate,
        deps: d
      });
      if (action === 'new') get(layerNamePrompt)!.resolve({ name: 'Fix', source: 'copy' });
      // Let the action run as far as it can while the flush is still pending.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(order, action).toEqual(['flush:start']);
      release();
      await run;
      expect(onBeforeMutate, action).toHaveBeenCalledTimes(1);
      expect(order.slice(0, 2), action).toEqual(['flush:start', 'flush:done']);
      expect(order, action).toContain(method);
    }
  });

  it('a failing onBeforeMutate aborts the action and notifies', async () => {
    const d = deps();
    await runLayerAction('delete', {
      volumeUuid: 'v',
      layerId: 'a',
      displayedPages: [],
      onSelectLayer: vi.fn(),
      onBeforeMutate: async () => {
        throw new Error('flush failed');
      },
      deps: d
    });
    const m = d as Record<string, ReturnType<typeof vi.fn>>;
    expect(m.deleteCloudLayerFile).not.toHaveBeenCalled();
    expect(m.deleteLayer).not.toHaveBeenCalled();
    expect(m.notify).toHaveBeenCalledWith('flush failed');
  });

  // The cloud copy could not be removed (offline, read-only…): layer-sync has
  // left a tombstone, so the row still goes now — but the user is told the
  // cloud half is outstanding instead of a plain "deleted".
  it('delete with an unconfirmed cloud removal still deletes the row, and says so', async () => {
    const d = deps({ deleteCloudLayerFile: vi.fn(async () => 'unconfirmed') });
    await runLayerAction('delete', {
      volumeUuid: 'v',
      layerId: 'a',
      displayedPages: [],
      onSelectLayer: vi.fn(),
      deps: d
    });
    const m = d as Record<string, ReturnType<typeof vi.fn>>;
    expect(m.deleteLayer).toHaveBeenCalledWith('v', 'a');
    expect(m.notify).toHaveBeenCalledTimes(1);
    expect(m.notify.mock.calls[0][0]).toMatch(/cloud copy/i);
    expect(m.notify.mock.calls[0][0]).not.toBe('Layer deleted');

    const ok = deps();
    await runLayerAction('delete', {
      volumeUuid: 'v',
      layerId: 'a',
      displayedPages: [],
      onSelectLayer: vi.fn(),
      deps: ok
    });
    expect((ok as Record<string, ReturnType<typeof vi.fn>>).notify).toHaveBeenCalledWith(
      'Layer deleted'
    );
  });

  // Ids are slugs of the name, so "delete Fix, create Fix" reuses the id: a
  // tombstone left by the delete must not take the new layer's file with it.
  it('new: clears any pending cloud delete for the id the new layer took', async () => {
    const d = deps();
    const run = runLayerAction('new', {
      volumeUuid: 'v',
      layerId: null,
      displayedPages: [page],
      onSelectLayer: vi.fn(),
      deps: d
    });
    get(layerNamePrompt)!.resolve({ name: 'Fix', source: 'copy' });
    await run;
    expect(
      (d as Record<string, ReturnType<typeof vi.fn>>).clearPendingLayerDelete
    ).toHaveBeenCalledWith('v', 'copy-1');
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
