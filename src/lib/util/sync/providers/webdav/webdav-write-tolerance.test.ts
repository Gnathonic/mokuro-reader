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
  localStorage.setItem('webdav_server_url', 'https://mokuro.moe');
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
