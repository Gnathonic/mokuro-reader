/**
 * Folder names vs cleaned up (#285): the image-only review can name volumes
 * after their folders verbatim instead of the cleaned-up guess the series
 * extraction makes, and remembers the mode last used
 * (`keepFolderNamesAsTitles`). The rule itself, then every import path end to
 * end (directory, root-level archive, archive in a folder, series archive,
 * nested archives) in both modes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { get } from 'svelte/store';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

// ---------------------------------------------------------------- mocks

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db: any = new Dexie('keep-folder-names-test');
  db.version(1).stores({
    volumes: 'volume_uuid, series_uuid, series_title',
    volume_ocr: 'volume_uuid',
    volume_files: 'volume_uuid',
    series_metadata: 'series_key',
    series_index: 'series_key'
  });
  db.processThumbnails = async () => undefined;
  return { db };
});

vi.mock('$lib/catalog/thumbnails', () => ({
  generateThumbnail: async () => ({
    file: new File([new Uint8Array([1])], 'thumb.webp', { type: 'image/webp' }),
    width: 10,
    height: 14
  })
}));

vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));

vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: {
    addProcess: vi.fn(),
    updateProcess: vi.fn(),
    removeProcess: vi.fn()
  }
}));

vi.mock('$lib/util/modals', () => ({
  promptMissingFiles: (_info: unknown, onContinue: () => void) => onContinue()
}));

vi.mock('$lib/metadata/series-file-sync', () => ({ scheduleSeriesFileWrite: vi.fn() }));

vi.mock('$lib/util/file-processing-pool', () => ({
  getFileProcessingPool: async () => ({ addTask: () => {} }),
  incrementPoolUsers: () => {},
  decrementPoolUsers: () => {}
}));

import { db } from '$lib/catalog/db';
import { miscSettings } from '$lib/settings/misc';
import {
  extractFolderTitlesFromPath,
  extractTitlesFromPath,
  generateDeterministicUUID
} from '$lib/util/series-extraction';
import { importFiles, importQueue, isImporting } from '../import-service';
import { processVolume } from '../processing';
import { nameGroup } from '../image-only-review';
import { storedTitle } from '../image-only-naming';
import { dialogDefaults, installReviewer, type Reviewer } from './helpers/review-bridge';

// ---------------------------------------------------------------- helpers

// zip.js writes the archive through a Blob stream; jsdom's Blob has none.
if (typeof Blob !== 'undefined' && !Blob.prototype.stream) {
  Blob.prototype.stream = function (this: Blob) {
    const bytes = this.arrayBuffer();
    return new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array(await bytes));
        controller.close();
      }
    });
  } as Blob['stream'];
}

const IMAGE: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3]);

/** A picked/dropped file, as the browser hands it over (path in webkitRelativePath). */
function picked(path: string, bytes: Uint8Array<ArrayBuffer> | Blob = IMAGE): File {
  const name = path.split('/').pop()!;
  const file = new File([bytes], name, { lastModified: 1_700_000_000_000 });
  if (path.includes('/')) {
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
  }
  return file;
}

/** Zip of the given entry paths (images get a few bytes, archives their own bytes). */
async function zipOf(entries: Array<string | { path: string; data: Uint8Array }>): Promise<Blob> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    bufferedWrite: false,
    extendedTimestamp: false
  });
  for (const entry of entries) {
    const { path, data } = typeof entry === 'string' ? { path: entry, data: IMAGE } : entry;
    await writer.add(path, new Uint8ArrayReader(data));
  }
  return new Blob([await writer.close()]);
}

async function zipBytes(entries: string[]): Promise<Uint8Array> {
  return new Uint8Array(await (await zipOf(entries)).arrayBuffer());
}

function setKeepFolderNames(on: boolean): void {
  miscSettings.set({ ...get(miscSettings), keepFolderNamesAsTitles: on });
}

async function waitForQueue(): Promise<void> {
  const start = Date.now();
  while (
    (get(isImporting) || get(importQueue).some((i) => i.status !== 'error')) &&
    Date.now() - start < 10_000
  ) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function importAndRead(files: File[]) {
  await importFiles(files);
  await waitForQueue();
  const rows = await db.volumes.toArray();
  return rows
    .map((r) => ({
      series: r.series_title,
      volume: r.volume_title,
      series_uuid: r.series_uuid,
      volume_uuid: r.volume_uuid
    }))
    .sort((a, b) => a.volume.localeCompare(b.volume));
}

const titles = (rows: { series: string; volume: string }[]) =>
  rows.map(({ series, volume }) => ({ series, volume }));

// ---------------------------------------------------------------- the rule

describe('extractFolderTitlesFromPath', () => {
  it('takes the volume folder and its parent verbatim', () => {
    expect(
      extractFolderTitlesFromPath('My Series (2023) [Digital]/Vol 03 [Digital]')
    ).toMatchObject({
      seriesTitle: 'My Series (2023) [Digital]',
      volumeTitle: 'Vol 03 [Digital]'
    });
  });

  it('names a root-level archive or folder after itself, series included', () => {
    expect(extractFolderTitlesFromPath('Vol 03 extra.cbz')).toMatchObject({
      seriesTitle: 'Vol 03 extra',
      volumeTitle: 'Vol 03 extra'
    });
    expect(extractFolderTitlesFromPath('Gleipnir v01 (2023) (Digital)')).toMatchObject({
      seriesTitle: 'Gleipnir v01 (2023) (Digital)',
      volumeTitle: 'Gleipnir v01 (2023) (Digital)'
    });
    // A deep-link download names its archive "/<Volume>.cbz".
    expect(extractFolderTitlesFromPath('/Vol 1.zip')).toMatchObject({
      seriesTitle: 'Vol 1',
      volumeTitle: 'Vol 1'
    });
  });

  it('uses only the immediate parent of a deeply nested volume', () => {
    expect(extractFolderTitlesFromPath('Downloads/Manga/My Series/Vol 1')).toMatchObject({
      seriesTitle: 'My Series',
      volumeTitle: 'Vol 1'
    });
  });

  it('takes a "suspect" container parent like Downloads verbatim — that is what was asked for', () => {
    expect(extractFolderTitlesFromPath('Downloads/Gleipnir 01')).toMatchObject({
      seriesTitle: 'Downloads',
      volumeTitle: 'Gleipnir 01'
    });
    // ...where the extraction (setting off) skips it and rewrites the volume.
    expect(extractTitlesFromPath('Downloads/Gleipnir 01')).toMatchObject({
      seriesTitle: 'Gleipnir',
      volumeTitle: 'Volume 01'
    });
  });

  it('sees through an archive that wraps a folder of its own name', () => {
    expect(extractFolderTitlesFromPath('My Series/Vol 1/Vol 1')).toMatchObject({
      seriesTitle: 'My Series',
      volumeTitle: 'Vol 1'
    });
  });

  it('says whether there was a parent folder at all', () => {
    expect(extractFolderTitlesFromPath('Chained Soldier (Semi-Color)/01').hasParent).toBe(true);
    expect(extractFolderTitlesFromPath('Vol 1.cbz').hasParent).toBe(false);
    expect(extractFolderTitlesFromPath('My Series/Vol 1/Vol 1').hasParent).toBe(true);
  });

  it('falls back to Unknown when there is no name at all', () => {
    expect(extractFolderTitlesFromPath('')).toMatchObject({
      seriesTitle: 'Unknown',
      volumeTitle: 'Unknown'
    });
    expect(extractFolderTitlesFromPath('.')).toMatchObject({
      seriesTitle: 'Unknown',
      volumeTitle: 'Unknown'
    });
  });
});

describe('processVolume and the review names', () => {
  const input = () => ({
    mokuroFile: null,
    imageFiles: new Map([['001.jpg', new File([], '001.jpg')]]),
    basePath: 'My Series (2023) [Digital]/Vol 03 [Digital]',
    sourceType: 'local' as const,
    nestedArchives: []
  });

  it('an image-only volume nobody reviewed (a cloud download) is named by the cleaned-up guess', async () => {
    const { metadata } = await processVolume(input());
    expect(metadata.series).toBe('My Series (2023) [Digital]');
    expect(metadata.volume).toBe('Volume 03');
  });

  it('a reviewed volume is saved under exactly the names and uuid the review chose', async () => {
    const { metadata } = await processVolume({
      ...input(),
      importNames: { series: 'Mine', volume: 'Mine 07', uuid: 'reviewed-uuid' }
    });
    expect(metadata).toMatchObject({
      series: 'Mine',
      volume: 'Mine 07',
      volumeUuid: 'reviewed-uuid',
      seriesUuid: generateDeterministicUUID('Mine')
    });
    expect(metadata.keepStoredTitles).toBeUndefined();
  });

  it('a restored volume asks the save to keep its row titles', async () => {
    const { metadata } = await processVolume({
      ...input(),
      importNames: { series: 'Mine', volume: 'x', uuid: 'old-uuid', restore: true }
    });
    expect(metadata).toMatchObject({ volumeUuid: 'old-uuid', keepStoredTitles: true });
  });
});

// ---------------------------------------------------------------- end to end

describe('importing image-only volumes', () => {
  let reviewer: Reviewer;

  beforeEach(async () => {
    reviewer = installReviewer();
    importQueue.set([]);
    await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), db.volume_files.clear()]);
  });

  afterEach(() => {
    reviewer.restore();
    setKeepFolderNames(false);
  });

  describe('the review offers exactly the names the import saves', () => {
    const files = () => [
      picked('Chained Soldier (Semi-Color)/01/page_0000.jpg'),
      picked('Chained Soldier (Semi-Color)/02/page_0000.jpg'),
      picked('Killing Bites/Killing Bites 01/001.webp')
    ];
    const sorted = (rows: { series: string; volume: string }[]) =>
      [...rows].sort((a, b) => a.volume.localeCompare(b.volume));

    for (const keep of [false, true]) {
      it(keep ? 'folder names' : 'cleaned up', async () => {
        setKeepFolderNames(keep);
        const rows = await importAndRead(files());
        const offered = reviewer.offered.flatMap((group) =>
          [...nameGroup(group, dialogDefaults(group)).values()].map((n) => ({
            series: storedTitle(n.series),
            volume: storedTitle(n.volume)
          }))
        );
        expect(sorted(offered)).toEqual(sorted(titles(rows)));
      });
    }
  });

  it('cleaned: numbering continues after the volumes the series already has', async () => {
    await importAndRead([
      picked('Chained Soldier (Semi-Color)/01/p.jpg'),
      picked('Chained Soldier (Semi-Color)/02/p.jpg')
    ]);
    importQueue.set([]);
    const rows = await importAndRead([picked('Chained Soldier (Semi-Color)/03/p.jpg')]);
    expect(titles(rows).map((r) => r.volume)).toEqual([
      'Chained Soldier (Semi-Color) 01',
      'Chained Soldier (Semi-Color) 02',
      'Chained Soldier (Semi-Color) 03'
    ]);
  });

  it('a volume keeps its uuid across naming modes, so a re-import never duplicates it', async () => {
    const files = () => [picked('Chained Soldier (Semi-Color)/01/p.jpg')];
    const [cleaned] = await importAndRead(files());
    importQueue.set([]);
    setKeepFolderNames(true);
    const rows = await importAndRead(files());
    expect(rows).toHaveLength(1);
    expect(rows[0].volume_uuid).toBe(cleaned.volume_uuid);
  });

  it('defaults to off', () => {
    localStorage.removeItem('miscSettings');
    expect(get(miscSettings).keepFolderNamesAsTitles).toBe(false);
  });

  describe('a dropped folder "My Series (2023) [Digital]/Vol 03 [Digital]"', () => {
    const files = () => [
      picked('My Series (2023) [Digital]/Vol 03 [Digital]/001.jpg'),
      picked('My Series (2023) [Digital]/Vol 03 [Digital]/002.jpg')
    ];

    it('off: the series folder name, numbered', async () => {
      const rows = await importAndRead(files());
      expect(titles(rows)).toEqual([
        { series: 'My Series (2023) [Digital]', volume: 'My Series (2023) [Digital] 01' }
      ]);
      expect(reviewer.offered.map((g) => g.series)).toEqual(['My Series (2023) [Digital]']);
    });

    it('on: both names verbatim, prompt included', async () => {
      setKeepFolderNames(true);
      const rows = await importAndRead(files());
      expect(titles(rows)).toEqual([
        { series: 'My Series (2023) [Digital]', volume: 'Vol 03 [Digital]' }
      ]);
      expect(rows[0].volume_uuid).toBe(
        generateDeterministicUUID('My Series (2023) [Digital]/Vol 03 [Digital]')
      );
      expect(reviewer.offered.map((g) => g.series)).toEqual(['My Series (2023) [Digital]']);
    });
  });

  it('on: a volume folder inside "Downloads" keeps its name under its own series, not "Downloads"', async () => {
    setKeepFolderNames(true);
    const rows = await importAndRead([picked('Downloads/Gleipnir 01/001.jpg')]);
    expect(titles(rows)).toEqual([{ series: 'Gleipnir', volume: 'Gleipnir 01' }]);
    expect(reviewer.offered.map((g) => g.series)).toEqual(['Gleipnir']);
    // The same volume as one picked loose.
    expect(rows[0].volume_uuid).toBe(generateDeterministicUUID('Gleipnir 01'));
  });

  it('on: a picked root-level folder keeps its own name under the extracted series', async () => {
    setKeepFolderNames(true);
    const rows = await importAndRead([picked('Gleipnir v01 (2023) (Digital)/001.jpg')]);
    expect(titles(rows)).toEqual([{ series: 'Gleipnir', volume: 'Gleipnir v01 (2023) (Digital)' }]);
  });

  it('sanitizes for filesystem safety only, as every import does', async () => {
    setKeepFolderNames(true);
    const rows = await importAndRead([picked('Re: Zero?/Vol 1./001.jpg')]);
    expect(titles(rows)).toEqual([{ series: 'Re： Zero？', volume: 'Vol 1․' }]);
  });

  describe('a root-level archive "Gleipnir v01 (2023) (Digital).cbz" with images at its root', () => {
    const archive = async () =>
      picked('Gleipnir v01 (2023) (Digital).cbz', await zipOf(['001.jpg', '002.jpg']));

    it('off: no parent folder, so the series is extracted from the name, then numbered', async () => {
      const rows = await importAndRead([await archive()]);
      expect(titles(rows)).toEqual([{ series: 'Gleipnir', volume: 'Gleipnir 01' }]);
    });

    it('on: a loose archive keeps its own name, under the series the review offered', async () => {
      setKeepFolderNames(true);
      const rows = await importAndRead([await archive()]);
      expect(titles(rows)).toEqual([
        { series: 'Gleipnir', volume: 'Gleipnir v01 (2023) (Digital)' }
      ]);
      expect(reviewer.offered.map((g) => g.series)).toEqual(['Gleipnir']);
    });
  });

  it('on: an archive dropped inside a series folder takes that folder as its series', async () => {
    setKeepFolderNames(true);
    const rows = await importAndRead([
      picked('My Series (2023)/Vol 03 extra.cbz', await zipOf(['001.jpg'])),
      picked('My Series (2023)/Vol 04 extra.cbz', await zipOf(['Vol 04 extra/001.jpg']))
    ]);
    // The second wraps its pages in a folder of its own name: still "Vol 04 extra".
    expect(titles(rows)).toEqual([
      { series: 'My Series (2023)', volume: 'Vol 03 extra' },
      { series: 'My Series (2023)', volume: 'Vol 04 extra' }
    ]);
    expect(new Set(rows.map((r) => r.series_uuid)).size).toBe(1);
  });

  it('on: a series archive of volume folders takes the archive as series', async () => {
    setKeepFolderNames(true);
    const rows = await importAndRead([
      picked('Series Pack [Digital].zip', await zipOf(['v01 extra/001.jpg', 'v02 extra/001.jpg']))
    ]);
    expect(titles(rows)).toEqual([
      { series: 'Series Pack [Digital]', volume: 'v01 extra' },
      { series: 'Series Pack [Digital]', volume: 'v02 extra' }
    ]);
    expect(reviewer.offered.map((g) => g.series)).toEqual(['Series Pack [Digital]']);
  });

  it('on: archives nested in a series archive take the outer archive as series', async () => {
    setKeepFolderNames(true);
    const outer = await zipOf([
      { path: 'Vol 1 (2020).cbz', data: await zipBytes(['001.jpg']) },
      { path: 'Vol 2 (2020).cbz', data: await zipBytes(['001.jpg']) }
    ]);
    const rows = await importAndRead([picked('Outer Series (Digital).zip', outer)]);
    expect(titles(rows)).toEqual([
      { series: 'Outer Series (Digital)', volume: 'Vol 1 (2020)' },
      { series: 'Outer Series (Digital)', volume: 'Vol 2 (2020)' }
    ]);
  });
});
