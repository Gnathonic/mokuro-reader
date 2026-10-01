import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

/**
 * The automatic OCR upgrade, end to end over the app's REAL schema: a cached
 * `series.json` names a `mokuro_sha256` per volume, the listing shows the
 * primary sidecars, and `requestOcrUpgradePass` decides per installed volume
 * (equal / different / absent-baseline), downloads at most 4 at a time, and
 * writes through `applyCloudPrimaryOcr`.
 */

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const { declareMokuroSchema } = await import('$lib/catalog/db-schema');
  const db: any = new Dexie('ocr-upgrade-pass-test');
  declareMokuroSchema(db);
  return { db };
});
vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));

const cloud = vi.hoisted(() => {
  const state = {
    bodies: new Map<string, string>(),
    files: [] as Array<{
      provider: string;
      fileId: string;
      path: string;
      modifiedTime: string;
      size: number;
    }>,
    /** Downloads in flight right now, and the most seen at once. */
    inFlight: 0,
    peak: 0,
    /** Resolves pending downloads when a test holds them. */
    gate: null as Promise<void> | null,
    failNext: 0
  };
  const downloadFile = vi.fn(async (file: { path: string }) => {
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      if (state.gate) await state.gate;
      if (state.failNext > 0) {
        state.failNext--;
        throw new Error('network down');
      }
      const body = state.bodies.get(file.path);
      if (body === undefined) throw new Error(`404 ${file.path}`);
      return new Blob([body]);
    } finally {
      state.inFlight--;
    }
  });
  const provider = { type: 'webdav', downloadFile };
  return { state, provider, downloadFile };
});

vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: { getActiveProvider: () => cloud.provider }
}));
vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: { getCache: () => ({ getAllFiles: () => [...cloud.state.files] }) }
}));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { getActiveProvider: () => cloud.provider }
}));
const showSnackbar = vi.hoisted(() => vi.fn());
vi.mock('$lib/util/snackbar', () => ({ showSnackbar }));

import { db } from '$lib/catalog/db';
import { currentView } from '$lib/util/hash-router';
import { getLayerMeta, getLayerPages, putLayerWithPages } from './layer-store';
import { sha256Hex } from './mokuro-hash';
import { putSeriesIndex } from '$lib/metadata/series-index';
import type { SeriesFileVolume } from '$lib/metadata/series-file';
import type { Page, VolumeMetadata } from '$lib/types';
import {
  MAX_CONCURRENT_OCR_DOWNLOADS,
  _lastOcrUpgradeResultForTests,
  _resetOcrUpgradePassForTests,
  requestOcrUpgradePass
} from './ocr-upgrade-pass';
import {
  PREVIOUS_OCR_LAYER_ID,
  UPDATED_OCR_LAYER_ID,
  isUntouchedUpgradeLayer
} from './cloud-ocr-upgrade';

const SERIES = 'Cloud Series';

function page(img_path: string, text: string): Page {
  return {
    version: '0.2.1',
    img_width: 400,
    img_height: 600,
    img_path,
    blocks: [{ box: [250, 50, 310, 250], vertical: true, font_size: 30, lines: [text] } as never]
  };
}

/** A `.mokuro` whose pages carry these texts (image names `001.png`, `002.png`, …). */
function mokuro(texts: string[], uuid = 'vol-1', version = '0.2.1'): string {
  return JSON.stringify({
    version,
    title: SERIES,
    title_uuid: 'series-uuid',
    volume: 'Vol 1',
    volume_uuid: uuid,
    pages: texts.map((t, i) => page(`${String(i + 1).padStart(3, '0')}.png`, t)),
    chars: 0
  });
}

async function hashOf(body: string): Promise<string> {
  return (await sha256Hex(new Blob([body])))!;
}

/** An installed volume whose local pages carry these texts, under its OWN image names. */
async function installVolume(
  texts: string[],
  partial: Partial<VolumeMetadata> = {}
): Promise<VolumeMetadata> {
  const row: VolumeMetadata = {
    volume_uuid: 'vol-1',
    series_uuid: 'series-uuid',
    series_title: SERIES,
    volume_title: 'Vol 1',
    mokuro_version: '0.2.1',
    page_count: texts.length,
    character_count: texts.length,
    page_char_counts: texts.map((_, i) => i + 1),
    ...partial
  };
  await db.volumes.put(row);
  await db.volume_ocr.put({
    volume_uuid: row.volume_uuid,
    pages: texts.map((t, i) => page(`Vol 1/${String(i + 1).padStart(3, '0')}.jpg`, t))
  });
  return row;
}

/** The cloud folder: an archive + primary sidecar per volume title. */
function listSidecar(volumeTitle: string, body: string, opts: { gz?: boolean } = {}) {
  const path = `${SERIES}/${volumeTitle}.mokuro${opts.gz ? '.gz' : ''}`;
  cloud.state.bodies.set(path, body);
  cloud.state.files.push(
    {
      provider: 'webdav',
      fileId: `${volumeTitle}.cbz`,
      path: `${SERIES}/${volumeTitle}.cbz`,
      modifiedTime: '2026-09-30T10:00:00.000Z',
      size: 1000
    },
    {
      provider: 'webdav',
      fileId: path,
      path,
      modifiedTime: '2026-09-30T10:00:00.000Z',
      size: new TextEncoder().encode(body).length
    }
  );
}

async function cacheIndex(entries: Array<Partial<SeriesFileVolume>>): Promise<void> {
  await putSeriesIndex({
    series_key: 'cloud series',
    series_title: SERIES,
    file: {
      version: 2,
      series_title: SERIES,
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '1970-01-01T00:00:00.000Z',
      volumes: entries.map((e) => ({
        volume_uuid: 'vol-1',
        volume_title: 'Vol 1',
        page_count: 2,
        character_count: 2,
        mokuro_version: '0.2.1',
        ...e
      }))
    },
    source: {
      provider: 'webdav',
      path: `${SERIES}/series.json`,
      size: 10,
      modifiedTime: '2026-09-30T10:00:00.000Z'
    },
    fetched_at: '2026-09-30T10:00:00.000Z'
  });
}

async function pass(): Promise<void> {
  await requestOcrUpgradePass('webdav', [{ title: SERIES }]);
}

async function primaryTexts(uuid = 'vol-1'): Promise<string[]> {
  const ocr = await db.volume_ocr.get(uuid);
  return ocr!.pages.map((p) => p.blocks.map((b) => b.lines.join('')).join(''));
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  _resetOcrUpgradePassForTests();
  cloud.state.bodies.clear();
  cloud.state.files = [];
  cloud.state.inFlight = 0;
  cloud.state.peak = 0;
  cloud.state.gate = null;
  cloud.state.failNext = 0;
  currentView.set({ type: 'catalog' } as never);
  await Promise.all([
    db.volumes.clear(),
    db.volume_ocr.clear(),
    db.series_index.clear(),
    db.volume_ocr_layers.clear(),
    db.volume_ocr_layer_pages.clear()
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the OCR upgrade pass', () => {
  it('does nothing — not even a download — when no index entry carries a hash', async () => {
    await installVolume(['あ', 'い']);
    listSidecar('Vol 1', mokuro(['か', 'き']));
    await cacheIndex([{}]);

    await pass();

    expect(cloud.downloadFile).not.toHaveBeenCalled();
    expect(await primaryTexts()).toEqual(['あ', 'い']);
    expect(showSnackbar).not.toHaveBeenCalled();
  });

  it('does nothing when the published hash is the one the volume was installed from', async () => {
    const body = mokuro(['か', 'き']);
    const hash = await hashOf(body);
    await installVolume(['あ', 'い'], { mokuro_sha256: hash });
    listSidecar('Vol 1', body);
    await cacheIndex([{ mokuro_sha256: hash }]);

    await pass();

    expect(cloud.downloadFile).not.toHaveBeenCalled();
    expect(await primaryTexts()).toEqual(['あ', 'い']);
  });

  it('upgrades an unedited volume whose hash differs: pages, counts, version, hash — uuid kept', async () => {
    const body = mokuro(['かき', 'くけこ'], 'vol-1', '0.3.0');
    const hash = await hashOf(body);
    await installVolume(['あ', 'い'], { mokuro_sha256: 'f'.repeat(64) });
    listSidecar('Vol 1', body);
    await cacheIndex([{ mokuro_sha256: hash }]);

    await pass();

    expect(cloud.downloadFile).toHaveBeenCalledTimes(1);
    expect(await primaryTexts()).toEqual(['かき', 'くけこ']);
    const ocr = await db.volume_ocr.get('vol-1');
    // The volume's OWN image names, not the sidecar's.
    expect(ocr!.pages.map((p) => p.img_path)).toEqual(['Vol 1/001.jpg', 'Vol 1/002.jpg']);
    const row = (await db.volumes.get('vol-1'))!;
    expect(row).toMatchObject({
      volume_uuid: 'vol-1',
      mokuro_version: '0.3.0',
      page_count: 2,
      character_count: 5,
      page_char_counts: [2, 5],
      mokuro_sha256: hash,
      mokuro_sha256_cloud: {
        provider: 'webdav',
        size: new TextEncoder().encode(body).length,
        modified: Date.parse('2026-09-30T10:00:00.000Z') / 1000
      }
    });
    expect(_lastOcrUpgradeResultForTests()).toMatchObject({ upgraded: 1 });
    expect(showSnackbar).toHaveBeenCalledTimes(1);
    expect(showSnackbar.mock.calls[0][0]).toBe('Updated OCR for 1 volume');

    // Converged: the next pass downloads nothing.
    await pass();
    expect(cloud.downloadFile).toHaveBeenCalledTimes(1);
  });

  it('a server re-OCR under a NEW uuid is matched by title, and the local uuid is kept', async () => {
    const body = mokuro(['新', 'しい'], 'server-new-uuid');
    await installVolume(['あ', 'い'], { mokuro_sha256: 'f'.repeat(64) });
    listSidecar('Vol 1', body);
    await cacheIndex([{ volume_uuid: 'server-new-uuid', mokuro_sha256: await hashOf(body) }]);

    await pass();

    expect(await db.volumes.get('server-new-uuid')).toBeUndefined();
    expect(await primaryTexts('vol-1')).toEqual(['新', 'しい']);
  });

  describe('a volume installed before hashes existed (no local hash): the one-time baseline', () => {
    it('same pages under other bytes → only the hash is recorded, and no notice', async () => {
      await installVolume(['あ', 'い']);
      // Same OCR, different serialization (key order, image names, spacing).
      const body = JSON.stringify(JSON.parse(mokuro(['あ', 'い'])), null, 2);
      const hash = await hashOf(body);
      listSidecar('Vol 1', body);
      await cacheIndex([{ mokuro_sha256: hash }]);
      const before = await db.volumes.get('vol-1');

      await pass();

      const row = (await db.volumes.get('vol-1'))!;
      expect(row.mokuro_sha256).toBe(hash);
      expect(row.page_char_counts).toEqual(before!.page_char_counts);
      expect(await primaryTexts()).toEqual(['あ', 'い']);
      expect(_lastOcrUpgradeResultForTests()).toMatchObject({ recorded: 1, upgraded: 0 });
      expect(showSnackbar).not.toHaveBeenCalled();

      await pass();
      expect(cloud.downloadFile).toHaveBeenCalledTimes(1);
    });

    it('different pages → it is an upgrade', async () => {
      await installVolume(['あ', 'い']);
      const body = mokuro(['か', 'き']);
      listSidecar('Vol 1', body);
      await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);

      await pass();

      expect(await primaryTexts()).toEqual(['か', 'き']);
    });
  });

  it('skips a sidecar with another page count (a different archive) and does not re-fetch it', async () => {
    await installVolume(['あ', 'い']);
    const body = mokuro(['か', 'き', 'く']);
    listSidecar('Vol 1', body);
    await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);

    await pass();
    await pass();

    expect(cloud.downloadFile).toHaveBeenCalledTimes(1);
    expect(await primaryTexts()).toEqual(['あ', 'い']);
    expect((await db.volumes.get('vol-1'))!.mokuro_sha256).toBeUndefined();
  });

  it('reads the primary sidecar only — never a layer file — preferring .mokuro over .mokuro.gz', async () => {
    const body = mokuro(['か', 'き']);
    await installVolume(['あ', 'い'], { mokuro_sha256: 'f'.repeat(64) });
    listSidecar('Vol 1', body);
    // A layer file and a stray gz twin beside it.
    cloud.state.files.push({
      provider: 'webdav',
      fileId: 'layer',
      path: `${SERIES}/Vol 1.paddle-manga.mokuro`,
      modifiedTime: '2026-09-30T10:00:00.000Z',
      size: 5
    });
    await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);

    await pass();

    expect(cloud.downloadFile.mock.calls.map((c) => (c[0] as { path: string }).path)).toEqual([
      `${SERIES}/Vol 1.mokuro`
    ]);
  });

  it('leaves metadata-only and placeholder rows alone (installed rows only)', async () => {
    const body = mokuro(['か', 'き']);
    await installVolume(['あ', 'い'], { metadata_only: true });
    listSidecar('Vol 1', body);
    await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);

    await pass();

    expect(cloud.downloadFile).not.toHaveBeenCalled();
  });

  describe('a volume whose OCR the user edited', () => {
    it('keeps the edited primary and files the server OCR as the updated-ocr layer', async () => {
      await installVolume(['なおした', 'い'], {
        mokuro_sha256: 'f'.repeat(64),
        ocr_edited_at: '2026-09-01T00:00:00.000Z'
      });
      const body = mokuro(['か', 'き']);
      const hash = await hashOf(body);
      listSidecar('Vol 1', body);
      await cacheIndex([{ mokuro_sha256: hash }]);

      await pass();

      expect(await primaryTexts()).toEqual(['なおした', 'い']);
      const layer = await getLayerMeta(db, 'vol-1', UPDATED_OCR_LAYER_ID);
      expect(layer).toMatchObject({ kind: 'ocr', name: 'Updated OCR', source_sha256: hash });
      expect(isUntouchedUpgradeLayer(layer)).toBe(true);
      const pages = (await getLayerPages(db, 'vol-1', UPDATED_OCR_LAYER_ID))!;
      expect(pages.map((p) => p.blocks[0].lines[0])).toEqual(['か', 'き']);
      expect(pages.map((p) => p.img_path)).toEqual(['Vol 1/001.jpg', 'Vol 1/002.jpg']);
      const row = (await db.volumes.get('vol-1'))!;
      // The base revision is unchanged: the primary is still the old file + edits.
      expect(row.mokuro_sha256).toBe('f'.repeat(64));
      expect(row.updated_ocr_sha256).toBe(hash);
      expect(showSnackbar.mock.calls[0][0]).toMatch(/edited volume/);

      // Not refiled by the next listing.
      await pass();
      expect(cloud.downloadFile).toHaveBeenCalledTimes(1);
    });

    it('a still newer server OCR REPLACES the untouched layer instead of adding one', async () => {
      await installVolume(['なおした', 'い'], {
        mokuro_sha256: 'f'.repeat(64),
        ocr_edited_at: '2026-09-01T00:00:00.000Z'
      });
      const first = mokuro(['か', 'き']);
      listSidecar('Vol 1', first);
      await cacheIndex([{ mokuro_sha256: await hashOf(first) }]);
      await pass();

      const second = mokuro(['さ', 'し']);
      cloud.state.files = [];
      listSidecar('Vol 1', second);
      await cacheIndex([{ mokuro_sha256: await hashOf(second) }]);
      await pass();

      const layers = await db.volume_ocr_layers.where('volume_uuid').equals('vol-1').toArray();
      expect(layers.map((l) => l.layer_id)).toEqual([UPDATED_OCR_LAYER_ID]);
      const pages = (await getLayerPages(db, 'vol-1', UPDATED_OCR_LAYER_ID))!;
      expect(pages.map((p) => p.blocks[0].lines[0])).toEqual(['さ', 'し']);
      expect(layers[0].source_sha256).toBe(await hashOf(second));
    });

    it('an updated-ocr layer the user edited is theirs: left alone, file remembered', async () => {
      await installVolume(['なおした', 'い'], {
        mokuro_sha256: 'f'.repeat(64),
        ocr_edited_at: '2026-09-01T00:00:00.000Z'
      });
      await putLayerWithPages(db, {
        volume_uuid: 'vol-1',
        layer_id: UPDATED_OCR_LAYER_ID,
        name: 'Updated OCR',
        kind: 'ocr',
        created_at: 't0',
        updated_at: 't2', // edited after the upgrade wrote it at t1
        source_sha256: 'e'.repeat(64),
        source_at: 't1',
        pages: [page('Vol 1/001.jpg', '私の'), page('Vol 1/002.jpg', '編集')]
      });
      const body = mokuro(['さ', 'し']);
      listSidecar('Vol 1', body);
      await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);

      await pass();
      await pass();

      const pages = (await getLayerPages(db, 'vol-1', UPDATED_OCR_LAYER_ID))!;
      expect(pages.map((p) => p.blocks[0].lines[0])).toEqual(['私の', '編集']);
      expect(cloud.downloadFile).toHaveBeenCalledTimes(1);
    });

    it('a cloud file equal to the pre-edit original is no news: only the hash is recorded', async () => {
      await installVolume(['なおした', 'い'], { ocr_edited_at: '2026-09-01T00:00:00.000Z' });
      await putLayerWithPages(db, {
        volume_uuid: 'vol-1',
        layer_id: 'original',
        name: 'Original',
        kind: 'original',
        created_at: 't0',
        updated_at: 't0',
        pages: [page('Vol 1/001.jpg', 'あ'), page('Vol 1/002.jpg', 'い')]
      });
      const body = mokuro(['あ', 'い']);
      const hash = await hashOf(body);
      listSidecar('Vol 1', body);
      await cacheIndex([{ mokuro_sha256: hash }]);

      await pass();

      expect(await getLayerMeta(db, 'vol-1', UPDATED_OCR_LAYER_ID)).toBeUndefined();
      expect((await db.volumes.get('vol-1'))!.mokuro_sha256).toBe(hash);
      expect(await primaryTexts()).toEqual(['なおした', 'い']);
    });
  });

  it('defers the volume open in the reader, and the next pass applies it', async () => {
    await installVolume(['あ', 'い'], { mokuro_sha256: 'f'.repeat(64) });
    const body = mokuro(['か', 'き']);
    listSidecar('Vol 1', body);
    await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);
    currentView.set({ type: 'reader', seriesId: SERIES, volumeId: 'vol-1' } as never);

    await pass();
    expect(cloud.downloadFile).not.toHaveBeenCalled();
    expect(await primaryTexts()).toEqual(['あ', 'い']);
    expect(_lastOcrUpgradeResultForTests()).toMatchObject({ deferred: 1 });

    // The reader closed; ANY later pass (even one naming no series) retries it.
    currentView.set({ type: 'catalog' } as never);
    await requestOcrUpgradePass('webdav', []);
    expect(await primaryTexts()).toEqual(['か', 'き']);
  });

  it('a failed download is logged, not shown, and retried by the next pass', async () => {
    await installVolume(['あ', 'い'], { mokuro_sha256: 'f'.repeat(64) });
    const body = mokuro(['か', 'き']);
    listSidecar('Vol 1', body);
    await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);
    cloud.state.failNext = 1;

    await pass();
    expect(_lastOcrUpgradeResultForTests()).toMatchObject({ failed: 1 });
    expect(showSnackbar).not.toHaveBeenCalled();
    expect(await primaryTexts()).toEqual(['あ', 'い']);

    await requestOcrUpgradePass('webdav', []);
    expect(await primaryTexts()).toEqual(['か', 'き']);
  });

  it(`downloads at most ${MAX_CONCURRENT_OCR_DOWNLOADS} at a time, with ONE notice for the run`, async () => {
    const entries: Array<Partial<SeriesFileVolume>> = [];
    for (let i = 1; i <= 7; i++) {
      const title = `Vol ${i}`;
      await installVolume(['あ', 'い'], {
        volume_uuid: `vol-${i}`,
        volume_title: title,
        mokuro_sha256: 'f'.repeat(64)
      });
      const body = mokuro([`か${i}`, 'き'], `vol-${i}`);
      listSidecar(title, body);
      entries.push({
        volume_uuid: `vol-${i}`,
        volume_title: title,
        mokuro_sha256: await hashOf(body)
      });
    }
    await cacheIndex(entries);
    let release!: () => void;
    cloud.state.gate = new Promise<void>((r) => (release = r));

    const run = pass();
    await vi.waitFor(() =>
      expect(cloud.downloadFile).toHaveBeenCalledTimes(MAX_CONCURRENT_OCR_DOWNLOADS)
    );
    // Held at the cap: nothing else starts while four are in flight.
    await new Promise((r) => setTimeout(r, 20));
    expect(cloud.downloadFile).toHaveBeenCalledTimes(MAX_CONCURRENT_OCR_DOWNLOADS);
    release();
    await run;

    expect(cloud.downloadFile).toHaveBeenCalledTimes(7);
    expect(cloud.state.peak).toBe(MAX_CONCURRENT_OCR_DOWNLOADS);
    expect(showSnackbar).toHaveBeenCalledTimes(1);
    expect(showSnackbar.mock.calls[0][0]).toBe('Updated OCR for 7 volumes');
  });

  it('is single-flight: requests during a run merge into ONE follow-up run', async () => {
    await installVolume(['あ', 'い'], { mokuro_sha256: 'f'.repeat(64) });
    const body = mokuro(['か', 'き']);
    listSidecar('Vol 1', body);
    await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);
    let release!: () => void;
    cloud.state.gate = new Promise<void>((r) => (release = r));

    const first = pass();
    await vi.waitFor(() => expect(cloud.downloadFile).toHaveBeenCalledTimes(1));
    const second = pass();
    const third = pass();
    release();
    cloud.state.gate = null;
    await Promise.all([first, second, third]);

    // The first run applied it; the ONE follow-up found nothing left to fetch.
    expect(cloud.downloadFile).toHaveBeenCalledTimes(1);
    expect(await primaryTexts()).toEqual(['か', 'き']);
  });

  it('a stale index hash is not re-fetched every pass once the served bytes were applied', async () => {
    await installVolume(['あ', 'い'], { mokuro_sha256: 'f'.repeat(64) });
    const served = mokuro(['か', 'き']);
    listSidecar('Vol 1', served);
    // The index names some other file than the one the listing serves.
    await cacheIndex([{ mokuro_sha256: 'a'.repeat(64) }]);

    await pass();
    await pass();

    expect(cloud.downloadFile).toHaveBeenCalledTimes(1);
    // What WAS served is what got installed, under its real hash.
    expect((await db.volumes.get('vol-1'))!.mokuro_sha256).toBe(await hashOf(served));
  });

  it('only trusts an index cached from the provider being asked', async () => {
    await installVolume(['あ', 'い'], { mokuro_sha256: 'f'.repeat(64) });
    const body = mokuro(['か', 'き']);
    listSidecar('Vol 1', body);
    await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);
    const rec = (await db.series_index.get('cloud series'))!;
    await db.series_index.put({ ...rec, source: { ...rec.source, provider: 'google-drive' } });

    await pass();

    expect(cloud.downloadFile).not.toHaveBeenCalled();
  });

  describe('provenance: where the local OCR came from decides what is kept', () => {
    const ATTESTED = { provider: 'webdav', size: 10, modified: 1 };

    async function layerIds(): Promise<string[]> {
      return (await db.volume_ocr_layers.where('volume_uuid').equals('vol-1').toArray())
        .map((l) => l.layer_id)
        .sort();
    }

    it('a sidecar made for images of another size is not applied, and not re-fetched', async () => {
      await installVolume(['あ', 'い'], { mokuro_sha256: 'f'.repeat(64) });
      const other = JSON.parse(mokuro(['か', 'き']));
      for (const p of other.pages) {
        p.img_width = 800;
        p.img_height = 1200;
      }
      const body = JSON.stringify(other);
      listSidecar('Vol 1', body);
      await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);

      await pass();
      await pass();

      expect(cloud.downloadFile).toHaveBeenCalledTimes(1);
      expect(await primaryTexts()).toEqual(['あ', 'い']);
      expect(await layerIds()).toEqual([]);
      expect((await db.volumes.get('vol-1'))!.mokuro_sha256).toBe('f'.repeat(64));
    });

    it('…nor filed as the updated-ocr layer of an edited volume', async () => {
      await installVolume(['なおした', 'い'], {
        mokuro_sha256: 'f'.repeat(64),
        ocr_edited_at: '2026-09-01T00:00:00.000Z'
      });
      const other = JSON.parse(mokuro(['か', 'き']));
      other.pages[1].img_height = 999;
      const body = JSON.stringify(other);
      listSidecar('Vol 1', body);
      await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);

      await pass();

      expect(await layerIds()).toEqual([]);
    });

    it("a primary attested as THIS cloud's file is replaced outright (no keepsake)", async () => {
      await installVolume(['あ', 'い'], {
        mokuro_sha256: 'f'.repeat(64),
        mokuro_sha256_cloud: ATTESTED
      });
      const body = mokuro(['か', 'き']);
      listSidecar('Vol 1', body);
      await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);

      await pass();

      expect(await primaryTexts()).toEqual(['か', 'き']);
      expect(await layerIds()).toEqual([]);
    });

    for (const [label, partial] of [
      ['a local import (hash, no attestation)', { mokuro_sha256: 'f'.repeat(64) }],
      ['a legacy row (no hash at all)', {}],
      [
        'a primary attested for ANOTHER provider',
        {
          mokuro_sha256: 'f'.repeat(64),
          mokuro_sha256_cloud: { provider: 'google-drive', size: 10 }
        }
      ]
    ] as const) {
      it(`${label}: upgraded, the replaced OCR kept as the local previous-ocr layer`, async () => {
        await installVolume(['あ', 'い'], partial as Partial<VolumeMetadata>);
        const body = mokuro(['か', 'き']);
        listSidecar('Vol 1', body);
        await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);

        await pass();

        expect(await primaryTexts()).toEqual(['か', 'き']);
        expect(await layerIds()).toEqual([PREVIOUS_OCR_LAYER_ID]);
        const meta = (await getLayerMeta(db, 'vol-1', PREVIOUS_OCR_LAYER_ID))!;
        expect(meta).toMatchObject({ name: 'Previous OCR', kind: 'ocr' });
        expect(isUntouchedUpgradeLayer(meta)).toBe(true);
        expect(meta.source_sha256).toBe(
          (partial as Partial<VolumeMetadata>).mokuro_sha256 ?? undefined
        );
        const kept = (await getLayerPages(db, 'vol-1', PREVIOUS_OCR_LAYER_ID))!;
        expect(kept.map((p) => p.blocks[0].lines[0])).toEqual(['あ', 'い']);
        expect(kept.map((p) => p.img_path)).toEqual(['Vol 1/001.jpg', 'Vol 1/002.jpg']);
      });
    }

    it('a later replacement overwrites an UNTOUCHED keepsake, never one the user edited', async () => {
      await installVolume(['あ', 'い'], { mokuro_sha256: 'f'.repeat(64) });
      const first = mokuro(['か', 'き']);
      listSidecar('Vol 1', first);
      await cacheIndex([{ mokuro_sha256: await hashOf(first) }]);
      await pass();

      // The user re-imports their own OCR (no attestation again)…
      await installVolume(['さ', 'し'], { mokuro_sha256: 'e'.repeat(64) });
      const second = mokuro(['た', 'ち']);
      cloud.state.files = [];
      listSidecar('Vol 1', second);
      await cacheIndex([{ mokuro_sha256: await hashOf(second) }]);
      await pass();
      expect(await layerIds()).toEqual([PREVIOUS_OCR_LAYER_ID]);
      let kept = (await getLayerPages(db, 'vol-1', PREVIOUS_OCR_LAYER_ID))!;
      expect(kept.map((p) => p.blocks[0].lines[0])).toEqual(['さ', 'し']);

      // …then edits the keepsake: it is theirs now.
      const meta = (await getLayerMeta(db, 'vol-1', PREVIOUS_OCR_LAYER_ID))!;
      await putLayerWithPages(db, {
        ...meta,
        updated_at: new Date(Date.parse(meta.updated_at) + 1000).toISOString(),
        pages: [page('Vol 1/001.jpg', '私の'), page('Vol 1/002.jpg', '編集')]
      });
      await installVolume(['な', 'に'], { mokuro_sha256: 'd'.repeat(64) });
      const third = mokuro(['は', 'ひ']);
      cloud.state.files = [];
      listSidecar('Vol 1', third);
      await cacheIndex([{ mokuro_sha256: await hashOf(third) }]);
      await pass();

      expect(await primaryTexts()).toEqual(['は', 'ひ']);
      kept = (await getLayerPages(db, 'vol-1', PREVIOUS_OCR_LAYER_ID))!;
      expect(kept.map((p) => p.blocks[0].lines[0])).toEqual(['私の', '編集']);
      expect(await layerIds()).toEqual([PREVIOUS_OCR_LAYER_ID, `${PREVIOUS_OCR_LAYER_ID}-2`]);
      const next = (await getLayerPages(db, 'vol-1', `${PREVIOUS_OCR_LAYER_ID}-2`))!;
      expect(next.map((p) => p.blocks[0].lines[0])).toEqual(['な', 'に']);
    });
  });

  describe('snapshots a replaced primary leaves stale', () => {
    async function seedLayer(layer_id: string, extra: Record<string, unknown>, text: string) {
      await putLayerWithPages(db, {
        volume_uuid: 'vol-1',
        layer_id,
        name: layer_id,
        kind: layer_id === 'original' ? 'original' : 'ocr',
        created_at: 't0',
        updated_at: 't1',
        ...extra,
        pages: [page('Vol 1/001.jpg', text), page('Vol 1/002.jpg', text)]
      } as never);
    }

    it('drops the old original (tombstoning its cloud copy) and an untouched updated-ocr', async () => {
      await installVolume(['あ', 'い'], {
        mokuro_sha256: 'f'.repeat(64),
        mokuro_sha256_cloud: { provider: 'webdav', size: 10 }
      });
      await seedLayer(
        'original',
        { cloud: { provider: 'webdav', size: 5, synced_at: 't1' } },
        '古'
      );
      await seedLayer(
        UPDATED_OCR_LAYER_ID,
        { source_sha256: 'e'.repeat(64), source_at: 't1' },
        '旧'
      );
      const body = mokuro(['か', 'き']);
      listSidecar('Vol 1', body);
      await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);

      await pass();

      expect(await primaryTexts()).toEqual(['か', 'き']);
      expect(await getLayerMeta(db, 'vol-1', 'original')).toBeUndefined();
      expect(await getLayerPages(db, 'vol-1', 'original')).toBeFalsy();
      expect(await getLayerMeta(db, 'vol-1', UPDATED_OCR_LAYER_ID)).toBeUndefined();
      const tombstones = JSON.parse(localStorage.getItem('layer-sync:pending-deletes') ?? '[]');
      expect(tombstones).toContainEqual({
        volume_uuid: 'vol-1',
        layer_id: 'original',
        provider: 'webdav'
      });
    });

    it('keeps an updated-ocr layer the user edited', async () => {
      await installVolume(['あ', 'い'], {
        mokuro_sha256: 'f'.repeat(64),
        mokuro_sha256_cloud: { provider: 'webdav', size: 10 }
      });
      await seedLayer(
        UPDATED_OCR_LAYER_ID,
        { source_sha256: 'e'.repeat(64), source_at: 't0' }, // edited at t1
        '私の'
      );
      const body = mokuro(['か', 'き']);
      listSidecar('Vol 1', body);
      await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);

      await pass();

      expect(await primaryTexts()).toEqual(['か', 'き']);
      expect(await getLayerMeta(db, 'vol-1', UPDATED_OCR_LAYER_ID)).toBeDefined();
    });
  });

  describe('a sidecar the reader cannot parse', () => {
    for (const [label, body] of [
      ['JSON with NaN', '{"version":"0.2.1","title":"S","pages":[],"chars":NaN}'],
      [
        'a file missing title_uuid',
        JSON.stringify((({ title_uuid: _drop, ...rest }) => rest)(JSON.parse(mokuro(['か', 'き']))))
      ]
    ] as const) {
      it(`${label}: recorded as unusable for this hash, never re-downloaded`, async () => {
        await installVolume(['あ', 'い'], { mokuro_sha256: 'f'.repeat(64) });
        listSidecar('Vol 1', body);
        await cacheIndex([{ mokuro_sha256: await hashOf(body) }]);

        await pass();
        await requestOcrUpgradePass('webdav', []); // the retry list, too
        await pass();

        expect(cloud.downloadFile).toHaveBeenCalledTimes(1);
        expect(await primaryTexts()).toEqual(['あ', 'い']);
        expect(_lastOcrUpgradeResultForTests()).toMatchObject({ failed: 0 });
      });
    }

    it('a NEW hash for the volume gets a new look', async () => {
      await installVolume(['あ', 'い'], { mokuro_sha256: 'f'.repeat(64) });
      const broken = '{"chars":NaN}';
      listSidecar('Vol 1', broken);
      await cacheIndex([{ mokuro_sha256: await hashOf(broken) }]);
      await pass();

      const fixed = mokuro(['か', 'き']);
      cloud.state.files = [];
      listSidecar('Vol 1', fixed);
      await cacheIndex([{ mokuro_sha256: await hashOf(fixed) }]);
      await pass();

      expect(cloud.downloadFile).toHaveBeenCalledTimes(2);
      expect(await primaryTexts()).toEqual(['か', 'き']);
    });
  });

  it('bytes of another size than the listing (a stale HTTP cache) are not judged: retried, no verdict', async () => {
    const old = mokuro(['あ', 'い']);
    await installVolume(['あ', 'い'], { mokuro_sha256: await hashOf(old) });
    const fresh = mokuro(['かき', 'くけ']);
    listSidecar('Vol 1', fresh); // the listing: the NEW file's size
    await cacheIndex([{ mokuro_sha256: await hashOf(fresh) }]);
    // The browser's cache still answers with the OLD bytes.
    cloud.state.bodies.set(`${SERIES}/Vol 1.mokuro`, old);

    await pass();
    expect(_lastOcrUpgradeResultForTests()).toMatchObject({ failed: 1 });
    expect(await primaryTexts()).toEqual(['あ', 'い']);

    // Revalidated: the real bytes arrive, and the upgrade happens.
    cloud.state.bodies.set(`${SERIES}/Vol 1.mokuro`, fresh);
    await pass();
    expect(cloud.downloadFile).toHaveBeenCalledTimes(2);
    expect(await primaryTexts()).toEqual(['かき', 'くけ']);
  });
});
