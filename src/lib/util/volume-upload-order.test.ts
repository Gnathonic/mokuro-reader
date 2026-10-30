import { describe, expect, it, vi } from 'vitest';
import { uploadVolumeFiles } from './volume-upload-order';

const file = (filename: string) => ({ filename, blob: new Blob([filename]) });
const layer = (layerId: string) => ({
  ...file(`Vol 1.${layerId}.mokuro`),
  layerId,
  updatedAt: '2026-10-30T00:00:00.000Z'
});

describe('uploadVolumeFiles', () => {
  it('sends an account’s edit layer only once the archive it is anchored on is up', async () => {
    const order: string[] = [];
    const result = await uploadVolumeFiles(
      {
        mokuro: file('Vol 1.mokuro'),
        layers: [layer('edit'), layer('gcv')],
        thumbnail: file('Vol 1.webp')
      },
      {
        sidecar: async (f) => {
          order.push(f.filename);
          return { modifiedTime: 'm' };
        },
        archive: async () => {
          order.push('Vol 1.cbz');
          return 'archive-result';
        }
      }
    );
    // bunko refuses `<Vol>.edit.mokuro` (409 no-volume) while no `<Vol>.cbz`
    // is listed beside it.
    expect(order).toEqual([
      'Vol 1.mokuro',
      'Vol 1.gcv.mokuro',
      'Vol 1.webp',
      'Vol 1.cbz',
      'Vol 1.edit.mokuro'
    ]);
    expect(result.archive).toBe('archive-result');
    expect(result.layers.map((l) => l.layerId)).toEqual(['gcv', 'edit']);
  });

  it('a refused edit layer leaves the backup standing and the layer unstamped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await uploadVolumeFiles(
      { layers: [layer('edit'), layer('gcv')] },
      {
        sidecar: async (f) => {
          if (f.filename.includes('.edit.')) throw new Error('409 no-volume');
          return {};
        },
        archive: async () => 'ok'
      }
    );
    expect(result.archive).toBe('ok');
    // Not stamped synced: the next listing's layer sync pushes it.
    expect(result.layers.map((l) => l.layerId)).toEqual(['gcv']);
    warn.mockRestore();
  });

  it('any sidecar before the archive still fails the backup, and the archive is not sent', async () => {
    const archive = vi.fn(async () => 'ok');
    await expect(
      uploadVolumeFiles(
        { mokuro: file('Vol 1.mokuro') },
        {
          sidecar: async () => {
            throw new Error('503');
          },
          archive
        }
      )
    ).rejects.toThrow('503');
    expect(archive).not.toHaveBeenCalled();
  });

  it('hands the primary sidecar’s upload result to onPrimary', async () => {
    const onPrimary = vi.fn();
    const mokuro = file('Vol 1.mokuro');
    await uploadVolumeFiles(
      { mokuro },
      { sidecar: async () => ({ modifiedTime: 'm1' }), archive: async () => 'ok' },
      { onPrimary }
    );
    expect(onPrimary).toHaveBeenCalledWith(mokuro, { modifiedTime: 'm1' });
  });

  it('no sidecars: only the archive', async () => {
    const sidecar = vi.fn();
    const result = await uploadVolumeFiles(undefined, { sidecar, archive: async () => 1 });
    expect(sidecar).not.toHaveBeenCalled();
    expect(result).toEqual({ archive: 1, layers: [] });
  });
});
