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

const upsertFromEmbedded = vi.fn();
vi.mock('$lib/metadata/store', () => ({
  upsertFromEmbedded: (...args: unknown[]) => upsertFromEmbedded(...args)
}));

const downloadFile = vi.fn();
const getActiveProvider = vi.fn();
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { getActiveProvider: () => getActiveProvider() }
}));

import { db } from '$lib/catalog/db';
import { enqueueCloudOcrUpgrade } from './cloud-ocr-upgrade';
import type { VolumeMetadata } from '$lib/types';

const embedded = {
  external_ids: { anilist: 30013 },
  titles: { romaji: 'ONE PIECE' },
  synonyms: [],
  tag: '[color]',
  updated_at: '2026-08-16T00:00:00.000Z'
};

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
      pages: [{ blocks: [{ lines: ['あ'] }] }],
      seriesMetadata: embedded
    });
  });

  it('applies the sidecar series_metadata after upgrading an image-only volume', async () => {
    enqueueCloudOcrUpgrade(imageOnlyVolume, sidecar);

    await vi.waitFor(async () => {
      const upgraded = await (db as any).table('volumes').get('vol-1');
      expect(upgraded.mokuro_version).toBe('0.2.0');
    });
    expect(upsertFromEmbedded).toHaveBeenCalledWith('One Piece', embedded);
  });

  it('keeps the OCR upgrade when applying the embedded metadata throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    upsertFromEmbedded.mockRejectedValueOnce(new Error('db is closed'));

    enqueueCloudOcrUpgrade(
      { ...imageOnlyVolume, volume_uuid: 'vol-1' },
      { ...sidecar, fileId: 'file-2' }
    );

    await vi.waitFor(async () => {
      const upgraded = await (db as any).table('volumes').get('vol-1');
      expect(upgraded.mokuro_version).toBe('0.2.0');
    });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('does nothing when the sidecar has no series_metadata', async () => {
    parseMokuroFile.mockResolvedValue({
      version: '0.2.0',
      seriesUuid: 'series-1',
      pages: []
    });

    enqueueCloudOcrUpgrade(imageOnlyVolume, { ...sidecar, fileId: 'file-3' });

    await vi.waitFor(async () => {
      const upgraded = await (db as any).table('volumes').get('vol-1');
      expect(upgraded.mokuro_version).toBe('0.2.0');
    });
    expect(upsertFromEmbedded).not.toHaveBeenCalled();
  });
});
