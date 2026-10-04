import { describe, expect, it, vi } from 'vitest';
import {
  archiveSourceLabel,
  planArchiveListing,
  prescanArchives,
  scanArchiveListing,
  type ListedEntry
} from '../archive-listing';
import type { PairedSource } from '../types';

const listed = (...names: string[]): ListedEntry[] =>
  names.map((filename) => ({ filename, data: new ArrayBuffer(0) }));

const archive = (name: string, titlePath = name.replace(/\.(cbz|zip)$/i, '')) => ({
  name,
  titlePath
});

function archivePairing(name: string, opts: { path?: string; mokuro?: File } = {}): PairedSource {
  const file = new File([new Uint8Array([1])], name);
  if (opts.path) Object.defineProperty(file, 'webkitRelativePath', { value: opts.path });
  return {
    id: `id-${name}`,
    mokuroFile: opts.mokuro ?? null,
    source: { type: 'archive', file },
    basePath: name.replace(/\.cbz$/i, ''),
    estimatedSize: 1,
    imageOnly: false
  };
}

describe('planArchiveListing', () => {
  it('pairs a mixed archive from its names alone', async () => {
    const plan = await planArchiveListing(
      listed('A.mokuro', 'A/001.jpg', 'B/001.jpg', 'B/002.jpg', 'series.json', 'Extra.cbz'),
      archive('Pack.zip')
    );
    expect(plan.mokuroPairings.map((p) => p.basePath)).toEqual(['A']);
    expect(plan.imageOnlyPairings.map((p) => [p.basePath, p.titlePath])).toEqual([['B', 'Pack/B']]);
    expect([...plan.innerPaths.values()]).toEqual(['B']);
    expect(plan.nestedArchivePaths).toEqual(['Extra.cbz']);
    expect(plan.seriesFilePaths).toEqual(['series.json']);
  });

  it('names a volume whose pages sit at the archive root after the archive', async () => {
    const plan = await planArchiveListing(
      listed('001.jpg', '002.jpg'),
      archive('Gleipnir v01 (2023) (Digital).cbz')
    );
    const [volume] = plan.imageOnlyPairings;
    expect(volume.basePath).toBe('Gleipnir v01 (2023) (Digital)');
    expect(volume.titlePath).toBe('Gleipnir v01 (2023) (Digital)');
    expect(plan.innerPaths.get(volume.id)).toBe('.');
  });

  it('never takes an exported thumbnail sidecar for a volume of its own', async () => {
    const plan = await planArchiveListing(
      listed('Vol 1/001.jpg', 'Vol 1.webp'),
      archive('Vol 1.cbz')
    );
    expect(plan.imageOnlyPairings.map((p) => plan.innerPaths.get(p.id))).toEqual(['Vol 1']);
  });

  it('holds OCR layer files aside instead of pairing them', async () => {
    const plan = await planArchiveListing(
      listed('A.mokuro', 'A.gcv.mokuro', 'A/001.jpg'),
      archive('A.cbz')
    );
    expect(plan.mokuroPairings).toHaveLength(1);
    expect(plan.layerEntries.map((e) => e.path)).toEqual(['A.gcv.mokuro']);
  });
});

describe('scanArchiveListing', () => {
  it('stays silent when every volume has its .mokuro', async () => {
    expect(await scanArchiveListing(listed('A.mokuro', 'A/001.jpg'), archive('A.cbz'))).toEqual({
      kind: 'silent'
    });
  });

  it('stays silent for an archive of archives — those are reviewed when the queue opens them', async () => {
    expect(
      await scanArchiveListing(listed('Vol 1.cbz', 'Vol 2.cbz'), archive('Outer.zip'))
    ).toEqual({ kind: 'silent' });
  });

  it('offers the image-only volumes, by name only', async () => {
    expect(
      await scanArchiveListing(listed('v01/001.jpg', 'v02/001.jpg'), archive('Series Pack.zip'))
    ).toEqual({
      kind: 'review',
      importsRegardless: false,
      inner: [
        { innerPath: 'v01', basePath: 'v01', titlePath: 'Series Pack/v01' },
        { innerPath: 'v02', basePath: 'v02', titlePath: 'Series Pack/v02' }
      ]
    });
  });

  it('a mixed archive imports its .mokuro volumes whatever the review decides', async () => {
    const scan = await scanArchiveListing(
      listed('A.mokuro', 'A/001.jpg', 'B/001.jpg'),
      archive('Pack.zip')
    );
    expect(scan).toMatchObject({ kind: 'review', importsRegardless: true });
  });
});

describe('prescanArchives', () => {
  it('lists archives one at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const list = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return listed('001.jpg');
    });
    await prescanArchives(
      [archivePairing('a.cbz'), archivePairing('b.cbz'), archivePairing('c.cbz')],
      list
    );
    expect(list).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });

  it('never lists an archive that came with its own .mokuro, or a folder', async () => {
    const list = vi.fn(async () => listed('001.jpg'));
    const folder: PairedSource = {
      id: 'dir',
      mokuroFile: null,
      source: { type: 'directory', files: new Map() },
      basePath: 'x',
      estimatedSize: 0,
      imageOnly: false
    };
    const scans = await prescanArchives(
      [archivePairing('v.cbz', { mokuro: new File(['{}'], 'v.mokuro') }), folder],
      list
    );
    expect(list).not.toHaveBeenCalled();
    expect(scans.size).toBe(0);
  });

  it('leaves an archive it cannot list on the queue path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scans = await prescanArchives([archivePairing('broken.cbz')], async () => {
      throw new Error('End of central directory not found');
    });
    expect(scans.get('id-broken.cbz')).toEqual({ kind: 'unlisted' });
    warn.mockRestore();
  });

  it('names a picked archive by where it sat', async () => {
    const scans = await prescanArchives(
      [archivePairing('Vol 03 extra.cbz', { path: 'My Series (2023)/Vol 03 extra.cbz' })],
      async () => listed('001.jpg')
    );
    expect(scans.get('id-Vol 03 extra.cbz')).toMatchObject({
      kind: 'review',
      inner: [{ innerPath: '.', titlePath: 'My Series (2023)/Vol 03 extra' }]
    });
  });

  it('keeps nothing but names: no file, no bytes', async () => {
    const scans = await prescanArchives([archivePairing('p.zip')], async () =>
      listed('v01/001.jpg', 'v02/001.jpg')
    );
    const holdsBytes = (value: unknown): boolean =>
      value instanceof Blob ||
      value instanceof ArrayBuffer ||
      (typeof value === 'object' && value !== null && Object.values(value).some(holdsBytes));
    expect(holdsBytes([...scans.values()])).toBe(false);
  });
});

describe('archiveSourceLabel', () => {
  it('shows the picked archive, and the folder inside it', () => {
    const file = new File([], 'Pack.zip');
    expect(archiveSourceLabel(file, '.')).toBe('Pack.zip');
    expect(archiveSourceLabel(file, 'v01')).toBe('Pack.zip › v01');
  });
});
