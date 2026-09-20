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
import { enqueueCloudOcrUpgrade } from './cloud-ocr-upgrade';
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

  it("stamps an engine sidecar's file-level char_offsets_method onto the pages that placed", async () => {
    // Engine sidecars name the method only at the top level, and this path
    // stores the parsed pages without processVolume's page mapping.
    parseMokuroFile.mockResolvedValue({
      version: '0.2.0',
      seriesUuid: 'series-1',
      charOffsetsMethod: 'cells',
      pages: [
        { blocks: [{ lines: ['あ'], char_offsets: [[0, 40]] }] },
        { blocks: [{ lines: ['い'] }] },
        { char_offsets_method: 'attn-cells', blocks: [{ lines: ['う'], char_offsets: [[0, 40]] }] }
      ]
    });
    enqueueCloudOcrUpgrade(imageOnlyVolume, sidecar);

    await vi.waitFor(async () => {
      const ocr = await (db as any).table('volume_ocr').get('vol-1');
      expect(ocr.pages).toHaveLength(3);
    });
    const ocr = await (db as any).table('volume_ocr').get('vol-1');
    expect(ocr.pages[0].char_offsets_method).toBe('cells');
    // nothing placed: no method claimed
    expect('char_offsets_method' in ocr.pages[1]).toBe(false);
    // the page's own value wins
    expect(ocr.pages[2].char_offsets_method).toBe('attn-cells');
  });
});
