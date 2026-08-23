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
