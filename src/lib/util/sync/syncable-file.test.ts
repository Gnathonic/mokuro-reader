import { describe, it, expect } from 'vitest';
import {
  isBestEffortMetadataPath,
  isSyncableFile,
  isCbzFile,
  isSidecarFile,
  isRootConfigFile,
  splitLayerSidecarName,
  classifyMokuroSidecar,
  layerSidecarName,
  cbzStemsOf,
  QUEUE_FILE_NAME,
  BUNKO_MARKER_NAME,
  isBunkoControlFile,
  dedupKeepsEveryCopy,
  foldStem,
  isReservedLayerSidecarPath,
  layerOwnerArchive,
  miscasedLayerStem
} from './syncable-file';

describe('syncable-file', () => {
  it('accepts cbz, mokuro, mokuro.gz anywhere in the tree', () => {
    expect(isSyncableFile('Series/Vol 1.cbz')).toBe(true);
    expect(isSyncableFile('Series/Vol 1.mokuro')).toBe(true);
    expect(isSyncableFile('Series/Vol 1.mokuro.gz')).toBe(true);
  });

  it('accepts webp AND jpg/jpeg sidecar thumbnails (parity with mature providers)', () => {
    expect(isSyncableFile('Series/Vol 1.webp')).toBe(true);
    expect(isSyncableFile('Series/Vol 1.jpg')).toBe(true);
    expect(isSyncableFile('Series/Vol 1.JPEG')).toBe(true);
  });

  it('accepts the per-series sidecar <Series>/series.json', () => {
    expect(isSyncableFile('Series/series.json')).toBe(true);
    expect(isSyncableFile('Series/SERIES.JSON')).toBe(true);
    expect(isSidecarFile('series.json')).toBe(true);
    // It is a SERIES sidecar, not a per-account root config.
    expect(isRootConfigFile('series.json')).toBe(false);
  });

  it('accepts the root config files', () => {
    expect(isSyncableFile('volume-data.json')).toBe(true);
    expect(isSyncableFile('profiles.json')).toBe(true);
    expect(isSyncableFile('goals.json')).toBe(true);
    expect(isSyncableFile('positions.json')).toBe(true);
  });

  it('no longer treats series-metadata.json as a root config file', () => {
    // Retired 2026-08-23: facts ride series.json, reading state rides
    // volume-data.json. A stale copy in an existing cloud folder is inert junk —
    // never listed, never downloaded, never written.
    expect(isRootConfigFile('series-metadata.json')).toBe(false);
    expect(isRootConfigFile('SERIES-METADATA.JSON')).toBe(false);
    expect(isSyncableFile('series-metadata.json')).toBe(false);
  });

  it('ignores libraries.json left behind by the removed libraries feature', () => {
    expect(isSyncableFile('libraries.json')).toBe(false);
    expect(isRootConfigFile('libraries.json')).toBe(false);
  });

  it('rejects everything else', () => {
    expect(isSyncableFile('Series/notes.txt')).toBe(false);
    expect(isSyncableFile('Series/random.json')).toBe(false);
    expect(isSyncableFile('desktop.ini')).toBe(false);
  });

  it('does not accept a .json that merely ENDS with series.json', () => {
    // Basename equality only — `my-series.json` is somebody else's file.
    expect(isSidecarFile('my-series.json')).toBe(false);
    expect(isSyncableFile('Series/my-series.json')).toBe(false);
  });

  it('is case-insensitive and uses the basename only', () => {
    expect(isSyncableFile('Series/VOL.CBZ')).toBe(true);
    expect(isSyncableFile('a/b/c/PROFILES.JSON')).toBe(true);
  });

  it('exposes category predicates for providers that bucket by type', () => {
    expect(isCbzFile('v.cbz')).toBe(true);
    expect(isSidecarFile('v.mokuro')).toBe(true);
    expect(isSidecarFile('v.jpeg')).toBe(true);
    expect(isSidecarFile('v.cbz')).toBe(false);
    expect(isRootConfigFile('profiles.json')).toBe(true);
    expect(isRootConfigFile('goals.json')).toBe(true);
    expect(isRootConfigFile('GOALS.JSON')).toBe(true);
    expect(isRootConfigFile('v.cbz')).toBe(false);
  });
});

describe('catalog.json', () => {
  it('is a root config file so every provider lists it', () => {
    expect(isRootConfigFile('catalog.json')).toBe(true);
    expect(isRootConfigFile('CATALOG.JSON')).toBe(true);
    expect(isSyncableFile('catalog.json')).toBe(true);
  });
});

describe('isBestEffortMetadataPath', () => {
  it('covers the two compiled metadata files', () => {
    expect(isBestEffortMetadataPath('catalog.json')).toBe(true);
    expect(isBestEffortMetadataPath('/catalog.json')).toBe(true);
    expect(isBestEffortMetadataPath('Dr Stone/series.json')).toBe(true);
    expect(isBestEffortMetadataPath('series.json')).toBe(true);
  });

  it('does NOT cover progress, profiles or archives', () => {
    expect(isBestEffortMetadataPath('volume-data.json')).toBe(false);
    expect(isBestEffortMetadataPath('profiles.json')).toBe(false);
    // goals.json is the USER'S OWN state. No server compiles it, so there is
    // nothing for a server to reject by design — a failed write is a real
    // failure and must surface, exactly like a failed progress write.
    expect(isBestEffortMetadataPath('goals.json')).toBe(false);
    // positions.json is the user's own state too.
    expect(isBestEffortMetadataPath('positions.json')).toBe(false);
    expect(isBestEffortMetadataPath('Dr Stone/Volume 1.cbz')).toBe(false);
    expect(isBestEffortMetadataPath('Dr Stone/catalog.json')).toBe(false);
  });
});

describe('bunko control files', () => {
  it('names exactly the queue and the marker, case-sensitively', () => {
    expect(isBunkoControlFile('.mokuro-bunko.json')).toBe(true);
    expect(isBunkoControlFile('.mokuro-queue.json')).toBe(true);
    expect(isBunkoControlFile('.MOKURO-BUNKO.JSON')).toBe(false);
    expect(isBunkoControlFile('mokuro-bunko.json')).toBe(false);
    expect(isBunkoControlFile('.mokuro-queue.json.bak')).toBe(false);
  });

  it('are never listed as syncable', () => {
    expect(isSyncableFile('.mokuro-bunko.json')).toBe(false);
    expect(isSyncableFile('.mokuro-queue.json')).toBe(false);
  });
});

describe('dedupKeepsEveryCopy', () => {
  it('covers the files sync folds across copies and the bunko control files', () => {
    expect(dedupKeepsEveryCopy('volume-data.json')).toBe(true);
    expect(dedupKeepsEveryCopy('Goals.json')).toBe(true);
    expect(dedupKeepsEveryCopy('positions.json')).toBe(true);
    expect(dedupKeepsEveryCopy('.mokuro-bunko.json')).toBe(true);
    expect(dedupKeepsEveryCopy('.mokuro-queue.json')).toBe(true);
  });

  it('leaves every other file to the newer-copy rule', () => {
    expect(dedupKeepsEveryCopy('profiles.json')).toBe(false);
    expect(dedupKeepsEveryCopy('series.json')).toBe(false);
    expect(dedupKeepsEveryCopy('Vol 1.mokuro')).toBe(false);
    expect(dedupKeepsEveryCopy('.MOKURO-BUNKO.JSON')).toBe(false);
  });
});

/**
 * Retirement pin. `series-metadata.json` and its merge machinery were deleted on
 * 2026-08-23; the risk is not that somebody restores them deliberately but that
 * a revert, a merge or a copy-pasted helper quietly drags one back and the app
 * starts writing a root file nothing reads. A source scan fails loudly for that,
 * where a unit test of the surviving code never would.
 */
describe('series-metadata.json stays retired', () => {
  // Split so this file's own scanner does not match itself in a future copy.
  const DEAD_FILE = ['series-metadata', 'json'].join('.');
  const DEAD_SYMBOLS = [
    'syncSeriesMetadata',
    'mergeSeriesMetadata',
    'sanitizeCloudSeriesMetadata',
    'sanitizeTitlePreference',
    'sanitizeVolumeOffsets',
    '$lib/metadata/merge'
  ];

  /**
   * The only two files allowed to name the dead file: the allowlist that
   * deliberately explains why it is absent, and this pin.
   */
  const NAME_ALLOWED = new Set([
    'src/lib/util/sync/syncable-file.ts',
    'src/lib/util/sync/syncable-file.test.ts'
  ]);

  const SELF = 'src/lib/util/sync/syncable-file.test.ts';

  // Vite reads every source file as text at transform time — no node:fs, so this
  // runs the same way under vitest as it would in any browser-target runner.
  const files = Object.entries(
    import.meta.glob('/src/**/*.{ts,svelte}', {
      query: '?raw',
      import: 'default',
      eager: true
    }) as Record<string, string>
  ).map(([path, text]) => ({ path: path.replace(/^\//, ''), text }));

  it('finds source files to scan (guards against a broken scanner)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no source file naming the retired root file', () => {
    const offenders = files
      .filter(({ path }) => !NAME_ALLOWED.has(path))
      .filter(({ text }) => text.includes(DEAD_FILE))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it.each(DEAD_SYMBOLS)('has no source file referencing %s', (symbol) => {
    const offenders = files
      .filter(({ path }) => path !== SELF)
      .filter(({ text }) => text.includes(symbol))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  describe('layer sidecars', () => {
    const stems = cbzStemsOf(['Vol 1.cbz', 'Vol 1.5.cbz', 'Other.webp']);

    it('classifies by archive presence: primary, layer, orphan', () => {
      expect(classifyMokuroSidecar('Vol 1.mokuro', stems)).toEqual({
        kind: 'primary',
        stem: 'Vol 1',
        gz: false
      });
      expect(classifyMokuroSidecar('Vol 1.paddle-manga.mokuro', stems)).toEqual({
        kind: 'layer',
        stem: 'Vol 1',
        layerId: 'paddle-manga',
        gz: false
      });
      expect(classifyMokuroSidecar('Vol 1.tr-en.mokuro.gz', stems)).toEqual({
        kind: 'layer',
        stem: 'Vol 1',
        layerId: 'tr-en',
        gz: true
      });
      expect(classifyMokuroSidecar('Vol 9.gcv.mokuro', stems)).toEqual({ kind: 'orphan' });
      expect(classifyMokuroSidecar('Vol 9.mokuro', stems)).toEqual({ kind: 'orphan' });
      expect(classifyMokuroSidecar('Vol 1.cbz', stems)).toEqual({ kind: 'orphan' });
    });

    it('a dotted title is the primary of its own archive, and a layer only without one', () => {
      expect(classifyMokuroSidecar('Vol 1.5.mokuro', stems)).toEqual({
        kind: 'primary',
        stem: 'Vol 1.5',
        gz: false
      });
      expect(classifyMokuroSidecar('Vol 1.5.mokuro', cbzStemsOf(['Vol 1.cbz']))).toEqual({
        kind: 'layer',
        stem: 'Vol 1',
        layerId: '5',
        gz: false
      });
    });

    it('an invalid id is never a layer', () => {
      expect(classifyMokuroSidecar('Vol 1.Bad_Id.mokuro', stems)).toEqual({ kind: 'orphan' });
      expect(splitLayerSidecarName('Vol 1.Bad_Id.mokuro')).toBeNull();
      expect(splitLayerSidecarName('Vol 1.mokuro')).toBeNull();
      expect(splitLayerSidecarName('.gcv.mokuro')).toBeNull();
    });

    it('splits a standalone name and round-trips the export name', () => {
      expect(splitLayerSidecarName('Vol 1.gcv-2.mokuro.gz')).toEqual({
        stem: 'Vol 1',
        layerId: 'gcv-2',
        gz: true
      });
      const name = layerSidecarName('Vol 1', 'gcv');
      expect(name).toBe('Vol 1.gcv.mokuro');
      expect(splitLayerSidecarName(name)).toEqual({ stem: 'Vol 1', layerId: 'gcv', gz: false });
      // The id is matched as written (rule v1 #5): an upper-case id is no id.
      expect(splitLayerSidecarName('Vol 1.GCV.mokuro')).toBeNull();
    });

    it('names the stem of a layer file whose id is only miscased (an orphan, not a primary)', () => {
      expect(miscasedLayerStem('Vol 1.GCV.mokuro')).toBe('Vol 1');
      expect(miscasedLayerStem('Vol 1.Tr-En.mokuro.gz')).toBe('Vol 1');
      // A valid id is a layer, not a miscased one; an id invalid in any case is neither.
      expect(miscasedLayerStem('Vol 1.gcv.mokuro')).toBeNull();
      expect(miscasedLayerStem('Vol 1.Bad_Id.mokuro')).toBeNull();
      expect(miscasedLayerStem('Vol. 1.mokuro')).toBeNull();
      expect(miscasedLayerStem('Vol 1.mokuro')).toBeNull();
      expect(miscasedLayerStem('Vol 1.GCV.cbz')).toBeNull();
    });
  });

  // Sidecar names rule v1 — the same rule as mokuro-bunko's
  // `bunko_core::sidecar_names`. These are vectors of its contract file
  // (`interop/contract/sidecar-names.json`), encoded by hand so they run
  // without a Bunko checkout; `$lib/interop/sidecar-names.contract.test.ts`
  // runs the file itself.
  describe('sidecar names rule v1', () => {
    const NFC = 'V\u00f3l 1'; // Vól 1, composed
    const NFD = 'Vo\u0301l 1'; // Vól 1, decomposed
    const cases: Array<{
      name: string;
      folder: string[];
      expect: { kind: 'primary' | 'layer' | 'orphan'; stem?: string; layer?: string; gz?: boolean };
    }> = [
      // 1. suffixes match regardless of ASCII case
      {
        name: 'Vol 1.MOKURO',
        folder: ['Vol 1.cbz'],
        expect: { kind: 'primary', stem: 'Vol 1', gz: false }
      },
      {
        name: 'Vol 1.MOKURO.GZ',
        folder: ['Vol 1.cbz'],
        expect: { kind: 'primary', stem: 'Vol 1', gz: true }
      },
      {
        name: 'Vol 1.mokuro',
        folder: ['Vol 1.CBZ'],
        expect: { kind: 'primary', stem: 'Vol 1', gz: false }
      },
      {
        name: 'Vol 1.edit.MOKURO',
        folder: ['Vol 1.cbz'],
        expect: { kind: 'layer', stem: 'Vol 1', layer: 'edit', gz: false }
      },
      {
        name: 'Vol 1.gcv.mokuro.gz',
        folder: ['Vol 1.cbz'],
        expect: { kind: 'layer', stem: 'Vol 1', layer: 'gcv', gz: true }
      },
      // 2. only .cbz defines a volume stem
      { name: 'Vol 1.mokuro', folder: ['Vol 1.cbr'], expect: { kind: 'orphan' } },
      {
        name: 'Vol 1.5.mokuro',
        folder: ['Vol 1.5.zip', 'Vol 1.cbz'],
        expect: { kind: 'layer', stem: 'Vol 1', layer: '5', gz: false }
      },
      // 3. stems fold as NFC then lowercase
      {
        name: `${NFD}.mokuro`,
        folder: [`${NFC}.cbz`],
        expect: { kind: 'primary', stem: NFD, gz: false }
      },
      {
        name: `${NFC}.mokuro`,
        folder: [`${NFD}.cbz`],
        expect: { kind: 'primary', stem: NFC, gz: false }
      },
      {
        name: 'vol 1.gcv.mokuro',
        folder: ['Vol 1.cbz'],
        expect: { kind: 'layer', stem: 'vol 1', layer: 'gcv', gz: false }
      },
      // 4. a primary wins over a layer reading of the same name
      {
        name: 'Vol 1.5.mokuro',
        folder: ['Vol 1.cbz', 'Vol 1.5.cbz'],
        expect: { kind: 'primary', stem: 'Vol 1.5', gz: false }
      },
      {
        name: 'Vol 01.5.mokuro',
        folder: ['Vol 01.cbz'],
        expect: { kind: 'layer', stem: 'Vol 01', layer: '5', gz: false }
      },
      // 5. the id is matched exactly as written; all-digit ids are allowed
      { name: 'Vol 1.Upper.mokuro', folder: ['Vol 1.cbz'], expect: { kind: 'orphan' } },
      { name: 'Vol 1.EDIT.mokuro', folder: ['Vol 1.cbz'], expect: { kind: 'orphan' } },
      {
        name: 'Vol 1.2024.mokuro',
        folder: ['Vol 1.cbz'],
        expect: { kind: 'layer', stem: 'Vol 1', layer: '2024', gz: false }
      },
      {
        name: `Vol 1.${'a'.repeat(32)}.mokuro`,
        folder: ['Vol 1.cbz'],
        expect: { kind: 'layer', stem: 'Vol 1', layer: 'a'.repeat(32), gz: false }
      },
      { name: `Vol 1.${'a'.repeat(33)}.mokuro`, folder: ['Vol 1.cbz'], expect: { kind: 'orphan' } },
      { name: 'Vol 1.gcv.mokuro', folder: ['Vol 2.cbz'], expect: { kind: 'orphan' } },
      // A case-variant archive pair: both spellings are volumes of their own.
      {
        name: 'vol 01.mokuro',
        folder: ['Vol 01.cbz', 'vol 01.cbz'],
        expect: { kind: 'primary', stem: 'vol 01', gz: false }
      },
      {
        name: 'vol 01.hayai.mokuro',
        folder: ['Vol 01.cbz', 'vol 01.cbz'],
        expect: { kind: 'layer', stem: 'vol 01', layer: 'hayai', gz: false }
      }
    ];

    it.each(cases)('$name beside $folder', ({ name, folder, expect: want }) => {
      const got = classifyMokuroSidecar(name, cbzStemsOf(folder));
      expect(got.kind).toBe(want.kind);
      if (got.kind === 'orphan') return;
      expect(got.stem).toBe(want.stem);
      expect(got.gz).toBe(want.gz);
      if (got.kind === 'layer') expect(got.layerId).toBe(want.layer);
    });

    it('layerOwnerArchive: the exactly-spelled archive, else the naturalSort-first of those that fold alike — whatever the listing order', () => {
      const archives = ['Vol 3', 'vol 3', 'VOL 3', 'Vol 4'];
      expect(layerOwnerArchive('vol 3', archives)).toBe('vol 3');
      expect(layerOwnerArchive('Vol 3', archives)).toBe('Vol 3');
      // Spelled like NEITHER archive: one owner, independent of order.
      expect(layerOwnerArchive('vOl 3', archives)).toBe('VOL 3');
      expect(layerOwnerArchive('vOl 3', [...archives].reverse())).toBe('VOL 3');
      expect(layerOwnerArchive(NFD, [NFC])).toBe(NFC);
      expect(layerOwnerArchive('Vol 5', archives)).toBeUndefined();
    });

    it('foldStem is NFC then Unicode lowercase', () => {
      expect(foldStem(NFD)).toBe(foldStem(NFC));
      expect(foldStem(NFD)).toBe('v\u00f3l 1');
      expect(foldStem('\u00c4RA')).toBe('\u00e4ra');
      expect([...cbzStemsOf([`${NFD}.cbz`, 'Vol 1.cbr'])]).toEqual(['v\u00f3l 1']);
    });
  });
});

describe('Bunko control files', () => {
  it('names the queue file and the marker', () => {
    expect(QUEUE_FILE_NAME).toBe('.mokuro-queue.json');
    expect(BUNKO_MARKER_NAME).toBe('.mokuro-bunko.json');
    expect(isBunkoControlFile('.mokuro-queue.json')).toBe(true);
    expect(isBunkoControlFile('.mokuro-bunko.json')).toBe(true);
    expect(isBunkoControlFile('mokuro-queue.json')).toBe(false);
    expect(isBunkoControlFile('.bunko.json')).toBe(false);
  });

  it('keeps both control files out of every listing category', () => {
    for (const name of [QUEUE_FILE_NAME, BUNKO_MARKER_NAME]) {
      expect(isSyncableFile(name)).toBe(false);
      expect(isSyncableFile(`mokuro-reader/${name}`)).toBe(false);
      expect(isSyncableFile(`Series/${name}`)).toBe(false);
      expect(isSidecarFile(name)).toBe(false);
      expect(isRootConfigFile(name)).toBe(false);
      expect(isCbzFile(name)).toBe(false);
      expect(isBestEffortMetadataPath(name)).toBe(false);
      expect(classifyMokuroSidecar(name, new Set(['.mokuro-queue']))).toEqual({ kind: 'orphan' });
    }
  });
  // Folder dedup must never trash a copy: sync folds every copy of the merged
  // root files into one, and Bunko reads every copy of its control files.
  it('dedup keeps every copy of the merged root files and both control files', () => {
    for (const name of [
      'volume-data.json',
      'goals.json',
      'positions.json',
      QUEUE_FILE_NAME,
      BUNKO_MARKER_NAME
    ]) {
      expect(dedupKeepsEveryCopy(name)).toBe(true);
    }
    expect(dedupKeepsEveryCopy('Vol.mokuro')).toBe(false);
    expect(dedupKeepsEveryCopy('profiles.json')).toBe(false);
  });
});

describe('history files', () => {
  const DEV = '0b6f1c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';
  it('lists history segments and device facts by full path', () => {
    expect(isSyncableFile(`history/${DEV}/2026-10.events`)).toBe(true);
    expect(isSyncableFile(`history/${DEV}/device.json`)).toBe(true);
  });
  it('does not list a device.json or .events anywhere else', () => {
    expect(isSyncableFile('device.json')).toBe(false);
    expect(isSyncableFile('Series/device.json')).toBe(false);
    expect(isSyncableFile('Series/2026-10.events')).toBe(false);
  });
  it('treats history writes as best-effort', () => {
    expect(isBestEffortMetadataPath(`history/${DEV}/2026-10.events`)).toBe(true);
    expect(isBestEffortMetadataPath('volume-data.json')).toBe(false);
  });
});

describe('isReservedLayerSidecarPath', () => {
  it('names a layer file whose id is reserved, in any folder, plain or gz', () => {
    expect(isReservedLayerSidecarPath('S/Vol 1.edit.mokuro')).toBe(true);
    expect(isReservedLayerSidecarPath('S/Vol 1.curated.mokuro.gz')).toBe(true);
    expect(isReservedLayerSidecarPath('S/Vol 1.curated-2.mokuro')).toBe(true);
    expect(isReservedLayerSidecarPath('Vol 1.tr-en.mokuro')).toBe(true);
  });

  it('nothing else', () => {
    for (const path of [
      'S/Vol 1.mokuro',
      'S/Vol 1.fix.mokuro',
      // Ordinary hand-made ids: bunko no longer writes or reserves them.
      'S/Vol 1.pre-upgrade.mokuro',
      'S/Vol 1.pre-upgrade-2.mokuro',
      'S/Vol 1.previous-ocr.mokuro',
      'S/Vol 1.EDIT.mokuro',
      'S/Vol 1.edit.cbz',
      'S/series.json',
      'S/edit.mokuro'
    ]) {
      expect(isReservedLayerSidecarPath(path), path).toBe(false);
    }
  });
});
