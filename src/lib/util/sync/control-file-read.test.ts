import { describe, expect, it, vi } from 'vitest';
import {
  ControlNodeCache,
  controlReadKey,
  controlSetEtag,
  isPathSafeFolderName,
  readControlNodes
} from './control-file-read';

const NAME = '.mokuro-bunko.json';

describe('readControlNodes', () => {
  it('returns null when no node of the name exists', async () => {
    const download = vi.fn();
    expect(await readControlNodes(NAME, [], download, new ControlNodeCache())).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it('downloads every node once, then answers not-modified for the same set', async () => {
    const cache = new ControlNodeCache();
    const download = vi.fn(async (n: { id: string }) => new Blob([n.id]));
    const listed = [
      { id: 'a', etag: '1', modified: '2026-10-12T10:00:00Z' },
      { id: 'b', etag: '7' }
    ];
    const first = await readControlNodes(NAME, listed, download, cache);
    expect(first).not.toBeNull();
    expect(first).not.toBe('not-modified');
    if (!first || first === 'not-modified') return;
    expect(first.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(first.nodes[0].modified).toBe('2026-10-12T10:00:00Z');
    expect(await first.nodes[1].blob.text()).toBe('b');
    expect(download).toHaveBeenCalledTimes(2);

    expect(await readControlNodes(NAME, listed, download, cache, first.etag)).toBe('not-modified');
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('re-downloads only the node whose version moved', async () => {
    const cache = new ControlNodeCache();
    const download = vi.fn(async (n: { id: string; etag: string }) => new Blob([n.etag]));
    const a = await readControlNodes(
      NAME,
      [
        { id: 'a', etag: '1' },
        { id: 'b', etag: '1' }
      ],
      download,
      cache
    );
    const b = await readControlNodes(
      NAME,
      [
        { id: 'a', etag: '1' },
        { id: 'b', etag: '2' }
      ],
      download,
      cache,
      a && a !== 'not-modified' ? a.etag : undefined
    );
    expect(download).toHaveBeenCalledTimes(3);
    expect(download.mock.calls[2][0]).toMatchObject({ id: 'b', etag: '2' });
    if (!b || b === 'not-modified') throw new Error('expected nodes');
    expect(await b.nodes[1].blob.text()).toBe('2');
  });

  it('a set etag ignores order and changes with any node', () => {
    expect(
      controlSetEtag([
        { id: 'a', etag: '1' },
        { id: 'b', etag: '2' }
      ])
    ).toBe(
      controlSetEtag([
        { id: 'b', etag: '2' },
        { id: 'a', etag: '1' }
      ])
    );
    expect(controlSetEtag([{ id: 'a', etag: '1' }])).not.toBe(
      controlSetEtag([{ id: 'a', etag: '2' }])
    );
  });
});

describe('series-folder control reads', () => {
  const SQ = '.mokuro-series-queue.json';

  it('keys a root read by the name, a folder read by folded folder + name', () => {
    expect(controlReadKey(NAME)).toBe(NAME);
    expect(controlReadKey(SQ, 'Example Saga')).toBe(`example saga/${SQ}`);
    // Every spelling of one folder is one read: case, and NFD vs NFC.
    expect(controlReadKey(SQ, 'EXAMPLE SAGA')).toBe(controlReadKey(SQ, 'example saga'));
    expect(controlReadKey(SQ, 'Sa\u0301ga')).toBe(controlReadKey(SQ, 'S\u00e1ga'));
    expect(controlReadKey(SQ, 'Other Saga')).not.toBe(controlReadKey(SQ, 'Example Saga'));
  });

  it('a folder read and a root read of one name never evict each other', async () => {
    const cache = new ControlNodeCache();
    const download = vi.fn(async (n: { id: string }) => new Blob([n.id]));
    await readControlNodes(controlReadKey(SQ, 'Saga'), [{ id: 'f', etag: '1' }], download, cache);
    await readControlNodes(controlReadKey(SQ), [], download, cache);
    await readControlNodes(controlReadKey(SQ, 'Other'), [{ id: 'o', etag: '1' }], download, cache);
    await readControlNodes(controlReadKey(SQ, 'SAGA'), [{ id: 'f', etag: '1' }], download, cache);
    expect(download.mock.calls.map(([n]) => n.id)).toEqual(['f', 'o']);
  });

  it('a path store accepts one plain folder name, nothing that climbs or nests', () => {
    expect(isPathSafeFolderName('Example Saga')).toBe(true);
    expect(isPathSafeFolderName('Saga #1: 50%?')).toBe(true);
    expect(isPathSafeFolderName('...')).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', '/a', 'a/', '../x']) {
      expect(isPathSafeFolderName(bad)).toBe(false);
    }
  });
});
