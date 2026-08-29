import { describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesFileVolume } from '$lib/metadata/series-file';
import type { SeriesIndexRecord } from '$lib/metadata/series-index';
import type { CloudVolumeWithProvider } from '$lib/util/sync/unified-cloud-manager';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/cloud-ocr-upgrade', () => ({ enqueueCloudOcrUpgrade: vi.fn() }));

import {
  cloudFieldsForRemovedVolume,
  generatePlaceholders,
  indexCloudFilesByPath,
  indexCoverFilesByArchiveKey,
  indexCoverSidecarsByBasePath,
  isIndexedPlaceholder
} from './placeholders';

function cloudFile(path: string, fileId = path): CloudVolumeWithProvider {
  return {
    provider: 'webdav',
    fileId,
    path,
    modifiedTime: '2026-08-17T00:00:00.000Z',
    size: 10
  } as CloudVolumeWithProvider;
}

function indexEntry(overrides: Partial<SeriesFileVolume> = {}): SeriesFileVolume {
  return {
    volume_uuid: 'real-uuid-1',
    volume_title: 'Volume 1',
    page_count: 180,
    character_count: 5000,
    mokuro_version: '0.4.11',
    ...overrides
  };
}

/** One cached `series.json`, keyed the way `seriesIndexMap` keys it. */
function indexMap(
  seriesTitle: string,
  volumes: SeriesFileVolume[]
): Map<string, SeriesIndexRecord> {
  const key = seriesTitle.trim().replace(/\s+/g, ' ').toLowerCase();
  return new Map([
    [
      key,
      {
        series_key: key,
        series_title: seriesTitle,
        file: {
          version: 2,
          series_title: seriesTitle,
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '2026-08-16T00:00:00.000Z',
          volumes
        },
        source: {
          provider: 'webdav',
          path: `${seriesTitle}/series.json`,
          size: 10,
          modifiedTime: '2026-08-17T00:00:00.000Z'
        },
        fetched_at: '2026-08-17T00:00:00.000Z'
      } as SeriesIndexRecord
    ]
  ]);
}

function localVolume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'local-uuid',
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Volume 1',
    mokuro_version: '0.4.11',
    page_count: 180,
    character_count: 5000,
    page_char_counts: [100, 250],
    ...overrides
  } as VolumeMetadata;
}

describe('generatePlaceholders', () => {
  it('never turns the series sidecar into a cloud-only volume', () => {
    // `series.json` is now a listed, cached file. It is a sidecar of the SERIES
    // FOLDER — a placeholder built from it would show up in the catalog as a
    // volume named "series.json" that can never be downloaded.
    const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
      ['One Piece', [cloudFile('One Piece/Volume 1.cbz'), cloudFile('One Piece/series.json')]]
    ]);

    const placeholders = generatePlaceholders(cloudFiles, []);

    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].volume_title).toBe('Volume 1');
  });

  it('produces nothing at all for a series folder holding only the sidecar', () => {
    const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
      ['One Piece', [cloudFile('One Piece/series.json')]]
    ]);

    expect(generatePlaceholders(cloudFiles, [])).toEqual([]);
  });

  it('decorates a placeholder with its cover sidecar, whatever the filename casing', () => {
    // The only thing that makes a cloud-only card show a picture. Keyed through
    // the shared cover index, so a folder whose `.webp` disagrees with its
    // `.cbz` about casing must still pair with it.
    const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
      [
        'One Piece',
        [cloudFile('One Piece/Volume 1.cbz', 'cbz-1'), cloudFile('ONE PIECE/VOLUME 1.webp', 'c-1')]
      ]
    ]);

    const placeholders = generatePlaceholders(cloudFiles, []);

    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].cloudThumbnailFileId).toBe('c-1');
    expect(placeholders[0].cloudThumbnailPath).toBe('ONE PIECE/VOLUME 1.webp');
  });

  it('records the listed archive size as a fact of the volume', () => {
    const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
      ['One Piece', [{ ...cloudFile('One Piece/Volume 1.cbz'), size: 193_000_000 }]]
    ]);

    expect(generatePlaceholders(cloudFiles, [])[0].archive_size).toBe(193_000_000);
  });

  it('records no archive size when the listing does not report one', () => {
    const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
      ['One Piece', [{ ...cloudFile('One Piece/Volume 1.cbz'), size: 0 }]]
    ]);

    expect(generatePlaceholders(cloudFiles, [])[0].archive_size).toBeUndefined();
  });
});

describe('generatePlaceholders with a series index', () => {
  const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
    ['One Piece', [cloudFile('One Piece/Volume 1.cbz'), cloudFile('One Piece/series.json')]]
  ]);

  it('adopts the indexed uuid, counts, version and spine width', () => {
    const placeholders = generatePlaceholders(
      cloudFiles,
      [],
      indexMap('One Piece', [indexEntry({ spine_width: 42 })])
    );

    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]).toMatchObject({
      volume_uuid: 'real-uuid-1',
      volume_title: 'Volume 1',
      page_count: 180,
      character_count: 5000,
      page_char_counts: [],
      mokuro_version: '0.4.11',
      spine_width: 42,
      isPlaceholder: true,
      cloudFileId: 'One Piece/Volume 1.cbz'
    });
  });

  it('prefers the listed archive size over the indexed one', () => {
    // The listing is this file, measured now; the index is whatever another
    // device wrote about it, possibly before a re-OCR changed the archive.
    const listed = new Map<string, CloudVolumeWithProvider[]>([
      ['One Piece', [{ ...cloudFile('One Piece/Volume 1.cbz'), size: 193_000_000 }]]
    ]);

    const placeholders = generatePlaceholders(
      listed,
      [],
      indexMap('One Piece', [indexEntry({ archive_size: 12 })])
    );

    expect(placeholders[0].archive_size).toBe(193_000_000);
  });

  it('falls back to the indexed archive size when the listing has no size', () => {
    const unsized = new Map<string, CloudVolumeWithProvider[]>([
      ['One Piece', [{ ...cloudFile('One Piece/Volume 1.cbz'), size: 0 }]]
    ]);

    const placeholders = generatePlaceholders(
      unsized,
      [],
      indexMap('One Piece', [indexEntry({ archive_size: 12 })])
    );

    expect(placeholders[0].archive_size).toBe(12);
  });

  it('matches the entry ignoring case and whitespace', () => {
    const placeholders = generatePlaceholders(
      cloudFiles,
      [],
      indexMap('  ONE   PIECE ', [indexEntry({ volume_title: 'volume  1' })])
    );

    expect(placeholders[0].volume_uuid).toBe('real-uuid-1');
  });

  it('matches the entry across unicode forms — an NFD filename is the same volume', () => {
    // A cloud filename that made the round trip through a filesystem can come
    // back decomposed while the `series.json` beside it stays composed. Compared
    // byte-wise the placeholder adopts nothing: derived uuid, zero counts, no
    // progress and no cover, for a volume the index describes perfectly.
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);

    const listed = new Map<string, CloudVolumeWithProvider[]>([
      ['One Piece', [cloudFile(`One Piece/${decomposed}.cbz`)]]
    ]);

    const placeholders = generatePlaceholders(
      listed,
      [],
      indexMap('One Piece', [indexEntry({ volume_title: composed })])
    );

    expect(placeholders[0]).toMatchObject({ volume_uuid: 'real-uuid-1', page_count: 180 });
  });

  it('leaves page_char_counts empty — the index carries totals only', () => {
    const map = indexMap('One Piece', [indexEntry()]);
    const placeholders = generatePlaceholders(cloudFiles, [], map);

    expect(placeholders[0].page_char_counts).toEqual([]);
    expect(placeholders[0].character_count).toBe(5000);
  });

  it('falls back to the deterministic uuid and zero counts without a matching entry', () => {
    const withIndex = generatePlaceholders(
      cloudFiles,
      [],
      indexMap('One Piece', [indexEntry({ volume_title: 'Volume 2' })])
    );
    const withoutIndex = generatePlaceholders(cloudFiles, []);

    expect(withIndex[0].volume_uuid).toBe(withoutIndex[0].volume_uuid);
    expect(withIndex[0]).toMatchObject({
      page_count: 0,
      character_count: 0,
      page_char_counts: [],
      mokuro_version: 'unknown'
    });
    expect(withIndex[0].spine_width).toBeUndefined();
  });

  it('skips the placeholder when a local volume already holds the indexed uuid', () => {
    // The local row is filed under a different volume title (renamed here, not
    // in the cloud), so the path/title dedupe misses it — only the uuid catches
    // this, and without it the same volume would show up twice in the catalog.
    const placeholders = generatePlaceholders(
      cloudFiles,
      [localVolume({ volume_uuid: 'real-uuid-1', volume_title: 'Vol. 1' })],
      indexMap('One Piece', [indexEntry()])
    );

    expect(placeholders).toEqual([]);
  });

  it('still dedupes by path when the index knows nothing about the volume', () => {
    const placeholders = generatePlaceholders(
      cloudFiles,
      [localVolume()],
      indexMap('One Piece', [])
    );

    expect(placeholders).toEqual([]);
  });

  it('looks the index up by folder name, not by the description series title', () => {
    // A "Series: …" description renames the series for display; the index (and
    // the cloud folder) is still keyed by the folder it lives in.
    const described = new Map<string, CloudVolumeWithProvider[]>([
      [
        'One Piece',
        [
          {
            ...cloudFile('One Piece/Volume 1.cbz'),
            description: 'Series: ワンピース'
          } as CloudVolumeWithProvider
        ]
      ]
    ]);

    const placeholders = generatePlaceholders(described, [], indexMap('One Piece', [indexEntry()]));

    expect(placeholders[0].series_title).toBe('ワンピース');
    expect(placeholders[0].volume_uuid).toBe('real-uuid-1');
  });

  it('warns once when two cloud files claim the same indexed uuid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const duplicated = new Map<string, CloudVolumeWithProvider[]>([
      [
        'One Piece',
        [
          cloudFile('One Piece/Volume 1.cbz'),
          cloudFile('One Piece/Volume 1 (copy).cbz'),
          cloudFile('One Piece/Volume 1 (dupe).cbz')
        ]
      ]
    ]);

    const placeholders = generatePlaceholders(
      duplicated,
      [],
      indexMap('One Piece', [
        indexEntry(),
        indexEntry({ volume_title: 'Volume 1 (copy)' }),
        indexEntry({ volume_title: 'Volume 1 (dupe)' })
      ])
    );

    expect(placeholders).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('never builds a placeholder for the sidecar itself, index or not', () => {
    const placeholders = generatePlaceholders(
      cloudFiles,
      [],
      indexMap('One Piece', [indexEntry()])
    );

    expect(placeholders.map((p) => p.volume_title)).toEqual(['Volume 1']);
  });
});

describe('a metadata-only row and the cloud', () => {
  const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
    ['One Piece', [cloudFile('One Piece/Volume 1.cbz', 'file-1')]]
  ]);

  it('shadows the placeholder its cloud file would have produced', () => {
    // The row is still local, so the volume must appear once — as the row that
    // holds the read history, not as a second cloud-only entry.
    const placeholders = generatePlaceholders(cloudFiles, [localVolume({ metadata_only: true })]);

    expect(placeholders).toEqual([]);
  });

  it('shadows it even when the cloud filename differs only by case', () => {
    // The cloud-field lookup folds case, so a case-sensitive shadow check here
    // would emit BOTH the row and a placeholder for the same archive.
    const placeholders = generatePlaceholders(
      new Map([['One Piece', [cloudFile('one piece/VOLUME 1.cbz', 'file-1')]]]),
      [localVolume({ metadata_only: true })]
    );

    expect(placeholders).toEqual([]);
  });

  it('shadows it when the cloud filename is decomposed and the row is composed', () => {
    // Same volume, two unicode spellings. Byte-wise the shadow check misses and
    // the catalog shows the volume twice: once as the row that holds the read
    // history, once as a cloud-only placeholder of the very same archive.
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);

    const placeholders = generatePlaceholders(
      new Map([['One Piece', [cloudFile(`One Piece/${decomposed}.cbz`, 'file-1')]]]),
      [localVolume({ metadata_only: true, volume_title: composed })]
    );

    expect(placeholders).toEqual([]);
  });

  it('gets the cloud fields the placeholder would have carried', () => {
    const index = indexCloudFilesByPath(cloudFiles);

    const fields = cloudFieldsForRemovedVolume(index, localVolume({ metadata_only: true }));

    expect(fields).toEqual({
      cloudProvider: 'webdav',
      cloudFileId: 'file-1',
      cloudModifiedTime: '2026-08-17T00:00:00.000Z',
      cloudSize: 10,
      cloudPath: 'One Piece/Volume 1.cbz'
    });
  });

  it('matches the archive case-insensitively', () => {
    const index = indexCloudFilesByPath(
      new Map([['One Piece', [cloudFile('one piece/volume 1.CBZ', 'file-1')]]])
    );

    expect(cloudFieldsForRemovedVolume(index, localVolume({ metadata_only: true }))).toMatchObject({
      cloudFileId: 'file-1'
    });
  });

  it('matches the archive across unicode forms, so the row keeps its Download', () => {
    // The row shadows the placeholder its file would have produced, so this is
    // the ONLY source of the download affordance. A byte-wise miss reads as
    // "the cloud no longer holds it" and the volume becomes undownloadable.
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);

    const index = indexCloudFilesByPath(
      new Map([['One Piece', [cloudFile(`One Piece/${decomposed}.cbz`, 'file-1')]]])
    );

    expect(
      cloudFieldsForRemovedVolume(
        index,
        localVolume({ metadata_only: true, volume_title: composed })
      )
    ).toMatchObject({ cloudFileId: 'file-1' });
  });

  it('gets nothing when the cloud no longer holds the volume', () => {
    const index = indexCloudFilesByPath(cloudFiles);

    const fields = cloudFieldsForRemovedVolume(
      index,
      localVolume({ metadata_only: true, volume_title: 'Volume 2' })
    );

    expect(fields).toBeUndefined();
  });

  it('never indexes a sidecar as a downloadable archive', () => {
    const index = indexCloudFilesByPath(
      new Map([
        [
          'One Piece',
          [cloudFile('One Piece/Volume 1.mokuro'), cloudFile('One Piece/Volume 1.webp')]
        ]
      ])
    );

    expect(index.size).toBe(0);
  });

  it('also gets the cover-sidecar fields when the listing has one, closing the gap that otherwise left a materialized row uncoverable until its series was opened', () => {
    const archiveIndex = indexCloudFilesByPath(cloudFiles);
    const coverIndex = indexCoverFilesByArchiveKey(
      new Map([
        [
          'One Piece',
          [
            cloudFile('One Piece/Volume 1.cbz', 'file-1'),
            { ...cloudFile('One Piece/Volume 1.webp', 'cover-1'), size: 512 }
          ]
        ]
      ])
    );

    const fields = cloudFieldsForRemovedVolume(
      archiveIndex,
      localVolume({ metadata_only: true }),
      coverIndex
    );

    expect(fields).toMatchObject({
      cloudThumbnailFileId: 'cover-1',
      cloudThumbnailPath: 'One Piece/Volume 1.webp',
      cloudThumbnailSize: 512,
      cloudThumbnailModifiedTime: '2026-08-17T00:00:00.000Z'
    });
  });

  it('omits the cover fields entirely when the listing has no cover sidecar for this title', () => {
    const archiveIndex = indexCloudFilesByPath(cloudFiles);
    const fields = cloudFieldsForRemovedVolume(
      archiveIndex,
      localVolume({ metadata_only: true }),
      new Map() // empty cover index
    );

    expect(fields).toBeDefined();
    expect('cloudThumbnailFileId' in fields!).toBe(false);
  });
});

describe('indexCoverFilesByArchiveKey', () => {
  it('indexes a cover sidecar by the SAME folded key cloudFieldsForRemovedVolume looks archives up by', () => {
    const index = indexCoverFilesByArchiveKey(
      new Map([['One Piece', [cloudFile('One Piece/Volume 1.webp', 'cover-1')]]])
    );

    expect(index.get('one piece/volume 1')?.fileId).toBe('cover-1');
  });

  it('folds case, whitespace and unicode form, same as every other cloud lookup here', () => {
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);

    const index = indexCoverFilesByArchiveKey(
      new Map([['One Piece', [cloudFile(`one  piece/${decomposed}.WEBP`, 'cover-1')]]])
    );

    expect(index.get(`one piece/${composed.toLowerCase()}`)?.fileId).toBe('cover-1');
  });

  it('prefers .webp over .jpg for the same volume', () => {
    const index = indexCoverFilesByArchiveKey(
      new Map([
        [
          'One Piece',
          [cloudFile('One Piece/Volume 1.jpg', 'jpg'), cloudFile('One Piece/Volume 1.webp', 'webp')]
        ]
      ])
    );

    expect(index.get('one piece/volume 1')?.fileId).toBe('webp');
  });

  it('ignores the archive itself and series.json', () => {
    const index = indexCoverFilesByArchiveKey(
      new Map([
        [
          'One Piece',
          [cloudFile('One Piece/Volume 1.cbz', 'cbz'), cloudFile('One Piece/series.json', 'sj')]
        ]
      ])
    );

    expect(index.size).toBe(0);
  });
});

describe('indexCoverSidecarsByBasePath', () => {
  const f = (path: string, fileId: string) =>
    ({ provider: 'webdav', fileId, path, modifiedTime: '', size: 1 }) as never;

  it('keys covers by lowercased base path, carrying the listing stamp too', () => {
    const index = indexCoverSidecarsByBasePath([f('Dr Stone/Volume 1.webp', 'c1')]);
    expect(index.get('dr stone/volume 1')).toEqual({
      fileId: 'c1',
      path: 'Dr Stone/Volume 1.webp',
      size: 1,
      modifiedTime: ''
    });
  });

  it('prefers .webp over .jpg for the same volume', () => {
    const index = indexCoverSidecarsByBasePath([
      f('Dr Stone/Volume 1.jpg', 'jpg'),
      f('Dr Stone/Volume 1.webp', 'webp')
    ]);
    expect(index.get('dr stone/volume 1')?.fileId).toBe('webp');

    const reversed = indexCoverSidecarsByBasePath([
      f('Dr Stone/Volume 1.webp', 'webp'),
      f('Dr Stone/Volume 1.jpg', 'jpg')
    ]);
    expect(reversed.get('dr stone/volume 1')?.fileId).toBe('webp');
  });

  it('ignores archives and the series sidecar', () => {
    const index = indexCoverSidecarsByBasePath([
      f('Dr Stone/Volume 1.cbz', 'a'),
      f('Dr Stone/series.json', 'b')
    ]);
    expect(index.size).toBe(0);
  });
});

describe('isIndexedPlaceholder', () => {
  const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
    ['One Piece', [cloudFile('One Piece/Volume 1.cbz')]]
  ]);

  it('is true for a placeholder that adopted an index entry', () => {
    const [adopted] = generatePlaceholders(cloudFiles, [], indexMap('One Piece', [indexEntry()]));
    expect(isIndexedPlaceholder(adopted)).toBe(true);
  });

  it('is true for an indexed image-only volume, counts or not', () => {
    const [adopted] = generatePlaceholders(
      cloudFiles,
      [],
      indexMap('One Piece', [indexEntry({ mokuro_version: '', page_count: 0, character_count: 0 })])
    );
    expect(isIndexedPlaceholder(adopted)).toBe(true);
  });

  it('is marked at construction, not sniffed from the values it happened to get', () => {
    // An index entry that says nothing useful is still an index entry: this
    // volume's uuid came from the file another device wrote, which is the whole
    // reason it can be drawn as a real row.
    const [adopted] = generatePlaceholders(
      cloudFiles,
      [],
      indexMap('One Piece', [
        indexEntry({ mokuro_version: 'unknown', page_count: 0, character_count: 0 })
      ])
    );
    expect(adopted.indexed).toBe(true);
    expect(isIndexedPlaceholder(adopted)).toBe(true);
  });

  it('still recognises a placeholder built before the flag existed', () => {
    const legacy = {
      ...localVolume({ isPlaceholder: true, indexed: undefined } as never),
      indexed: undefined
    } as VolumeMetadata;
    expect(isIndexedPlaceholder(legacy)).toBe(true);
  });

  it('is false for a bare-share placeholder with nothing but a path', () => {
    const [bare] = generatePlaceholders(cloudFiles, []);
    expect(isIndexedPlaceholder(bare)).toBe(false);
  });

  it('is false for anything that is not a placeholder', () => {
    expect(isIndexedPlaceholder(localVolume({ metadata_only: true } as never))).toBe(false);
    expect(isIndexedPlaceholder(localVolume())).toBe(false);
  });
});

/**
 * COVER BYTES MUST NOT COME BACK.
 *
 * `generatePlaceholders` used to take the account's cached-cover Map and stamp
 * `thumbnail`/`thumbnail_width`/`thumbnail_height` onto every placeholder that
 * had one. That is what made a single cover landing regenerate ~4,347
 * placeholder objects and re-render 1,027 mounted cards (a measured 1,784 ms
 * long task). A placeholder now carries only the sidecar POINTER; the bytes
 * are resolved per card by path (`cover-resolver.ts`).
 */
describe('generatePlaceholders carries cover pointers, never cover bytes', () => {
  const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
    ['One Piece', [cloudFile('One Piece/Volume 1.cbz'), cloudFile('One Piece/Volume 1.webp')]]
  ]);

  it('decorates the cover sidecar pointer and no blob', () => {
    const [placeholder] = generatePlaceholders(cloudFiles, []);

    expect(placeholder.cloudThumbnailPath).toBe('One Piece/Volume 1.webp');
    expect(placeholder.cloudThumbnailFileId).toBe('One Piece/Volume 1.webp');
    expect(placeholder.thumbnail).toBeUndefined();
    expect(placeholder.thumbnail_width).toBeUndefined();
    expect(placeholder.thumbnail_height).toBeUndefined();
  });

  it('takes no cover argument at all', () => {
    // The signature is the contract: there is no fourth parameter to hand a
    // cover Map to, so nothing about `cloud_covers` can reach this pass.
    expect(generatePlaceholders.length).toBe(3);
  });
});

describe('a sidecar-less archive is never labeled image-only', () => {
  const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
    ['One Piece', [cloudFile('One Piece/Volume 1.cbz')]]
  ]);

  it("surfaces a no-metadata entry's empty version as 'unknown' — the mokuro is probably embedded", () => {
    // The exact shape `buildNoMetadataEntry` publishes for an archive with no
    // `.mokuro` sidecar. A missing sidecar proves nothing about the volume —
    // legacy backups EMBED the mokuro in the .cbz — so the placeholder must
    // not inherit `''`, the claim the catalog's "Image Only" badge keys on.
    const [adopted] = generatePlaceholders(
      cloudFiles,
      [],
      indexMap('One Piece', [indexEntry({ mokuro_version: '', page_count: 0, character_count: 0 })])
    );
    expect(adopted.mokuro_version).toBe('unknown');
    // Guard against the vacuous pass: 'unknown' is also the BARE fallback, so
    // prove the entry really was adopted (indexed is only set from an entry).
    expect(adopted.indexed).toBe(true);
    expect(adopted.volume_uuid).toBe('real-uuid-1');
  });

  it('keeps a MEASURED image-only claim — a publisher counted real pages and found no mokuro', () => {
    const [adopted] = generatePlaceholders(
      cloudFiles,
      [],
      indexMap('One Piece', [
        indexEntry({ mokuro_version: '', page_count: 180, character_count: 0 })
      ])
    );
    expect(adopted.mokuro_version).toBe('');
    expect(adopted.page_count).toBe(180);
  });

  it('keeps a real mokuro version untouched', () => {
    const [adopted] = generatePlaceholders(cloudFiles, [], indexMap('One Piece', [indexEntry()]));
    expect(adopted.mokuro_version).toBe('0.4.11');
  });
});

describe('a cover sidecar without a mokuro IS a genuine image-only signal', () => {
  const cloudFiles = new Map<string, CloudVolumeWithProvider[]>([
    ['One Piece', [cloudFile('One Piece/Volume 1.cbz')]]
  ]);

  it("keeps '' when the entry's cover stamps prove a modern backup wrote sidecars without a mokuro", () => {
    // Cover stamps ride the entry from the listing: a backup that wrote the
    // cover would have written the mokuro too had OCR existed.
    const [adopted] = generatePlaceholders(
      cloudFiles,
      [],
      indexMap('One Piece', [
        indexEntry({
          mokuro_version: '',
          page_count: 0,
          character_count: 0,
          cover_size: 12345,
          cover_modified: 1_700_000_000
        })
      ])
    );
    expect(adopted.indexed).toBe(true);
    expect(adopted.mokuro_version).toBe('');
  });
});
