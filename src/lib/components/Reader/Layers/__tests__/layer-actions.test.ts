import { describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { Page } from '$lib/types';

vi.mock('$lib/catalog/db', () => ({ db: {} }));
vi.mock('$lib/reader/edit/layers', () => ({
  buildLayerExportFile: vi.fn(),
  copyIntoEditLayer: vi.fn(),
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
  clearPendingLayerDelete: vi.fn(),
  publishCuratedLayer: vi.fn(),
  unpublishCuratedLayer: vi.fn(),
  listedCuratedLayerFile: vi.fn(async () => null)
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
    publishCuratedLayer: vi.fn(async () => 'published'),
    unpublishCuratedLayer: vi.fn(async () => 'gone'),
    listedCuratedLayerFile: vi.fn(async () => null),
    copyIntoEditLayer: vi.fn(async () => {}),
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

  it('promote refuses a translation layer before asking anything (kind, or a tr-<lang> id)', async () => {
    for (const target of [
      { layerId: 'english', layerKind: 'translation' as const },
      { layerId: 'tr-en' }
    ]) {
      const d = deps();
      const onSelectLayer = vi.fn();
      const onBeforeMutate = vi.fn(async () => {});
      await runLayerAction('promote', {
        volumeUuid: 'v',
        ...target,
        displayedPages: [],
        onSelectLayer,
        onBeforeMutate,
        deps: d
      });
      const m = d as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(m.confirm).not.toHaveBeenCalled();
      expect(onBeforeMutate).not.toHaveBeenCalled();
      expect(m.promoteLayer).not.toHaveBeenCalled();
      expect(onSelectLayer).not.toHaveBeenCalled();
      expect(m.notify).toHaveBeenCalledWith(expect.stringMatching(/translation/i));
    }
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
  // A layer whose cloud file is somebody else's (a shared edit layer on a
  // 0.7.x bunko, a case merge's curated-<n> keepsake) is never deleted from here:
  // promising a later cloud removal would be a lie.
  it('delete of a layer whose cloud copy is shared says the shared copy stays', async () => {
    const d = deps({ deleteCloudLayerFile: vi.fn(async () => 'kept-shared') });
    await runLayerAction('delete', {
      volumeUuid: 'v',
      layerId: 'curated-2',
      displayedPages: [],
      onSelectLayer: vi.fn(),
      deps: d
    });
    const m = d as Record<string, ReturnType<typeof vi.fn>>;
    expect(m.deleteLayer).toHaveBeenCalledWith('v', 'curated-2');
    expect(m.notify).toHaveBeenCalledWith(
      'Layer deleted on this device. The shared copy stays on the server.'
    );
  });

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

describe('Publish / Unpublish / Copy to your corrections', () => {
  type D = Record<string, ReturnType<typeof vi.fn>>;
  const ctx = (layerId: string, d: unknown, over: Record<string, unknown> = {}) => ({
    volumeUuid: 'v',
    layerId,
    layerName: layerId === 'curated' ? 'Shared corrections' : 'Your corrections',
    displayedPages: [page],
    onSelectLayer: vi.fn(),
    onBeforeMutate: vi.fn(async () => {}),
    deps: d as never,
    ...over
  });

  it('publish: confirms (naming the date of the shared file it replaces), settles, then uploads', async () => {
    const d = deps({
      listedCuratedLayerFile: vi.fn(async () => ({
        path: 'S/V.curated.mokuro',
        modifiedTime: '2026-10-01T12:00:00.000Z'
      }))
    }) as unknown as D;
    const c = ctx('edit', d);
    await runLayerAction('publish', c);
    const message = d.confirm.mock.calls[0][0] as string;
    expect(message).toMatch(/^Publish your corrections for everyone on this server\?/);
    expect(message).toContain('This replaces the shared corrections');
    expect(message).toContain(new Date('2026-10-01T12:00:00.000Z').toLocaleDateString());
    expect(c.onBeforeMutate).toHaveBeenCalled();
    expect(d.publishCuratedLayer).toHaveBeenCalledWith('v');
    expect(d.notify).toHaveBeenCalledWith('Your corrections are now the shared corrections');
  });

  it('publish: a declined confirm uploads nothing', async () => {
    const d = deps({ confirm: vi.fn(async () => false) }) as unknown as D;
    const c = ctx('edit', d);
    await runLayerAction('publish', c);
    expect(d.publishCuratedLayer).not.toHaveBeenCalled();
    expect(c.onBeforeMutate).not.toHaveBeenCalled();
  });

  it('publish: a refusal says the account may not, a failure says so too', async () => {
    const d = deps({ publishCuratedLayer: vi.fn(async () => 'refused') }) as unknown as D;
    await runLayerAction('publish', ctx('edit', d));
    expect(d.notify).toHaveBeenCalledWith(
      "This account can't publish shared corrections for this volume"
    );
    const f = deps({ publishCuratedLayer: vi.fn(async () => 'failed') }) as unknown as D;
    await runLayerAction('publish', ctx('edit', f));
    expect(f.notify.mock.calls[0][0]).toMatch(/^Couldn't publish/);
  });

  it('unpublish: confirms, removes for everyone, and shows the primary', async () => {
    const d = deps() as unknown as D;
    const c = ctx('curated', d);
    await runLayerAction('unpublish', c);
    expect(d.confirm).toHaveBeenCalledWith('Remove the shared corrections for everyone?');
    expect(d.unpublishCuratedLayer).toHaveBeenCalledWith('v');
    expect(c.onSelectLayer).toHaveBeenCalledWith(null);
    expect(d.notify).toHaveBeenCalledWith('Shared corrections removed');
  });

  it('unpublish: declined → nothing; refused → the layer stays shown; unconfirmed → says the copy waits', async () => {
    const no = deps({ confirm: vi.fn(async () => false) }) as unknown as D;
    await runLayerAction('unpublish', ctx('curated', no));
    expect(no.unpublishCuratedLayer).not.toHaveBeenCalled();

    const refused = deps({ unpublishCuratedLayer: vi.fn(async () => 'refused') }) as unknown as D;
    const c = ctx('curated', refused);
    await runLayerAction('unpublish', c);
    expect(c.onSelectLayer).not.toHaveBeenCalled();
    expect(refused.notify).toHaveBeenCalledWith(
      "This account can't publish shared corrections for this volume"
    );

    const later = deps({ unpublishCuratedLayer: vi.fn(async () => 'unconfirmed') }) as unknown as D;
    await runLayerAction('unpublish', ctx('curated', later));
    expect(later.notify.mock.calls[0][0]).toMatch(/when the cloud allows it/);

    const failed = deps({ unpublishCuratedLayer: vi.fn(async () => 'failed') }) as unknown as D;
    const f = ctx('curated', failed);
    await runLayerAction('unpublish', f);
    expect(f.onSelectLayer).not.toHaveBeenCalled();
    expect(failed.notify.mock.calls[0][0]).toMatch(/^Couldn't remove the shared corrections/);
  });

  it('copy-to-edit: confirms, settles, replaces the edit layer and shows it', async () => {
    const d = deps() as unknown as D;
    const c = ctx('curated', d);
    await runLayerAction('copy-to-edit', c);
    expect(d.confirm.mock.calls[0][0]).toMatch(/Shared corrections/);
    expect(c.onBeforeMutate).toHaveBeenCalled();
    expect(d.copyIntoEditLayer).toHaveBeenCalledWith('v', 'curated');
    expect(d.clearPendingLayerDelete).toHaveBeenCalledWith('v', 'edit');
    expect(c.onSelectLayer).toHaveBeenCalledWith('edit');

    const no = deps({ confirm: vi.fn(async () => false) }) as unknown as D;
    await runLayerAction('copy-to-edit', ctx('curated', no));
    expect(no.copyIntoEditLayer).not.toHaveBeenCalled();
  });
});
