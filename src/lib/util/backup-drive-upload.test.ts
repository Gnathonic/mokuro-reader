import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./sync/providers/google-drive/api-client', () => ({
  driveApiClient: {},
  escapeNameForDriveQuery: (name: string) => name
}));
vi.mock('./sync/unified-cloud-manager', () => ({ unifiedCloudManager: {} }));

import { uploadCbzToDrive } from './backup';
import { uploadFile } from './cloud';

const QUOTA_BODY = JSON.stringify({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } });

describe('legacy Drive upload helpers', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('gapi', { auth: { getToken: () => ({ access_token: 'TOKEN' }) } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploadCbzToDrive retries a rate-limited session init', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(
        new Response('', { status: 200, headers: { Location: 'https://upload.example/s' } })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'cbz-id' }), { status: 200 }));

    await expect(uploadCbzToDrive(new Blob(['x']), 'v.cbz')).resolves.toBe('cbz-id');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('uploadCbzToDrive names a full account instead of a bare status', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(QUOTA_BODY, { status: 403 }));

    await expect(uploadCbzToDrive(new Blob(['x']), 'v.cbz')).rejects.toMatchObject({
      kind: 'quota'
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cloud.uploadFile retries a rate limit and rejects a full account', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'json-id' }), { status: 200 }));
    const args = {
      accessToken: 'TOKEN',
      localStorageId: 'k',
      metadata: { name: 'k.json' },
      type: 'application/json'
    };

    await expect(uploadFile(args)).resolves.toEqual({ id: 'json-id' });

    vi.mocked(fetch).mockResolvedValueOnce(new Response(QUOTA_BODY, { status: 403 }));
    await expect(uploadFile(args)).rejects.toMatchObject({ kind: 'quota' });
  });
});
