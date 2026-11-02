import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  type CloudFileMetadata,
  type FileStamp,
  type SyncProvider
} from './provider-interface';
import {
  clearRootFileMemo,
  isMemoRootFile,
  noteRootFileUpload,
  readRootFile,
  rootFileMemoSize,
  sameStamp
} from './root-file-memo';

/** A server holding files by id: `stat` and `download` read the same state. */
function fakeServer(scope: string | null = 'webdav:https://host|alice') {
  const files = new Map<string, { body: string; stamp: FileStamp }>();
  const statFile = vi.fn(async (file: CloudFileMetadata) => files.get(file.fileId)?.stamp ?? null);
  const downloadFile = vi.fn(async (file: CloudFileMetadata) => {
    const held = files.get(file.fileId);
    if (!held) throw new ProviderError('File not found', 'webdav', 'NOT_FOUND');
    return new Blob([held.body]);
  });
  const provider = {
    type: 'webdav',
    statFile,
    downloadFile,
    getStatus: () => ({
      isAuthenticated: true,
      hasStoredCredentials: true,
      needsAttention: false,
      statusMessage: '',
      accountScope: scope ?? undefined
    })
  } as unknown as SyncProvider;
  let seq = 0;
  const write = (fileId: string, body: string, revision = true) => {
    seq++;
    files.set(fileId, {
      body,
      stamp: {
        size: new Blob([body]).size,
        modifiedTime: new Date(Date.UTC(2026, 10, 2, 10, 0, seq)).toUTCString(),
        ...(revision ? { revision: `r${seq}` } : {})
      }
    });
    return files.get(fileId)!.stamp;
  };
  return { provider, files, write, statFile, downloadFile };
}

function listed(fileId: string, path = 'volume-data.json'): CloudFileMetadata {
  return { provider: 'webdav', fileId, path, modifiedTime: '', size: 0 };
}

beforeEach(() => {
  clearRootFileMemo();
});

describe('readRootFile', () => {
  it('reads a file once, then answers an unchanged one from the stat alone', async () => {
    const server = fakeServer();
    server.write('/v', '{"a":1}');

    expect(await (await readRootFile(server.provider, listed('/v'))).text()).toBe('{"a":1}');
    expect(server.downloadFile).toHaveBeenCalledTimes(1);

    expect(await (await readRootFile(server.provider, listed('/v'))).text()).toBe('{"a":1}');
    expect(server.downloadFile).toHaveBeenCalledTimes(1);
    expect(server.statFile).toHaveBeenCalledTimes(2);
  });

  it('downloads again when the file changed, and passes the stat size to the download', async () => {
    const server = fakeServer();
    server.write('/v', '{"a":1}');
    await readRootFile(server.provider, listed('/v'));
    const stamp = server.write('/v', '{"a":22}');

    expect(await (await readRootFile(server.provider, listed('/v'))).text()).toBe('{"a":22}');
    expect(server.downloadFile).toHaveBeenCalledTimes(2);
    expect(server.downloadFile).toHaveBeenLastCalledWith(listed('/v'), undefined, {
      knownSize: stamp.size
    });
  });

  it('never trusts size + mtime: a provider without change tokens is read as before', async () => {
    const server = fakeServer();
    server.write('/v', '{"a":1}', false);
    await readRootFile(server.provider, listed('/v'));
    // Same size, same second on a one-second clock: only a token could tell.
    server.files.get('/v')!.body = '{"a":2}';
    expect(await (await readRootFile(server.provider, listed('/v'))).text()).toBe('{"a":2}');
    expect(server.downloadFile).toHaveBeenCalledTimes(2);
    // One tokenless stat was enough: the session's reads skip the stat.
    expect(server.statFile).toHaveBeenCalledTimes(1);
    expect(rootFileMemoSize()).toBe(0);
  });

  it('samples the stamp BEFORE the body: a write racing the download costs a re-read', async () => {
    const server = fakeServer();
    server.write('/v', '{"a":1}');
    // The download lands after another device's write: newer bytes, older stamp.
    server.downloadFile.mockImplementationOnce(async () => {
      server.write('/v', '{"a":2}');
      return new Blob(['{"a":2}']);
    });
    await readRootFile(server.provider, listed('/v'));

    await readRootFile(server.provider, listed('/v'));
    expect(server.downloadFile).toHaveBeenCalledTimes(2);
  });

  it('a file the server reports gone throws NOT_FOUND without a download', async () => {
    const server = fakeServer();
    server.write('/v', '{"a":1}');
    await readRootFile(server.provider, listed('/v'));
    server.files.delete('/v');

    await expect(readRootFile(server.provider, listed('/v'))).rejects.toMatchObject({
      code: 'NOT_FOUND'
    });
    expect(server.downloadFile).toHaveBeenCalledTimes(1);
    // ...and a never-read gone file the same.
    await expect(readRootFile(server.provider, listed('/never'))).rejects.toBeInstanceOf(
      ProviderError
    );
    expect(server.downloadFile).toHaveBeenCalledTimes(1);
  });

  it('memoizes duplicate copies one by one', async () => {
    const server = fakeServer();
    server.write('/a', '{"a":1}');
    server.write('/b', '{"b":1}');
    await readRootFile(server.provider, listed('/a'));
    await readRootFile(server.provider, listed('/b'));
    server.write('/b', '{"b":2}');

    expect(await (await readRootFile(server.provider, listed('/a'))).text()).toBe('{"a":1}');
    expect(await (await readRootFile(server.provider, listed('/b'))).text()).toBe('{"b":2}');
    expect(server.downloadFile.mock.calls.map(([file]) => file.fileId)).toEqual(['/a', '/b', '/b']);
  });

  it('a failed stat falls back to the plain download, memoizing nothing', async () => {
    const server = fakeServer();
    server.write('/v', '{"a":1}');
    server.statFile.mockRejectedValueOnce(new Error('PROPFIND refused'));
    await readRootFile(server.provider, listed('/v'));
    expect(server.downloadFile).toHaveBeenCalledWith(listed('/v'));
    expect(rootFileMemoSize()).toBe(0);
  });

  it('a provider without statFile, or without an account scope, is a plain download', async () => {
    const noScope = fakeServer(null);
    noScope.write('/v', '{"a":1}');
    await readRootFile(noScope.provider, listed('/v'));
    await readRootFile(noScope.provider, listed('/v'));
    expect(noScope.downloadFile).toHaveBeenCalledTimes(2);
    expect(noScope.statFile).not.toHaveBeenCalled();

    const noStat = fakeServer();
    noStat.write('/v', '{"a":1}');
    delete (noStat.provider as { statFile?: unknown }).statFile;
    await readRootFile(noStat.provider, listed('/v'));
    expect(noStat.downloadFile).toHaveBeenCalledWith(listed('/v'));
  });

  it('clearRootFileMemo forgets every file (its wiring: cache-manager.test.ts)', async () => {
    const server = fakeServer();
    server.write('/v', '{"a":1}');
    await readRootFile(server.provider, listed('/v'));
    clearRootFileMemo();
    await readRootFile(server.provider, listed('/v'));
    expect(server.downloadFile).toHaveBeenCalledTimes(2);
  });

  it('is bounded to 16 files, evicting the least recently read; a hit makes a file newest', async () => {
    const server = fakeServer();
    const ids = Array.from({ length: 17 }, (_, i) => `/copy-${i}`);
    for (const id of ids) server.write(id, `{"id":"${id}"}`);

    // Memoize the first 16, then touch /copy-0 so /copy-1 is now the oldest.
    for (const id of ids.slice(0, 16)) await readRootFile(server.provider, listed(id));
    expect(rootFileMemoSize()).toBe(16);
    await readRootFile(server.provider, listed('/copy-0'));
    expect(server.downloadFile).toHaveBeenCalledTimes(16); // a hit, not a download

    // The 17th evicts exactly one entry: the least recently READ one.
    await readRootFile(server.provider, listed('/copy-16'));
    expect(rootFileMemoSize()).toBe(16);
    expect(server.downloadFile).toHaveBeenCalledTimes(17);

    // /copy-0 survived its age because it was read again …
    await readRootFile(server.provider, listed('/copy-0'));
    expect(server.downloadFile).toHaveBeenCalledTimes(17);
    // … and every other survivor is still a hit.
    for (const id of ids.slice(2)) await readRootFile(server.provider, listed(id));
    expect(server.downloadFile).toHaveBeenCalledTimes(17);

    // /copy-1 was the one evicted: reading it downloads again.
    await readRootFile(server.provider, listed('/copy-1'));
    expect(server.downloadFile).toHaveBeenCalledTimes(18);
    expect(server.downloadFile).toHaveBeenLastCalledWith(listed('/copy-1'), undefined, {
      knownSize: server.files.get('/copy-1')!.stamp.size
    });
    expect(rootFileMemoSize()).toBe(16);
  });
});

describe('noteRootFileUpload', () => {
  it("seeds the memo from the receipt: the next read of this device's own write is a stat", async () => {
    const server = fakeServer();
    const body = '{"mine":1}';
    const stamp = server.write('/mokuro-reader/volume-data.json', body);
    await noteRootFileUpload(server.provider, 'volume-data.json', new Blob([body]), {
      fileId: '/mokuro-reader/volume-data.json',
      size: stamp.size,
      modifiedTime: stamp.modifiedTime,
      revision: stamp.revision
    });

    const read = await readRootFile(server.provider, listed('/mokuro-reader/volume-data.json'));
    expect(await read.text()).toBe(body);
    expect(server.downloadFile).not.toHaveBeenCalled();
  });

  it('a change token alone (a WebDAV PUT ETag) is a stamp for exactly the bytes sent', async () => {
    const server = fakeServer();
    const body = '{"mine":1}';
    const stamp = server.write('/p', body);
    await noteRootFileUpload(server.provider, 'positions.json', new TextEncoder().encode(body), {
      fileId: '/p',
      revision: stamp.revision
    });
    await readRootFile(server.provider, listed('/p', 'positions.json'));
    expect(server.downloadFile).not.toHaveBeenCalled();
  });

  it('a receipt without a stamp drops the memo: the next read downloads once', async () => {
    const server = fakeServer();
    server.write('/v', '{"a":1}');
    await readRootFile(server.provider, listed('/v'));
    expect(rootFileMemoSize()).toBe(1);

    server.write('/v', '{"a":2}');
    await noteRootFileUpload(server.provider, 'volume-data.json', new Blob(['{"a":2}']), {
      fileId: '/v'
    });
    expect(rootFileMemoSize()).toBe(0);
    await readRootFile(server.provider, listed('/v'));
    expect(server.downloadFile).toHaveBeenCalledTimes(2);
  });

  it('a receipt whose server size disagrees with the bytes sent vouches for nothing', async () => {
    const server = fakeServer();
    await noteRootFileUpload(server.provider, 'goals.json', new Blob(['{}']), {
      fileId: '/g',
      size: 99,
      modifiedTime: '2026-11-02T10:00:00.000Z'
    });
    expect(rootFileMemoSize()).toBe(0);
  });

  it('ignores every path but the four root files', async () => {
    const server = fakeServer();
    await noteRootFileUpload(server.provider, 'Series/series.json', new Blob(['{}']), {
      fileId: '/s',
      size: 2,
      modifiedTime: '2026-11-02T10:00:00.000Z'
    });
    expect(rootFileMemoSize()).toBe(0);
    expect(
      ['volume-data.json', 'profiles.json', 'goals.json', 'positions.json'].every((p) =>
        isMemoRootFile(p)
      )
    ).toBe(true);
    expect(isMemoRootFile('catalog.json')).toBe(false);
  });
});

describe('sameStamp', () => {
  it('is the change token and the size, never the time', () => {
    const t = 'Mon, 02 Nov 2026 10:00:00 GMT';
    expect(sameStamp({ size: 2, revision: 'a' }, { size: 2, modifiedTime: t, revision: 'a' })).toBe(
      true
    );
    expect(sameStamp({ size: 2, revision: 'a' }, { size: 2, modifiedTime: t, revision: 'b' })).toBe(
      false
    );
    expect(sameStamp({ size: 2, revision: 'a' }, { size: 3, modifiedTime: t, revision: 'a' })).toBe(
      false
    );
    // Equal size and time is not proof (one-second clocks): never the same.
    expect(
      sameStamp({ size: 2, modifiedTime: '2026-11-02T10:00:00.000Z' }, { size: 2, modifiedTime: t })
    ).toBe(false);
    expect(sameStamp({ size: 2, revision: 'a' }, { size: 2, modifiedTime: t })).toBe(false);
  });
});
