import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import {
  getDriveQuota,
  listChildren,
  createFolder,
  deleteItem,
  patchItem,
  createUploadSession,
  getItemByPath
} from '../graph-client';
import { ProviderError } from '../../../provider-interface';
import { onedriveTokenManager } from '../token-manager';

const BASE = 'https://graph.microsoft.com/v1.0';

describe('graph-client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  describe('getDriveQuota', () => {
    it('returns quota object from /me/drive', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ quota: { used: 100, total: 1000, remaining: 900 } })
      } as Response);

      const quota = await getDriveQuota('TOKEN');

      expect(quota).toEqual({ used: 100, total: 1000, remaining: 900 });
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(`${BASE}/me/drive`);
      expect((call[1] as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer TOKEN'
      });
    });

    it('throws on non-ok response', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => ''
      } as Response);

      await expect(getDriveQuota('TOKEN')).rejects.toThrow(/401/);
    });
  });

  describe('listChildren', () => {
    it('fetches children of a path', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          value: [
            { id: 'a', name: 'Series', folder: {} },
            { id: 'b', name: 'v1.cbz', file: {}, size: 100, lastModifiedDateTime: 'x' }
          ]
        })
      } as Response);

      const items = await listChildren('TOKEN', 'mokuro-reader');

      expect(items).toHaveLength(2);
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(`${BASE}/me/drive/root:/mokuro-reader:/children`);
    });

    it('returns empty array for an empty folder', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ value: [] })
      } as Response);
      expect(await listChildren('TOKEN', 'x')).toEqual([]);
    });

    it('URL-encodes path segments', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ value: [] })
      } as Response);
      await listChildren('TOKEN', 'mokuro-reader/Test Series');
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toContain('Test%20Series');
    });

    it('follows @odata.nextLink to page through large folders', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: [{ id: '1', name: 'a.cbz', file: {} }],
            '@odata.nextLink': `${BASE}/me/drive/root:/x:/children?$skiptoken=PAGE2`
          })
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ value: [{ id: '2', name: 'b.cbz', file: {} }] })
        } as Response);

      const items = await listChildren('TOKEN', 'mokuro-reader');

      // All children across both pages are returned, in order.
      expect(items.map((i) => i.id)).toEqual(['1', '2']);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      // The second request goes to the nextLink URL verbatim...
      expect(vi.mocked(fetch).mock.calls[1][0]).toBe(
        `${BASE}/me/drive/root:/x:/children?$skiptoken=PAGE2`
      );
      // ...and still carries the auth header.
      expect((vi.mocked(fetch).mock.calls[1][1] as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer TOKEN'
      });
    });
  });

  describe('getItemByPath', () => {
    it('returns the item when found', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'abc', name: 'thing' })
      } as Response);
      const item = await getItemByPath('TOKEN', 'mokuro-reader');
      expect(item).toEqual({ id: 'abc', name: 'thing' });
    });

    it('returns null on 404', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => ''
      } as Response);
      const item = await getItemByPath('TOKEN', 'missing');
      expect(item).toBeNull();
    });
  });

  describe('createFolder', () => {
    it('POSTs to children with folder facet', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'new-folder', name: 'mokuro-reader' })
      } as Response);

      const item = await createFolder('TOKEN', '', 'mokuro-reader');

      expect(item.id).toBe('new-folder');
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(`${BASE}/me/drive/root/children`);
      expect((call[1] as RequestInit).method).toBe('POST');
      expect(JSON.parse((call[1] as RequestInit).body as string)).toMatchObject({
        name: 'mokuro-reader',
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail'
      });
    });

    it('creates a nested folder under an existing path', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'nested' })
      } as Response);

      await createFolder('TOKEN', 'mokuro-reader', 'Series X');

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(`${BASE}/me/drive/root:/mokuro-reader:/children`);
    });
  });

  describe('deleteItem', () => {
    it('DELETEs /items/{id}', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 204 } as Response);

      await deleteItem('TOKEN', 'item-id-123');

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(`${BASE}/me/drive/items/item-id-123`);
      expect((call[1] as RequestInit).method).toBe('DELETE');
    });

    it('treats 404 as success (idempotent delete)', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => ''
      } as Response);
      await expect(deleteItem('TOKEN', 'missing')).resolves.toBeUndefined();
    });
  });

  describe('patchItem', () => {
    it('PATCHes /items/{id} with name/parent body', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'item', name: 'new-name' })
      } as Response);

      await patchItem('TOKEN', 'item', { name: 'new-name', parentReference: { id: 'parent' } });

      const call = vi.mocked(fetch).mock.calls[0];
      expect((call[1] as RequestInit).method).toBe('PATCH');
      expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
        name: 'new-name',
        parentReference: { id: 'parent' }
      });
    });
  });

  describe('createUploadSession', () => {
    it('POSTs to createUploadSession and returns uploadUrl', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ uploadUrl: 'https://upload.microsoft.com/xyz' })
      } as Response);

      const url = await createUploadSession('TOKEN', 'mokuro-reader/Series/v1.cbz');

      expect(url).toBe('https://upload.microsoft.com/xyz');
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toBe(
        `${BASE}/me/drive/root:/mokuro-reader/Series/v1.cbz:/createUploadSession`
      );
    });
  });

  describe('error classification', () => {
    it('throws ProviderError with isAuthError on 401 and flags needsAttention', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'token expired'
      } as Response);

      const err = await getDriveQuota('TOKEN').catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.isAuthError).toBe(true);
      expect(err.code).toBe('GRAPH_401');

      let attention = false;
      onedriveTokenManager.needsAttention.subscribe((v) => (attention = v))();
      expect(attention).toBe(true);
    });

    it('marks 429 and 5xx as network errors (retryable), not auth errors', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => ''
      } as Response);

      const err = await getDriveQuota('TOKEN').catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.isNetworkError).toBe(true);
      expect(err.isAuthError).toBe(false);
    });

    it('keeps the Graph <status> message shape for not-found sniffing', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => ''
      } as Response);
      // listChildren (not getItemByPath, which maps 404 to null)
      await expect(listChildren('TOKEN', 'mokuro-reader/x')).rejects.toThrow(/404/);
    });
  });
});
