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
