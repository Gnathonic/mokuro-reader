import { describe, expect, it } from 'vitest';
import type { CloudFileMetadata } from '$lib/util/sync/provider-interface';
import {
  buildCloudSidecarStamps,
  groupSeriesSidecarFiles,
  isSidecarStale,
  isoToEpochSeconds,
  stampFromSidecarFiles
} from './cloud-sidecar-stamps';

function file(path: string, size: number, modifiedTime: string): CloudFileMetadata {
  return { provider: 'webdav', fileId: path, path, size, modifiedTime } as CloudFileMetadata;
}

/**
 * An upload-time cache entry whose provider returned no server mtime: its
 * `modifiedTime` is the CLIENT clock, and the flag says so.
 */
function provisionalFile(path: string, size: number, modifiedTime: string): CloudFileMetadata {
  return { ...file(path, size, modifiedTime), modifiedTimeProvisional: true };
}

describe('isoToEpochSeconds', () => {
  it('truncates, never rounds', () => {
    // 999ms would round up to the next second; truncation must not do that.
    expect(isoToEpochSeconds('1970-01-01T00:00:00.999Z')).toBe(0);
    expect(isoToEpochSeconds('2026-08-24T12:00:01.001Z')).toBe(
      Math.floor(Date.parse('2026-08-24T12:00:01.001Z') / 1000)
    );
  });

  it('is undefined for missing or unparsable input', () => {
    expect(isoToEpochSeconds(undefined)).toBeUndefined();
    expect(isoToEpochSeconds('')).toBeUndefined();
    expect(isoToEpochSeconds('not a date')).toBeUndefined();
  });
});

describe('groupSeriesSidecarFiles', () => {
  it('groups a .mokuro and a .webp cover under the same folded volume title', () => {
    const files = [
      file('One Piece/Volume 01.cbz', 1000, '2026-01-01T00:00:00Z'),
      file('One Piece/Volume 01.mokuro', 2000, '2026-01-02T00:00:00Z'),
      file('One Piece/Volume 01.webp', 300, '2026-01-03T00:00:00Z')
    ];
    const groups = groupSeriesSidecarFiles(files);
    expect(groups.size).toBe(1);
    const only = [...groups.values()][0];
    expect(only.mokuro?.path).toBe('One Piece/Volume 01.mokuro');
    expect(only.cover?.path).toBe('One Piece/Volume 01.webp');
  });

  it('prefers .mokuro over .mokuro.gz when both are listed', () => {
    const files = [
      file('S/V.mokuro.gz', 500, '2026-01-01T00:00:00Z'),
      file('S/V.mokuro', 900, '2026-01-02T00:00:00Z')
    ];
    const groups = groupSeriesSidecarFiles(files);
    const only = [...groups.values()][0];
    expect(only.mokuro?.path).toBe('S/V.mokuro');
  });

  it('prefers .webp over .jpg for the cover', () => {
    const files = [
      file('S/V.jpg', 100, '2026-01-01T00:00:00Z'),
      file('S/V.webp', 200, '2026-01-02T00:00:00Z')
    ];
    const groups = groupSeriesSidecarFiles(files);
    const only = [...groups.values()][0];
    expect(only.cover?.path).toBe('S/V.webp');
  });

  it('ignores the archive itself and unrelated files', () => {
    const files = [
      file('S/V.cbz', 100, '2026-01-01T00:00:00Z'),
      file('S/series.json', 50, '2026-01-01T00:00:00Z')
    ];
    expect(groupSeriesSidecarFiles(files).size).toBe(0);
  });
});

describe('buildCloudSidecarStamps', () => {
  it('derives size + epoch-seconds mtime for both mokuro and cover', () => {
    const files = [
      file('S/V.mokuro', 4096, '2026-01-01T00:00:10Z'),
      file('S/V.webp', 512, '2026-01-01T00:00:20Z')
    ];
    const stamps = buildCloudSidecarStamps(files);
    const stamp = [...stamps.values()][0];
    expect(stamp).toEqual({
      mokuro_size: 4096,
      mokuro_modified: Math.floor(Date.parse('2026-01-01T00:00:10Z') / 1000),
      cover_size: 512,
      cover_modified: Math.floor(Date.parse('2026-01-01T00:00:20Z') / 1000)
    });
  });
});

describe('stampFromSidecarFiles', () => {
  it('is the listing snapshot, not wall-clock time, even under fake timers', () => {
    // Pin the wall clock far from the listing's own timestamp: the stamp must
    // reflect the LISTING record, never `Date.now()`.
    const captured = { mokuro: file('S/V.mokuro', 111, '2020-01-01T00:00:00Z') };
    expect(stampFromSidecarFiles(captured)).toEqual({
      mokuro_size: 111,
      mokuro_modified: Math.floor(Date.parse('2020-01-01T00:00:00Z') / 1000)
    });
  });
});

describe('isSidecarStale', () => {
  it('is never stale when the listing has no sidecar at all', () => {
    expect(isSidecarStale({ size: 10, modified: 5 }, undefined)).toBe(false);
  });

  it('is NEVER stale when the entry has no stamp — adopts the listing as baseline, not a pull candidate', () => {
    // 2026-08-24 field regression: the old "heal once" rule here queued
    // ~1800 pulls for a 197-series library whose entries predate the
    // stamp scheme. A stampless entry already carries the real uuid/counts a
    // pull would produce, so it is never re-pulled for the stamp alone.
    expect(isSidecarStale({}, { size: 10, modified: 5 })).toBe(false);
    expect(
      isSidecarStale({ size: undefined, modified: undefined }, { size: 10, modified: 5 })
    ).toBe(false);
  });

  it('is stale when the size differs', () => {
    expect(isSidecarStale({ size: 10, modified: 5 }, { size: 11, modified: 5 })).toBe(true);
  });

  it('is stale when the listing mtime is strictly newer, same size', () => {
    expect(isSidecarStale({ size: 10, modified: 5 }, { size: 10, modified: 6 })).toBe(true);
  });

  it('is NOT stale when the listing mtime is older, same size', () => {
    expect(isSidecarStale({ size: 10, modified: 5 }, { size: 10, modified: 4 })).toBe(false);
  });

  it('is NOT stale when the listing mtime equals the stored one, same size', () => {
    expect(isSidecarStale({ size: 10, modified: 5 }, { size: 10, modified: 5 })).toBe(false);
  });
});

describe('stamp provenance — provisional upload-time cache entries', () => {
  it('stampFromSidecarFiles publishes NOTHING for a provisional mokuro, while the server-stamped cover beside it still stamps', () => {
    const stamp = stampFromSidecarFiles({
      mokuro: provisionalFile('S/V.mokuro', 2000, '2026-08-27T00:00:00Z'),
      cover: file('S/V.webp', 300, '2026-01-03T00:00:00Z')
    });
    // A client-clock mtime must never publish, and the size is withheld with
    // it so the entry stays FULLY stampless for that sidecar (a stampless
    // entry adopts the next listing as its baseline).
    expect(stamp.mokuro_size).toBeUndefined();
    expect(stamp.mokuro_modified).toBeUndefined();
    // The refusal is per FILE, not per group: the cover's stamp is real.
    expect(stamp.cover_size).toBe(300);
    expect(stamp.cover_modified).toBe(Math.floor(Date.parse('2026-01-03T00:00:00Z') / 1000));
  });

  it('stampFromSidecarFiles publishes NOTHING for a provisional cover, while the server-stamped mokuro beside it still stamps', () => {
    const stamp = stampFromSidecarFiles({
      mokuro: file('S/V.mokuro', 2000, '2026-01-02T00:00:00Z'),
      cover: provisionalFile('S/V.webp', 300, '2026-08-27T00:00:00Z')
    });
    expect(stamp.cover_size).toBeUndefined();
    expect(stamp.cover_modified).toBeUndefined();
    expect(stamp.mokuro_size).toBe(2000);
    expect(stamp.mokuro_modified).toBe(Math.floor(Date.parse('2026-01-02T00:00:00Z') / 1000));
  });

  it('buildCloudSidecarStamps omits a volume whose ONLY sidecar is provisional', () => {
    const stamps = buildCloudSidecarStamps([
      provisionalFile('S/V1.mokuro', 2000, '2026-08-27T00:00:00Z'),
      file('S/V2.mokuro', 4096, '2026-01-01T00:00:10Z')
    ]);
    // V1 contributes no stamp at all; V2 (the positive control) still does.
    expect(stamps.size).toBe(1);
    const only = [...stamps.values()][0];
    expect(only).toEqual({
      mokuro_size: 4096,
      mokuro_modified: Math.floor(Date.parse('2026-01-01T00:00:10Z') / 1000)
    });
  });

  it('isSidecarStale treats an information-free listing stamp as NOT stale — a provisional sidecar must never trigger a re-pull', () => {
    // The shape a provisional listing entry produces downstream: the file is
    // listed, but `stampFromSidecarFiles` withheld every field.
    expect(isSidecarStale({ size: 100, modified: 1000 }, {})).toBe(false);
    // Control: the guard must not deaden real comparisons — the same entry IS
    // stale against a listing stamp that carries a differing size.
    expect(isSidecarStale({ size: 100, modified: 1000 }, { size: 101 })).toBe(true);
  });
});
