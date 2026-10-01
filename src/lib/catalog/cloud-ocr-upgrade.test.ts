import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db = new Dexie('cloud-ocr-upgrade-test');
  db.version(1).stores({ volumes: 'volume_uuid', volume_ocr: 'volume_uuid' });
  return { db };
});

const parseMokuroFile = vi.fn();
vi.mock('$lib/import/processing', () => ({
  parseMokuroFile: (...args: unknown[]) => parseMokuroFile(...args)
}));

const downloadFile = vi.fn();
const getActiveProvider = vi.fn();
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { getActiveProvider: () => getActiveProvider() }
}));

import { db } from '$lib/catalog/db';
import { enqueueCloudOcrUpgrade, upgradeOcrFromSidecarBlob } from './cloud-ocr-upgrade';
import type { VolumeMetadata } from '$lib/types';

const imageOnlyVolume = {
  volume_uuid: 'vol-1',
  series_uuid: 'series-1',
  series_title: 'One Piece',
  volume_title: 'Volume 1',
  mokuro_version: '',
  page_count: 2,
  character_count: 0,
  page_char_counts: [0, 0]
} as VolumeMetadata;

const sidecar = {
  provider: 'google-drive',
  path: 'manga/One Piece/Volume 1.mokuro',
  fileId: 'file-1'
} as any;

describe('cloud OCR upgrade', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await (db as any).table('volumes').clear();
    await (db as any).table('volume_ocr').clear();
    await (db as any).table('volumes').put(imageOnlyVolume);

    downloadFile.mockResolvedValue(new Blob(['{}'], { type: 'application/json' }));
    getActiveProvider.mockReturnValue({ type: 'google-drive', downloadFile });
    parseMokuroFile.mockResolvedValue({
      version: '0.2.0',
      seriesUuid: 'series-1',
      pages: [{ blocks: [{ lines: ['あ'] }] }]
    });
  });

  it('upgrades an image-only volume with the cloud sidecar OCR', async () => {
    enqueueCloudOcrUpgrade(imageOnlyVolume, sidecar);

    await vi.waitFor(async () => {
      const upgraded = await (db as any).table('volumes').get('vol-1');
      expect(upgraded.mokuro_version).toBe('0.2.0');
      expect(upgraded.page_count).toBe(1);
      expect(upgraded.character_count).toBe(1);
    });
    const ocr = await (db as any).table('volume_ocr').get('vol-1');
    expect(ocr.pages).toHaveLength(1);
  });

  it('the queue vouches for the listed sidecar it downloaded (provider, size, server mtime)', async () => {
    enqueueCloudOcrUpgrade(imageOnlyVolume, {
      ...sidecar,
      fileId: 'file-stamped',
      size: 2,
      modifiedTime: '2026-09-30T10:00:00.000Z'
    });
    await vi.waitFor(async () => {
      const row = await (db as any).table('volumes').get('vol-1');
      expect(row.mokuro_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.mokuro_sha256_cloud).toEqual({
        provider: 'google-drive',
        size: 2,
        modified: Date.parse('2026-09-30T10:00:00.000Z') / 1000
      });
    });
  });

  // An image-only volume has a real (empty) `volume_ocr` row, so the OCR editor
  // and layer promotion both work on it — and neither moves `mokuro_version`
  // off ''. `ocr_edited_at` is the only thing that says "a person wrote this".
  describe('a hand-edited image-only volume', () => {
    const handTyped = [{ blocks: [{ lines: ['手で打った'] }] }, { blocks: [] }];
    const edited = { ...imageOnlyVolume, ocr_edited_at: '2026-09-01T00:00:00.000Z' };

    async function settle(): Promise<void> {
      // The queue is fire-and-forget; give it real turns to do its worst.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    it('is never enqueued, so nothing is even downloaded', async () => {
      await (db as any).table('volumes').put(edited);
      await (db as any).table('volume_ocr').put({ volume_uuid: 'vol-1', pages: handTyped });

      enqueueCloudOcrUpgrade(edited, sidecar);
      await settle();

      expect(downloadFile).not.toHaveBeenCalled();
      expect((await (db as any).table('volume_ocr').get('vol-1')).pages).toEqual(handTyped);
      expect((await (db as any).table('volumes').get('vol-1')).mokuro_version).toBe('');
    });

    it('is left alone when the caller passed a snapshot from before the edit', async () => {
      await (db as any).table('volumes').put(edited);
      await (db as any).table('volume_ocr').put({ volume_uuid: 'vol-1', pages: handTyped });

      // A different sidecar id: the task id must not collide with another test's.
      enqueueCloudOcrUpgrade(imageOnlyVolume, { ...sidecar, fileId: 'file-stale' });
      await settle();

      expect((await (db as any).table('volume_ocr').get('vol-1')).pages).toEqual(handTyped);
      const row = await (db as any).table('volumes').get('vol-1');
      expect(row.mokuro_version).toBe('');
      expect(row.ocr_edited_at).toBe(edited.ocr_edited_at);
    });

    it('is left alone when the edit lands while the sidecar is in flight', async () => {
      await (db as any).table('volume_ocr').put({ volume_uuid: 'vol-1', pages: [] });
      parseMokuroFile.mockImplementation(async () => {
        await (db as any).table('volumes').put(edited);
        await (db as any).table('volume_ocr').put({ volume_uuid: 'vol-1', pages: handTyped });
        return { version: '0.2.0', seriesUuid: 'series-1', pages: [{ blocks: [] }] };
      });

      enqueueCloudOcrUpgrade(imageOnlyVolume, { ...sidecar, fileId: 'file-race' });
      await vi.waitFor(() => expect(parseMokuroFile).toHaveBeenCalled());
      await settle();

      expect((await (db as any).table('volume_ocr').get('vol-1')).pages).toEqual(handTyped);
      expect((await (db as any).table('volumes').get('vol-1')).mokuro_version).toBe('');
    });
  });
});

describe('upgradeOcrFromSidecarBlob (a sidecar fetched outside any provider)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await (db as any).table('volumes').clear();
    await (db as any).table('volume_ocr').clear();
    await (db as any).table('volumes').put(imageOnlyVolume);
    parseMokuroFile.mockResolvedValue({
      version: '0.2.0',
      seriesUuid: 'series-1',
      pages: [{ blocks: [{ lines: ['あ'] }] }]
    });
  });

  it('upgrades an image-only volume through the same write, with no provider at all', async () => {
    getActiveProvider.mockReturnValue(null);
    const ok = await upgradeOcrFromSidecarBlob(
      'vol-1',
      'https://bunko.example/One%20Piece/Volume%201.mokuro',
      new Blob(['{}'])
    );
    expect(ok).toBe(true);
    const row = await (db as any).table('volumes').get('vol-1');
    expect(row.mokuro_version).toBe('0.2.0');
    expect(row.character_count).toBe(1);
    expect((await (db as any).table('volume_ocr').get('vol-1')).pages).toHaveLength(1);
  });

  it('records the hash of the decoded sidecar bytes, attested only when given a listed file', async () => {
    const body = '{"version":"0.2.0"}';
    const { sha256Hex } = await import('./mokuro-hash');
    const expected = await sha256Hex(new Blob([body]));

    await upgradeOcrFromSidecarBlob('vol-1', 'https://server/Volume 1.mokuro', new Blob([body]));
    let row = await (db as any).table('volumes').get('vol-1');
    expect(row.mokuro_sha256).toBe(expected);
    expect(row.mokuro_sha256_cloud).toBeUndefined();

    await (db as any).table('volumes').put(imageOnlyVolume);
    // gzipped in the cloud: the hash is of the JSON AFTER gunzip.
    const gz = await new Response(
      new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))
    ).blob();
    await upgradeOcrFromSidecarBlob('vol-1', 'S/Volume 1.mokuro.gz', gz, {
      provider: 'webdav',
      size: gz.size
    });
    row = await (db as any).table('volumes').get('vol-1');
    expect(row.mokuro_sha256).toBe(expected);
    expect(row.mokuro_sha256_cloud).toEqual({ provider: 'webdav', size: gz.size });
  });

  it('decompresses a .mokuro.gz by its name', async () => {
    const gz = await new Response(
      new Blob(['{"pages":[]}']).stream().pipeThrough(new CompressionStream('gzip'))
    ).blob();
    await upgradeOcrFromSidecarBlob('vol-1', 'x/Volume 1.mokuro.gz', gz);
    const file = parseMokuroFile.mock.calls[0][0] as File;
    expect(file.name).toBe('Volume 1.mokuro');
    expect(await file.text()).toBe('{"pages":[]}');
  });

  it('refuses a hand-edited volume, and one that already has OCR', async () => {
    await (db as any)
      .table('volumes')
      .put({ ...imageOnlyVolume, ocr_edited_at: '2026-09-01T00:00:00.000Z' });
    expect(await upgradeOcrFromSidecarBlob('vol-1', 'Volume 1.mokuro', new Blob(['{}']))).toBe(
      false
    );
    await (db as any).table('volumes').put({ ...imageOnlyVolume, mokuro_version: '0.2.1' });
    expect(await upgradeOcrFromSidecarBlob('vol-1', 'Volume 1.mokuro', new Blob(['{}']))).toBe(
      false
    );
    expect(await upgradeOcrFromSidecarBlob('gone', 'Volume 1.mokuro', new Blob(['{}']))).toBe(
      false
    );
  });
});
