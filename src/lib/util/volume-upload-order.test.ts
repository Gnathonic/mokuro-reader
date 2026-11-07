import { describe, expect, it, vi } from 'vitest';
import { isLayerFileRefusal, uploadVolumeFiles } from './volume-upload-order';
import { WebdavUploadError } from './sync/providers/webdav/webdav-upload';
import { DriveHttpError } from './sync/core/providers/drive-http';

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

  describe('a layer the server refuses (403/409) never fails the backup', () => {
    const httpError = (status: number) =>
      Object.assign(new Error(`WebDAV upload failed: ${status}`), { status });
    const permissionDenied = () =>
      Object.assign(new Error('The server refused the layer file'), {
        name: 'ProviderError',
        code: 'PERMISSION_DENIED',
        isAuthError: false
      });

    for (const [label, refusal] of [
      ['403', () => httpError(403)],
      ['409', () => httpError(409)],
      ['PERMISSION_DENIED', permissionDenied]
    ] as const) {
      it(`a layer sent before the archive, refused ${label}: archive sent, layer unstamped`, async () => {
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
        const order: string[] = [];
        const result = await uploadVolumeFiles(
          {
            mokuro: file('Vol 1.mokuro'),
            layers: [layer('curated-2'), layer('gcv')],
            thumbnail: file('Vol 1.webp')
          },
          {
            sidecar: async (f) => {
              if (f.filename.includes('.curated-2.')) throw refusal();
              order.push(f.filename);
              return {};
            },
            archive: async () => {
              order.push('Vol 1.cbz');
              return 'ok';
            }
          }
        );
        expect(result.archive).toBe('ok');
        expect(order).toEqual(['Vol 1.mokuro', 'Vol 1.gcv.mokuro', 'Vol 1.webp', 'Vol 1.cbz']);
        expect(result.layers.map((l) => l.layerId)).toEqual(['gcv']);
        expect(debug).toHaveBeenCalled();
        debug.mockRestore();
      });
    }

    for (const [label, failure] of [
      ['401', () => Object.assign(new Error('401'), { status: 401 })],
      ['503', () => Object.assign(new Error('503'), { status: 503 })],
      ['a network error', () => new Error('network')],
      [
        'an auth ProviderError',
        () =>
          Object.assign(new Error('auth'), {
            name: 'ProviderError',
            code: 'PERMISSION_DENIED',
            isAuthError: true
          })
      ]
    ] as const) {
      it(`a layer before the archive failing with ${label} still fails the backup`, async () => {
        const archive = vi.fn(async () => 'ok');
        await expect(
          uploadVolumeFiles(
            { layers: [layer('gcv')] },
            {
              sidecar: async () => {
                throw failure();
              },
              archive
            }
          )
        ).rejects.toThrow();
        expect(archive).not.toHaveBeenCalled();
      });
    }

    it('the primary sidecar refused 403 still fails the backup (only layers are optional)', async () => {
      const archive = vi.fn(async () => 'ok');
      await expect(
        uploadVolumeFiles(
          { mokuro: file('Vol 1.mokuro') },
          {
            sidecar: async () => {
              throw httpError(403);
            },
            archive
          }
        )
      ).rejects.toThrow();
      expect(archive).not.toHaveBeenCalled();
    });

    it('an edit layer refused 403 after the archive is logged at debug only', async () => {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await uploadVolumeFiles(
        { layers: [layer('edit')] },
        {
          sidecar: async () => {
            throw httpError(403);
          },
          archive: async () => 'ok'
        }
      );
      expect(result.layers).toEqual([]);
      expect(debug).toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      debug.mockRestore();
      warn.mockRestore();
    });
  });

  it('a primary whose title bunko would read as an edit/curated layer goes up after the archive', async () => {
    for (const title of ['Notes.edit', 'Notes.edit-2', 'X.curated']) {
      const order: string[] = [];
      const onPrimary = vi.fn();
      await uploadVolumeFiles(
        { mokuro: file(`${title}.mokuro`), thumbnail: file(`${title}.webp`) },
        {
          sidecar: async (f) => {
            order.push(f.filename);
            return {};
          },
          archive: async () => {
            order.push(`${title}.cbz`);
            return 'ok';
          }
        },
        { onPrimary }
      );
      // `<Title>.mokuro` reads as `<stem>.<id>.mokuro` to bunko, refused
      // 409 no-volume while no `<Title>.cbz` is listed.
      expect(order).toEqual([`${title}.webp`, `${title}.cbz`, `${title}.mokuro`]);
      expect(onPrimary).toHaveBeenCalledOnce();
    }
  });

  it('a dotted title that names no anchored layer keeps the primary first', async () => {
    const order: string[] = [];
    await uploadVolumeFiles(
      { mokuro: file('Vol. 1.mokuro') },
      {
        sidecar: async (f) => {
          order.push(f.filename);
          return {};
        },
        archive: async () => {
          order.push('Vol. 1.cbz');
          return 'ok';
        }
      }
    );
    expect(order).toEqual(['Vol. 1.mokuro', 'Vol. 1.cbz']);
  });

  it('no sidecars: only the archive', async () => {
    const sidecar = vi.fn();
    const result = await uploadVolumeFiles(undefined, { sidecar, archive: async () => 1 });
    expect(sidecar).not.toHaveBeenCalled();
    expect(result).toEqual({ archive: 1, layers: [] });
  });
});

describe('isLayerFileRefusal decides on the status the error carries, never on its message', () => {
  it('a plain "Upload failed: 403 Forbidden" (the Drive worker core, rate-limited or over quota) is not one', () => {
    expect(isLayerFileRefusal(new Error('Upload failed: 403 Forbidden'))).toBe(false);
    expect(isLayerFileRefusal(new Error('Upload failed: 409 Conflict'))).toBe(false);
    expect(isLayerFileRefusal(new Error('WebDAV upload failed: 403'))).toBe(false);
  });

  it('a typed 403 or 409 from the WebDAV upload core is one', () => {
    const reserved = new WebdavUploadError('WebDAV upload failed: 403 Forbidden', {
      status: 403,
      reason: 'reserved-layer',
      detail: 'the layer id is reserved',
      retryable: false
    });
    const noVolume = new WebdavUploadError('WebDAV upload failed: 409 Conflict', {
      status: 409,
      reason: 'no-volume',
      detail: 'no archive to anchor on',
      retryable: false
    });
    expect(isLayerFileRefusal(reserved)).toBe(true);
    expect(isLayerFileRefusal(noVolume)).toBe(true);
  });

  it('a Drive 403 that is a rate limit or a full account is not one, whatever its status', () => {
    const rateLimited = new DriveHttpError(403, 'userRateLimitExceeded', {
      context: 'Upload failed'
    });
    const full = new DriveHttpError(403, 'storageQuotaExceeded', { context: 'Upload failed' });
    expect(rateLimited.status).toBe(403);
    expect(isLayerFileRefusal(rateLimited)).toBe(false);
    expect(isLayerFileRefusal(full)).toBe(false);
  });

  it('a layer failing before the archive with such a plain error fails the backup; the layer is not dropped', async () => {
    const archive = vi.fn(async () => 'ok');
    await expect(
      uploadVolumeFiles(
        { mokuro: file('Vol 1.mokuro'), layers: [layer('gcv')] },
        {
          sidecar: async (f) => {
            if (f.filename.includes('.gcv.')) throw new Error('Upload failed: 403 Forbidden');
            return {};
          },
          archive
        }
      )
    ).rejects.toThrow('Upload failed: 403 Forbidden');
    expect(archive).not.toHaveBeenCalled();
  });
});
