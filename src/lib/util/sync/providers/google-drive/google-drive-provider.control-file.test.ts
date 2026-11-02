import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/util/sync/providers/google-drive/token-manager', () => ({
  tokenManager: {
    isAuthenticated: vi.fn(() => true),
    requestNewToken: vi.fn(),
    token: { subscribe: (cb: (v: string) => void) => (cb('TOKEN'), () => {}) },
    needsAttention: { subscribe: (cb: (v: boolean) => void) => (cb(false), () => {}) },
    logout: vi.fn(async () => {})
  }
}));
vi.mock('$lib/util/sync/providers/google-drive/api-client', () => ({
  driveApiClient: {
    initialize: vi.fn(async () => {}),
    listFiles: vi.fn(async () => []),
    downloadFile: vi.fn(async () => new Blob([''])),
    createFolder: vi.fn(async () => 'created-folder')
  },
  escapeNameForDriveQuery: (name: string) => name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}));
vi.mock('$lib/util/sync/providers/google-drive/drive-files-cache', () => ({
  driveFilesCache: {
    getReaderFolderId: vi.fn(async () => null),
    getListedReaderFolderIds: vi.fn((): string[] | null => null),
    setReaderFolderId: vi.fn(),
    clear: vi.fn(),
    fetch: vi.fn(async () => {})
  }
}));
vi.mock('$lib/util/backup', () => ({ findFile: vi.fn() }));
vi.mock('../../cache-manager', () => ({
  cacheManager: { registerCache: vi.fn(), clearAll: vi.fn() }
}));
vi.mock('../../provider-manager', () => ({
  providerManager: { updateStatus: vi.fn() }
}));
vi.mock('../../provider-detection', () => ({
  setActiveProviderKey: vi.fn(),
  clearActiveProviderKey: vi.fn()
}));
vi.mock('../../core/cloud-provider-core-registry', () => ({
  getCloudProviderCore: vi.fn(() => ({}))
}));

import { googleDriveProvider } from './google-drive-provider';
import { driveApiClient } from '$lib/util/sync/providers/google-drive/api-client';
import { driveFilesCache } from '$lib/util/sync/providers/google-drive/drive-files-cache';
import { tokenManager } from '$lib/util/sync/providers/google-drive/token-manager';
import { ProviderError } from '../../provider-interface';
import type { ControlFileRead } from '../../provider-interface';
import { BUNKO_MARKER_NAME } from '../../syncable-file';
import { ingestMarkerRead, resetCloudBunkoMarkersForTest } from '$lib/catalog/cloud-bunko-marker';

type Listed = Array<Record<string, unknown>>;

function markerBody(instanceId: string, heartbeatAt = new Date().toISOString()): string {
  return JSON.stringify({
    version: 1,
    kind: 'mokuro-bunko',
    instance_id: instanceId,
    instance_name: 'nas',
    epoch: 1,
    claimed_at: '2026-10-12T09:00:00Z',
    heartbeat_at: heartbeatAt,
    ttl_s: 900,
    state: 'active',
    compiles: ['series.json', 'catalog.json'],
    ocr: true,
    queue: '.mokuro-queue.json'
  });
}

const FOLDER_QUERY = "mimeType='application/vnd.google-apps.folder'";
const isFolderQuery = (query: string) => query.includes(FOLDER_QUERY);

/**
 * Route the two queries readControlFile makes: the root folders and the
 * control-file nodes. `roots` are top-level `mokuro-reader` folders, `nested`
 * live deeper (`Backup/mokuro-reader`): a `'root' in parents` query sees only
 * the former, as Drive does.
 */
function mockDrive(opts: { roots: string[]; nested?: string[]; files: (query: string) => Listed }) {
  vi.mocked(driveApiClient.listFiles).mockImplementation((async (query: string) => {
    if (isFolderQuery(query)) {
      const top = opts.roots.map((id) => ({ id, parents: ['my-drive'] }));
      if (query.includes("'root' in parents")) return top;
      return [...top, ...(opts.nested ?? []).map((id) => ({ id, parents: ['backup'] }))];
    }
    return opts.files(query);
  }) as never);
}

const fileA = (md5 = 'md5-a', modified = '2026-10-12T09:00:00.000Z') => ({
  id: 'file-a',
  name: BUNKO_MARKER_NAME,
  md5Checksum: md5,
  modifiedTime: modified,
  parents: ['root-1']
});
const fileB = (md5 = 'md5-b', modified = '2026-10-12T09:01:00.000Z') => ({
  id: 'file-b',
  name: BUNKO_MARKER_NAME,
  md5Checksum: md5,
  modifiedTime: modified,
  parents: ['root-2']
});

const bodies: Record<string, string> = {
  'file-a': markerBody('aaa'),
  'file-b': markerBody('bbb')
};

function folderQueries() {
  return vi.mocked(driveApiClient.listFiles).mock.calls.filter(([q]) => isFolderQuery(q));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tokenManager.isAuthenticated).mockReturnValue(true);
  vi.mocked(driveFilesCache.getListedReaderFolderIds).mockReturnValue(null);
  vi.mocked(driveApiClient.downloadFile).mockImplementation(
    async (id: string) => new Blob([bodies[id] ?? ''])
  );
  resetCloudBunkoMarkersForTest();
  localStorage.clear();
  (googleDriveProvider as unknown as { resetControlFileState(): void }).resetControlFileState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GoogleDriveProvider.readControlFile()', () => {
  it('returns every duplicate node across several mokuro-reader roots, in ONE file query', async () => {
    mockDrive({ roots: ['root-1', 'root-2'], files: () => [fileA(), fileB()] });

    const result = (await googleDriveProvider.readControlFile(
      BUNKO_MARKER_NAME
    )) as ControlFileRead;

    expect(result.nodes.map((n) => n.id).sort()).toEqual(['file-a', 'file-b']);
    expect(result.nodes.find((n) => n.id === 'file-a')?.etag).toBe(
      'md5-a:2026-10-12T09:00:00.000Z'
    );
    expect(result.nodes.find((n) => n.id === 'file-a')?.modified).toBe('2026-10-12T09:00:00.000Z');
    expect(await result.nodes.find((n) => n.id === 'file-b')!.blob.text()).toBe(bodies['file-b']);

    const queries = vi.mocked(driveApiClient.listFiles).mock.calls.map(([q]) => q);
    expect(queries).toHaveLength(2); // root folders + ONE control-file query
    expect(queries[0]).toBe(
      "name='mokuro-reader' and mimeType='application/vnd.google-apps.folder' and 'me' in owners and trashed=false"
    );
    expect(queries[1]).toBe(
      `name='${BUNKO_MARKER_NAME}' and trashed=false and ('root-1' in parents or 'root-2' in parents)`
    );
    expect(vi.mocked(driveApiClient.listFiles).mock.calls[1][1]).toBe(
      'files(id,name,md5Checksum,modifiedTime,parents)'
    );
    expect(driveApiClient.downloadFile).toHaveBeenCalledTimes(2);
  });

  it('answers not-modified with no content download, and reuses the cached root ids', async () => {
    mockDrive({ roots: ['root-1', 'root-2'], files: () => [fileA(), fileB()] });
    const first = (await googleDriveProvider.readControlFile(BUNKO_MARKER_NAME)) as ControlFileRead;
    vi.mocked(driveApiClient.downloadFile).mockClear();

    const second = await googleDriveProvider.readControlFile(BUNKO_MARKER_NAME, {
      ifNoneMatch: first.etag
    });

    expect(second).toBe('not-modified');
    expect(driveApiClient.downloadFile).not.toHaveBeenCalled();
    expect(folderQueries()).toHaveLength(1); // root ids resolved once
  });

  it('re-downloads only the node whose md5/modifiedTime changed', async () => {
    let a = fileA();
    mockDrive({ roots: ['root-1', 'root-2'], files: () => [a, fileB()] });
    const first = (await googleDriveProvider.readControlFile(BUNKO_MARKER_NAME)) as ControlFileRead;
    vi.mocked(driveApiClient.downloadFile).mockClear();

    a = fileA('md5-a2', '2026-10-12T09:05:00.000Z');
    bodies['file-a'] = markerBody('aaa', '2026-10-12T09:05:00Z');
    const second = (await googleDriveProvider.readControlFile(BUNKO_MARKER_NAME, {
      ifNoneMatch: first.etag
    })) as ControlFileRead;

    expect(second.etag).not.toBe(first.etag);
    expect(vi.mocked(driveApiClient.downloadFile).mock.calls).toEqual([['file-a']]);
    expect(await second.nodes.find((n) => n.id === 'file-a')!.blob.text()).toBe(bodies['file-a']);
    bodies['file-a'] = markerBody('aaa');
  });

  it('returns null when there is no mokuro-reader folder, and never creates one', async () => {
    mockDrive({ roots: [], files: () => [] });

    await expect(googleDriveProvider.readControlFile(BUNKO_MARKER_NAME)).resolves.toBeNull();

    expect(driveApiClient.createFolder).not.toHaveBeenCalled();
    expect(vi.mocked(driveApiClient.listFiles)).toHaveBeenCalledTimes(1);
  });

  it('returns null when the folder exists but holds no such file', async () => {
    mockDrive({ roots: ['root-1'], files: () => [] });

    await expect(googleDriveProvider.readControlFile(BUNKO_MARKER_NAME)).resolves.toBeNull();
    expect(driveApiClient.createFolder).not.toHaveBeenCalled();
  });

  it('re-resolves a stale root set that yields no file (a sibling root appeared)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    let roots = ['root-1'];
    vi.mocked(driveApiClient.listFiles).mockImplementation((async (query: string) => {
      if (isFolderQuery(query)) return roots.map((id) => ({ id }));
      // The file only lives in root-2: found only when the query names it.
      return query.includes("'root-2' in parents") ? [fileB()] : [];
    }) as never);
    await expect(googleDriveProvider.readControlFile(BUNKO_MARKER_NAME)).resolves.toBeNull();

    roots = ['root-1', 'root-2'];
    // Within the recheck window the cached set is trusted...
    vi.setSystemTime(new Date('2026-10-12T10:00:30Z'));
    await expect(googleDriveProvider.readControlFile(BUNKO_MARKER_NAME)).resolves.toBeNull();
    // ...past it, the roots are re-resolved and the new root's file is found.
    vi.setSystemTime(new Date('2026-10-12T10:01:30Z'));
    const result = (await googleDriveProvider.readControlFile(
      BUNKO_MARKER_NAME
    )) as ControlFileRead;
    expect(result.nodes.map((n) => n.id)).toEqual(['file-b']);
  });

  it('reads a NESTED library root (Backup/mokuro-reader) when it is the only one', async () => {
    // pickReaderFolder makes a nested root the write root when no top-level
    // one exists, so Bunko's marker lives there.
    const nested = { ...fileA(), parents: ['nested-1'] };
    mockDrive({
      roots: [],
      nested: ['nested-1'],
      files: (q) => (q.includes("'nested-1' in parents") ? [nested] : [])
    });

    const result = (await googleDriveProvider.readControlFile(
      BUNKO_MARKER_NAME
    )) as ControlFileRead | null;

    expect(result?.nodes.map((n) => n.id)).toEqual(['file-a']);
  });

  it('reads top-level and nested roots together, in ONE file query', async () => {
    mockDrive({ roots: ['root-1'], nested: ['nested-1'], files: () => [fileA()] });

    await googleDriveProvider.readControlFile(BUNKO_MARKER_NAME);

    const queries = vi.mocked(driveApiClient.listFiles).mock.calls.map(([q]) => q);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toBe(
      `name='${BUNKO_MARKER_NAME}' and trashed=false and ('nested-1' in parents or 'root-1' in parents)`
    );
  });

  it("takes the files cache's listed reader folders without a folder query", async () => {
    vi.mocked(driveFilesCache.getListedReaderFolderIds).mockReturnValue(['root-1', 'nested-1']);
    mockDrive({ roots: [], files: () => [fileA()] });

    const result = (await googleDriveProvider.readControlFile(
      BUNKO_MARKER_NAME
    )) as ControlFileRead;

    expect(result.nodes.map((n) => n.id)).toEqual(['file-a']);
    expect(folderQueries()).toHaveLength(0);
    expect(vi.mocked(driveApiClient.listFiles).mock.calls[0][0]).toContain(
      "('nested-1' in parents or 'root-1' in parents)"
    );
  });

  it('a stale cached set that yields no file is re-resolved from Drive, not the cache', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    // The cache's listing predates the nested root Bunko writes to.
    vi.mocked(driveFilesCache.getListedReaderFolderIds).mockReturnValue(['root-1']);
    mockDrive({
      roots: ['root-1'],
      nested: ['nested-1'],
      files: (q) =>
        q.includes("'nested-1' in parents") ? [{ ...fileA(), parents: ['nested-1'] }] : []
    });
    await expect(googleDriveProvider.readControlFile(BUNKO_MARKER_NAME)).resolves.toBeNull();
    vi.setSystemTime(new Date('2026-10-12T10:01:30Z'));
    const result = (await googleDriveProvider.readControlFile(
      BUNKO_MARKER_NAME
    )) as ControlFileRead;
    expect(result.nodes.map((n) => n.id)).toEqual(['file-a']);
    expect(folderQueries()).toHaveLength(1);
  });

  it('bounds the file query: many roots are asked in a few chunked queries', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `root-${String(i).padStart(2, '0')}`);
    vi.mocked(driveFilesCache.getListedReaderFolderIds).mockReturnValue(many);
    mockDrive({
      roots: [],
      files: (q) =>
        q.includes("'root-59' in parents") ? [{ ...fileB(), parents: ['root-59'] }] : []
    });

    const result = (await googleDriveProvider.readControlFile(
      BUNKO_MARKER_NAME
    )) as ControlFileRead;

    expect(result.nodes.map((n) => n.id)).toEqual(['file-b']);
    const fileQueries = vi.mocked(driveApiClient.listFiles).mock.calls;
    expect(fileQueries).toHaveLength(3);
    for (const [q] of fileQueries)
      expect(q.split(' in parents').length - 1).toBeLessThanOrEqual(25);
  });

  it('rejects with an auth ProviderError when not authenticated', async () => {
    vi.mocked(tokenManager.isAuthenticated).mockReturnValue(false);

    const error = await googleDriveProvider.readControlFile(BUNKO_MARKER_NAME).catch((e) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.isAuthError).toBe(true);
    expect(error.code).toBe('NOT_AUTHENTICATED');
  });

  it('rejects with an auth ProviderError when the API reports an expired token (401)', async () => {
    vi.mocked(driveApiClient.listFiles).mockRejectedValue(
      Object.assign(new Error('Authentication expired. Please sign in again.'), {
        name: 'DriveApiError',
        status: 401
      })
    );

    const error = await googleDriveProvider.readControlFile(BUNKO_MARKER_NAME).catch((e) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.isAuthError).toBe(true);
    expect(error.providerType).toBe('google-drive');
  });

  it('rejects with an auth ProviderError when the content download is refused (401)', async () => {
    mockDrive({ roots: ['root-1'], files: () => [fileA()] });
    vi.mocked(driveApiClient.downloadFile).mockRejectedValue(
      Object.assign(new Error('Authentication error'), { status: 401 })
    );

    const error = await googleDriveProvider.readControlFile(BUNKO_MARKER_NAME).catch((e) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.isAuthError).toBe(true);
  });

  it('a 403 rate limit that outlasted the retries is not an auth failure', async () => {
    vi.mocked(driveApiClient.listFiles).mockRejectedValue(
      Object.assign(new Error('User rate limit exceeded'), {
        name: 'DriveApiError',
        status: 403,
        reason: 'userRateLimitExceeded'
      })
    );

    const error = await googleDriveProvider.readControlFile(BUNKO_MARKER_NAME).catch((e) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.isAuthError).toBe(false);
    expect(error.code).toBe('CONTROL_READ_FAILED');
  });

  it.each([
    ['quota', 403],
    ['rate-limit', 403],
    ['other', 401]
  ])(
    'trusts the classified kind over the status: a %s failure (%i) is not an auth error',
    async (kind, status) => {
      vi.mocked(driveApiClient.listFiles).mockRejectedValue(
        Object.assign(new Error(`[${kind}] refused`), { name: 'DriveApiError', status, kind })
      );

      const error = await googleDriveProvider.readControlFile(BUNKO_MARKER_NAME).catch((e) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect(error.isAuthError).toBe(false);
      expect(error.code).toBe('CONTROL_READ_FAILED');
    }
  );

  it('a 403 classified as auth is an auth error', async () => {
    vi.mocked(driveApiClient.listFiles).mockRejectedValue(
      Object.assign(new Error('forbidden'), { name: 'DriveApiError', status: 403, kind: 'auth' })
    );

    const error = await googleDriveProvider.readControlFile(BUNKO_MARKER_NAME).catch((e) => e);

    expect(error.isAuthError).toBe(true);
    expect(error.code).toBe('AUTH_EXPIRED');
  });

  it('wraps other failures as non-auth ProviderErrors', async () => {
    vi.mocked(driveApiClient.listFiles).mockRejectedValue(
      Object.assign(new Error('Backend Error'), { status: 500 })
    );

    const error = await googleDriveProvider.readControlFile(BUNKO_MARKER_NAME).catch((e) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.isAuthError).toBe(false);
  });
});

describe('GoogleDriveProvider.getStatus() with a cloud-direct Bunko marker', () => {
  it('turns serverCompilesMetadata true after a fresh marker read', async () => {
    expect(googleDriveProvider.getStatus().serverCompilesMetadata).toBeFalsy();
    mockDrive({ roots: ['root-1'], files: () => [fileA()] });

    await ingestMarkerRead(
      'google-drive',
      await googleDriveProvider.readControlFile(BUNKO_MARKER_NAME)
    );

    const status = googleDriveProvider.getStatus();
    expect(status.serverCompilesMetadata).toBe(true);
    expect(status.cloudBunko?.fresh).toBe(true);
    expect(status.cloudBunko?.holder?.instanceId).toBe('aaa');
  });
});
