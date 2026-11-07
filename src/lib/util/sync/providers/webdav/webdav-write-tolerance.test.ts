import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('../../provider-detection', () => ({
  setActiveProviderKey: vi.fn(),
  clearActiveProviderKey: vi.fn()
}));

const uploadFile = vi.fn();
vi.mock('../../core/cloud-provider-core-registry', () => ({
  getCloudProviderCore: () => ({ uploadFile: (...args: unknown[]) => uploadFile(...args) })
}));
vi.mock('../../provider-manager', () => ({ providerManager: { updateStatus: vi.fn() } }));

import { WebDAVProvider } from './webdav-provider';

/** A provider wired past login: a client, a password session, unknown capabilities. */
function connectedProvider(): WebDAVProvider {
  const provider = new WebDAVProvider();
  const internals = provider as unknown as {
    client: unknown;
    _hasPassword: boolean;
    ensureMokuroFolder: () => Promise<void>;
    getWorkerUploadCredentials: () => Promise<unknown>;
  };
  internals.client = {};
  internals._hasPassword = true;
  internals.ensureMokuroFolder = async () => {};
  internals.getWorkerUploadCredentials = async () => ({});
  return provider;
}

beforeEach(() => {
  uploadFile.mockReset();
  localStorage.clear();
  localStorage.setItem('webdav_server_url', 'https://dav.example');
});

describe('best-effort metadata writes', () => {
  it('a rejected catalog.json PUT leaves the provider read-write', async () => {
    const provider = connectedProvider();
    uploadFile.mockRejectedValue(new Error('Request failed with status code 403'));

    await expect(provider.uploadFile('catalog.json', new Blob(['{}']))).rejects.toThrow();
    expect(provider.getStatus().isReadOnly).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(false);
  });

  it('a rejected series.json PUT leaves the provider read-write and keeps the password', async () => {
    const provider = connectedProvider();
    localStorage.setItem('webdav_password', 'hunter2');
    uploadFile.mockRejectedValue(new Error('Request failed with status code 401'));

    await expect(provider.uploadFile('Dr Stone/series.json', new Blob(['{}']))).rejects.toThrow();
    expect(provider.getStatus().isReadOnly).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(false);
    expect(localStorage.getItem('webdav_password')).toBe('hunter2');
  });

  it('still demotes on a rejected ARCHIVE upload (unchanged behaviour)', async () => {
    const provider = connectedProvider();
    uploadFile.mockRejectedValue(new Error('Request failed with status code 403'));

    await expect(provider.uploadFile('Dr Stone/Volume 1.cbz', new Blob(['zip']))).rejects.toThrow();
    expect(provider.getStatus().isReadOnly).toBe(true);
  });
});

/** A connected provider whose DELETE always fails with `message`. */
function providerWithFailingDelete(message: string): WebDAVProvider {
  const provider = connectedProvider();
  (provider as unknown as { client: unknown }).client = {
    deleteFile: async () => {
      throw new Error(message);
    }
  };
  return provider;
}

function cloudFile(path: string) {
  return {
    provider: 'webdav' as const,
    fileId: `/mokuro-reader/${path}`,
    path,
    modifiedTime: '2026-08-23T00:00:00.000Z',
    size: 10
  };
}

describe('best-effort metadata deletes', () => {
  // Real path: cleanupSeriesFileIfFolderEmptied() and moveSeriesFileAfterRename()
  // both DELETE `<Series>/series.json`. On a bunko scoped account those are
  // rejected by design, and the caller swallows the throw — so an unguarded
  // demotion here silently flips the whole provider read-only.
  it('a rejected series.json DELETE leaves the provider read-write', async () => {
    const provider = providerWithFailingDelete('Request failed with status code 405');

    await expect(provider.deleteFile(cloudFile('Dr Stone/series.json'))).rejects.toThrow();
    expect(provider.getStatus().isReadOnly).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(false);
  });

  it('a rejected catalog.json DELETE keeps the stored password', async () => {
    localStorage.setItem('webdav_password', 'hunter2');
    const provider = providerWithFailingDelete('Request failed with status code 401');

    await expect(provider.deleteFile(cloudFile('catalog.json'))).rejects.toThrow();
    expect(provider.getStatus().isReadOnly).toBe(false);
    expect(provider.getStatus().needsAttention).toBe(false);
    expect(localStorage.getItem('webdav_password')).toBe('hunter2');
  });

  it('still demotes on a rejected ARCHIVE delete (unchanged behaviour)', async () => {
    const provider = providerWithFailingDelete('Request failed with status code 403');

    await expect(provider.deleteFile(cloudFile('Dr Stone/Volume 1.cbz'))).rejects.toThrow();
    expect(provider.getStatus().isReadOnly).toBe(true);
  });
});

// bunko answers a PUT of a reserved layer id 403 by design (a case merge's
// `curated-<n>`, an account's `curated` without the rights, a 0.7.x `edit`):
// that says nothing about the account's other writes.
describe('a refused reserved layer file', () => {
  it.each(['curated-2', 'curated', 'edit', 'edit-2', 'original'])(
    'a 403 on <Vol>.%s.mokuro leaves the provider read-write and reads as a refusal',
    async (layerId) => {
      const provider = connectedProvider();
      uploadFile.mockRejectedValue(new Error('Request failed with status code 403'));

      const error = await provider
        .uploadFile(`Dr Stone/Volume 1.${layerId}.mokuro`, new Blob(['{}']))
        .catch((e) => e);
      expect(error).toMatchObject({ code: 'PERMISSION_DENIED', webdavErrorType: 'permission' });
      expect(provider.getStatus().isReadOnly).toBe(false);
      expect(provider.getStatus().needsAttention).toBe(false);
    }
  );

  it('a 403 DELETE of one leaves the provider read-write too', async () => {
    const provider = providerWithFailingDelete('Request failed with status code 403');

    const error = await provider
      .deleteFile(cloudFile('Dr Stone/Volume 1.curated.mokuro'))
      .catch((e) => e);
    expect(error).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(provider.getStatus().isReadOnly).toBe(false);
  });

  it.each(['my-fixes', 'pre-upgrade', 'previous-ocr-2'])(
    'a hand-made layer id (%s) is a library file like any other (unchanged behaviour)',
    async (layerId) => {
      const provider = connectedProvider();
      uploadFile.mockRejectedValue(new Error('Request failed with status code 403'));

      await expect(
        provider.uploadFile(`Dr Stone/Volume 1.${layerId}.mokuro`, new Blob(['{}']))
      ).rejects.toThrow();
      expect(provider.getStatus().isReadOnly).toBe(true);
    }
  );
});

describe('a 503 + Retry-After on a write', () => {
  /** A connected provider whose (wrapped) client answers every DELETE 503 + Retry-After. */
  function providerWithBusyDelete(): {
    provider: WebDAVProvider;
    deleteFile: ReturnType<typeof vi.fn>;
  } {
    const provider = connectedProvider();
    const deleteFile = vi.fn(async () => {
      throw Object.assign(new Error('Invalid response: 503 Service Unavailable'), {
        status: 503,
        response: new Response(null, { status: 503, headers: { 'Retry-After': '1' } })
      });
    });
    const internals = provider as unknown as {
      client: unknown;
      wrapClient: (raw: unknown) => unknown;
    };
    internals.client = internals.wrapClient({ deleteFile, getHeaders: () => ({}) });
    return { provider, deleteFile };
  }

  it('one the server never lifts fails the delete after two retries, provider still read-write', async () => {
    vi.useFakeTimers();
    try {
      const { provider, deleteFile } = providerWithBusyDelete();
      const done = provider.deleteFile(cloudFile('Dr Stone/Volume 1.cbz')).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await done).toMatchObject({ code: 'DELETE_FAILED' });
      expect(deleteFile).toHaveBeenCalledTimes(3);
      expect(provider.getStatus().isReadOnly).toBe(false);
      expect(provider.getStatus().needsAttention).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
