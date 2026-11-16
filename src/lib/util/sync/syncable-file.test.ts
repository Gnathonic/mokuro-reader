import { describe, it, expect } from 'vitest';
import vendored from '#lib/interop/contract/sidecar-names.json';
import { compareCodePoints, foldName } from '#lib/util/names/fold.js';
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
  SERIES_QUEUE_FILE_NAME,
  isBunkoControlFile,
  dedupKeepsEveryCopy,
  isSeriesQueueFile,
  isReservedLayerSidecarPath,
  layerOwnerArchive,
  cbzStemOf,
  FolderNames,
  sweepOwnerArchive,
  SIDECAR_RULE,
  type MokuroSidecarClass
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
  it('names the queue and the marker, in any spelling the fold joins (R8)', () => {
    expect(isBunkoControlFile('.mokuro-bunko.json')).toBe(true);
    expect(isBunkoControlFile('.mokuro-queue.json')).toBe(true);
    // One entry with the marker on every host and store.
    expect(isBunkoControlFile('.MOKURO-BUNKO.JSON')).toBe(true);
    expect(isBunkoControlFile('.mokuro-bunko\u{200b}.json')).toBe(true);
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
    '#lib/metadata/merge'
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
  });

  it('reads the id on its fold and reports it folded (rule 2, R5)', () => {
    // As Mokuro Reader 1.10.0 lowercased it, and as Bunko reads it.
    expect(splitLayerSidecarName('Vol 1.GCV.mokuro')).toEqual({
      stem: 'Vol 1',
      layerId: 'gcv',
      gz: false
    });
    expect(splitLayerSidecarName('Vol 1.Tr-En.MOKURO.GZ')).toEqual({
      stem: 'Vol 1',
      layerId: 'tr-en',
      gz: true
    });
    // A zero width space is no part of the id; the stem is cut at the same dot.
    expect(splitLayerSidecarName('V\u{200b}ol.ed\u{200b}it.mokuro')).toEqual({
      stem: 'V\u{200b}ol',
      layerId: 'edit',
      gz: false
    });
    // I with dot above folds to i + U+0307: no id.
    expect(splitLayerSidecarName('V.ED\u{130}T.mokuro')).toBeNull();
  });

  it('reads suffixes on the fold (R2)', () => {
    expect(isCbzFile('V.cb\u{200b}z')).toBe(true);
    expect(isCbzFile('V.CBZ\u{200b}')).toBe(true);
    expect(cbzStemOf('V.cb\u{200b}z')).toBe('V');
    expect(cbzStemOf('V.mokuro')).toBeNull();
    expect(isSidecarFile('V.mo\u{212a}uro')).toBe(true);
    expect(classifyMokuroSidecar('V.mo\u{212a}uro', cbzStemsOf(['V.cbz']))).toEqual({
      kind: 'primary',
      stem: 'V',
      gz: false
    });
    expect([...cbzStemsOf(['Vo\u{301}l 1.cbz', 'Vol 1.cbr', 'Stra\u{df}e.CBZ'])]).toEqual([
      'v\u{f3}l 1',
      'strasse'
    ]);
  });
});

// Sidecar names rule 2 as mokuro-bunko states it (`interop/contract/
// sidecar-names.json`, vendored byte for byte in `$lib/interop/contract/`;
// `$lib/interop/sidecar-names.contract.test.ts` runs Bunko's own copy with a
// checkout). Bunko's `bunko_core::sidecar_names` tests run the same file.
describe('sidecar names rule 2 (the vendored contract)', () => {
  type Expect =
    | { kind: 'primary'; stem: string; gz: boolean }
    | { kind: 'layer'; stem: string; layer: string; gz: boolean }
    | { kind: 'orphan' };
  const rule = vendored as unknown as {
    rule: number;
    classify: Array<{ name: string; folder: string[]; expect: Expect; why: string }>;
    sweep: Array<{ archive: string; folder: string[]; expect: string[]; why: string }>;
    owner: Array<{
      name: string;
      folder: string[];
      display: string | null;
      sweep: string | null;
      why: string;
    }>;
    equivalent: Array<{ crafted: string[]; canonical: string[]; why: string }>;
  };
  const show = (s: string) =>
    JSON.stringify(s).replace(/[^\x20-\x7e]/g, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);

  it('is rule 2', () => {
    expect(rule.rule).toBe(SIDECAR_RULE);
  });

  it.each(rule.classify.map((v) => [show(v.name), v] as const))(
    'classify %s',
    (_, { name, folder, expect: want, why }) => {
      const got = classifyMokuroSidecar(name, cbzStemsOf(folder));
      if (want.kind === 'orphan') {
        expect(got, why).toEqual({ kind: 'orphan' });
      } else if (want.kind === 'primary') {
        expect(got, why).toEqual({ kind: 'primary', stem: want.stem, gz: want.gz });
      } else {
        expect(got, why).toEqual({
          kind: 'layer',
          stem: want.stem,
          layerId: want.layer,
          gz: want.gz
        });
      }
    }
  );

  it.each(rule.sweep.map((v) => [show(v.archive), v] as const))(
    'deleting %s sweeps',
    (_, { archive, folder, expect: want, why }) => {
      const got = new FolderNames(folder).sweepSet(archive);
      expect([...got].sort(compareCodePoints), why).toEqual([...want].sort(compareCodePoints));
    }
  );

  it.each(rule.owner.map((v) => [show(v.name), v] as const))(
    '%s is shown with and swept by its R6 archive',
    (_, { name, folder, display, sweep, why }) => {
      const names = new FolderNames(folder);
      expect(names.displayArchive(name) ?? null, why).toBe(display);
      expect(names.sweepArchive(name) ?? null, why).toBe(sweep);
      // The stem-level helpers every call site uses agree.
      const archives = names.archiveStems();
      const read = classifyMokuroSidecar(name, names.stems);
      const stem = read.kind === 'orphan' ? (/^(.*)\.[^.]+$/.exec(name)?.[1] ?? name) : read.stem;
      const shown = display === null ? undefined : (cbzStemOf(display) ?? undefined);
      if (read.kind !== 'orphan') expect(layerOwnerArchive(stem, archives), why).toBe(shown);
      const swept = sweep === null ? undefined : (cbzStemOf(sweep) ?? undefined);
      expect(sweepOwnerArchive(name, folder), why).toBe(swept);
    }
  );

  it.each(rule.equivalent.map((v) => [v.why, v] as const))(
    'a crafted listing classifies as its canonical twin (%s)',
    (_, { crafted, canonical, why }) => {
      expect(crafted.length).toBe(canonical.length);
      const craftedStems = cbzStemsOf(crafted);
      const canonicalStems = cbzStemsOf(canonical);
      expect([...craftedStems].sort(), why).toEqual([...canonicalStems].sort());
      const folded = (c: MokuroSidecarClass) =>
        c.kind === 'orphan'
          ? c
          : c.kind === 'primary'
            ? { ...c, stem: foldName(c.stem) }
            : { ...c, stem: foldName(c.stem) };
      crafted.forEach((name, i) => {
        expect(foldName(name), why).toBe(foldName(canonical[i]));
        expect(folded(classifyMokuroSidecar(name, craftedStems)), `${why}: ${show(name)}`).toEqual(
          folded(classifyMokuroSidecar(canonical[i], canonicalStems))
        );
      });
    }
  );

  it('layerOwnerArchive: exact, else the only one, else the code-point-smallest', () => {
    const archives = ['Vol 3', 'vol 3', 'VOL 3', 'Vol 4'];
    expect(layerOwnerArchive('vol 3', archives)).toBe('vol 3');
    expect(layerOwnerArchive('Vol 3', archives)).toBe('Vol 3');
    // Spelled like NONE of the fold group: one owner, independent of order.
    expect(layerOwnerArchive('vOl 3', archives)).toBe('VOL 3');
    expect(layerOwnerArchive('vOl 3', [...archives].reverse())).toBe('VOL 3');
    expect(layerOwnerArchive('Vo\u{301}l 1', ['V\u{f3}l 1'])).toBe('V\u{f3}l 1');
    expect(layerOwnerArchive('STRASSE', ['Stra\u{df}e'])).toBe('Stra\u{df}e');
    // Code-point order, where UTF-16 order picks the other spelling.
    expect(layerOwnerArchive('y', ['Y\u{1bca0}', 'Y\u{ffa0}'])).toBe('Y\u{ffa0}');
    expect(layerOwnerArchive('Vol 5', archives)).toBeUndefined();
  });

  it('sweepOwnerArchive: exact, else the only one, never a fold-only match in a group', () => {
    expect(sweepOwnerArchive('vol 3.mokuro', ['Vol 3.cbz', 'vol 3.mokuro'])).toBe('Vol 3');
    expect(sweepOwnerArchive('vol 3.mokuro', ['Vol 3.cbz', 'VOL 3.cbz', 'vol 3.mokuro'])).toBe(
      undefined
    );
    expect(sweepOwnerArchive('VOL 3.gcv.mokuro', ['Vol 3.cbz', 'VOL 3.cbz'])).toBe('VOL 3');
    expect(sweepOwnerArchive('Vol 3.5.mokuro', ['Vol 3.cbz', 'Vol 3.5.zip'])).toBeUndefined();
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
    // Read on the folded id (rule 2, R5): a miscased `edit` is the edit layer.
    expect(isReservedLayerSidecarPath('S/Vol 1.EDIT.mokuro')).toBe(true);
  });

  it('nothing else', () => {
    for (const path of [
      'S/Vol 1.mokuro',
      'S/Vol 1.fix.mokuro',
      // Ordinary hand-made ids: bunko no longer writes or reserves them.
      'S/Vol 1.pre-upgrade.mokuro',
      'S/Vol 1.pre-upgrade-2.mokuro',
      'S/Vol 1.previous-ocr.mokuro',
      'S/Vol 1.edit.cbz',
      'S/series.json',
      'S/edit.mokuro'
    ]) {
      expect(isReservedLayerSidecarPath(path), path).toBe(false);
    }
  });
});

describe('the series queue file (queue file v2)', () => {
  it('is named .mokuro-series-queue.json', () => {
    expect(SERIES_QUEUE_FILE_NAME).toBe('.mokuro-series-queue.json');
  });

  it('is never listed, in a series folder or anywhere else', () => {
    expect(isSyncableFile(`Example Saga/${SERIES_QUEUE_FILE_NAME}`)).toBe(false);
    expect(isSyncableFile(SERIES_QUEUE_FILE_NAME)).toBe(false);
    expect(isSidecarFile(SERIES_QUEUE_FILE_NAME)).toBe(false);
    expect(isRootConfigFile(SERIES_QUEUE_FILE_NAME)).toBe(false);
  });

  it('is no root control file, and the root names are unchanged', () => {
    expect(isBunkoControlFile(SERIES_QUEUE_FILE_NAME)).toBe(false);
    // A merge keeps every copy only of the root files; this one is Bunko's to merge.
    expect(dedupKeepsEveryCopy(SERIES_QUEUE_FILE_NAME)).toBe(false);
    expect(QUEUE_FILE_NAME).toBe('.mokuro-queue.json');
    expect(BUNKO_MARKER_NAME).toBe('.mokuro-bunko.json');
    expect(isBunkoControlFile(QUEUE_FILE_NAME)).toBe(true);
    expect(isBunkoControlFile(BUNKO_MARKER_NAME)).toBe(true);
  });

  it('is recognised by its fold (R8), and series folders compare by foldName (R1)', () => {
    expect(isSeriesQueueFile(SERIES_QUEUE_FILE_NAME)).toBe(true);
    expect(isSeriesQueueFile('.MOKURO-SERIES-QUEUE.JSON')).toBe(true);
    expect(isSeriesQueueFile('.mokuro-series-que\u200bue.json')).toBe(true);
    expect(isSeriesQueueFile(QUEUE_FILE_NAME)).toBe(false);
    expect(foldName('Example SAGA')).toBe(foldName('example saga'));
    expect(foldName('Sa\u0301ga')).toBe(foldName('S\u00c1GA'));
    expect(foldName('STRASSE')).toBe(foldName('Stra\u00dfe'));
  });
});
