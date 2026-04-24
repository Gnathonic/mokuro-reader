import { describe, it, expect, beforeEach, vi } from 'vitest';
import { onedriveCore } from '../onedrive-core';

describe('onedriveCore', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  describe('uploadFile', () => {
    it('creates an upload session and PUTs the full payload in one chunk', async () => {
      const seriesFolderPath = 'mokuro-reader/Series';
      const filename = 'v1.cbz';

      // 1st call: createUploadSession
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
      } as Response);

      // 2nd call: PUT chunk returns the completed driveItem
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'new-item-id', name: filename })
      } as Response);

      const blob = new Blob([new Uint8Array(1000)]);
      const id = await onedriveCore.uploadFile({
        seriesTitle: seriesFolderPath,
        filename,
        blob,
        credentials: { accessToken: 'TOKEN' }
      });

      expect(id).toBe('new-item-id');
      const initCall = vi.mocked(fetch).mock.calls[0];
      expect(initCall[0]).toContain(':/createUploadSession');
      const putCall = vi.mocked(fetch).mock.calls[1];
      expect(putCall[0]).toBe('https://upload.example/xyz');
      expect((putCall[1] as RequestInit).method).toBe('PUT');
      expect((putCall[1] as RequestInit).headers).toMatchObject({
        'Content-Range': 'bytes 0-999/1000',
        'Content-Length': '1000'
      });
    });

    it('splits payload into multiple chunks when larger than chunk size', async () => {
      // Session init
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
      } as Response);
      // Chunk 1 (accepted, continue)
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ nextExpectedRanges: [`${10 * 1024 * 1024}-`] })
      } as Response);
      // Chunk 2 (completed)
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'done', name: 'v1.cbz' })
      } as Response);

      const blob = new Blob([new Uint8Array(15 * 1024 * 1024)]);
      const id = await onedriveCore.uploadFile({
        seriesTitle: 'Series',
        filename: 'v1.cbz',
        blob,
        credentials: { accessToken: 'TOKEN' }
      });

      expect(id).toBe('done');
      expect(vi.mocked(fetch).mock.calls).toHaveLength(3);
      const firstChunk = vi.mocked(fetch).mock.calls[1];
      expect((firstChunk[1] as RequestInit).headers).toMatchObject({
        'Content-Range': `bytes 0-${10 * 1024 * 1024 - 1}/${15 * 1024 * 1024}`
      });
      const secondChunk = vi.mocked(fetch).mock.calls[2];
      expect((secondChunk[1] as RequestInit).headers).toMatchObject({
        'Content-Range': `bytes ${10 * 1024 * 1024}-${15 * 1024 * 1024 - 1}/${15 * 1024 * 1024}`
      });
    });

    it('throws if accessToken is missing', async () => {
      await expect(
        onedriveCore.uploadFile({
          seriesTitle: 'x',
          filename: 'y',
          blob: new Blob([]),
          credentials: {}
        })
      ).rejects.toThrow(/access token/i);
    });
  });
});
