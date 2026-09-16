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
  cbzStemsOf
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
    expect(isBestEffortMetadataPath('Dr Stone/Volume 1.cbz')).toBe(false);
    expect(isBestEffortMetadataPath('Dr Stone/catalog.json')).toBe(false);
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
      // Case-folded id, stem kept verbatim.
      expect(splitLayerSidecarName('Vol 1.GCV.mokuro')?.layerId).toBe('gcv');
    });
  });
});
