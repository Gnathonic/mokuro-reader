import { describe, it, expect, beforeEach, vi } from 'vitest';
import { onedriveCore } from '../onedrive-core';

describe('onedriveCore', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  describe('uploadFile', () => {
    it('creates an upload session under mokuro-reader/{series} and PUTs full payload in one chunk', async () => {
      // 1st call: createUploadSession
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
      } as Response);

      // 2nd call: PUT chunk returns the completed driveItem
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          id: 'new-item-id',
          name: 'v1.cbz',
          lastModifiedDateTime: '2026-08-27T10:00:00Z',
          size: 1000
        })
      } as Response);

      const blob = new Blob([new Uint8Array(1000)]);
      const result = await onedriveCore.uploadFile({
        seriesTitle: 'Series', // bare title — core anchors it under mokuro-reader
        filename: 'v1.cbz',
        blob,
        credentials: { accessToken: 'TOKEN' }
      });

      // The completed driveItem's SERVER mtime travels out with the result —
      // this is what lets the upload-time cache entry avoid a provisional
      // client-clock stamp.
      expect(result).toEqual({
        fileId: 'new-item-id',
        modifiedTime: '2026-08-27T10:00:00Z',
        size: 1000
      });
      const initCall = vi.mocked(fetch).mock.calls[0];
      expect(initCall[0]).toBe(
        'https://graph.microsoft.com/v1.0/me/drive/root:/mokuro-reader/Series/v1.cbz:/createUploadSession'
      );
      const putCall = vi.mocked(fetch).mock.calls[1];
      expect(putCall[0]).toBe('https://upload.example/xyz');
      expect((putCall[1] as RequestInit).method).toBe('PUT');
      expect((putCall[1] as RequestInit).headers).toMatchObject({
        'Content-Range': 'bytes 0-999/1000',
        'Content-Length': '1000'
      });
    });

    it('places root-level files (no series) directly under mokuro-reader', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
      } as Response);
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'config-id' })
      } as Response);

      await onedriveCore.uploadFile({
        seriesTitle: '', // no series — like volume-data.json or profiles.json
        filename: 'volume-data.json',
        blob: new Blob([new Uint8Array(10)]),
        credentials: { accessToken: 'TOKEN' }
      });

      const initCall = vi.mocked(fetch).mock.calls[0];
      expect(initCall[0]).toBe(
        'https://graph.microsoft.com/v1.0/me/drive/root:/mokuro-reader/volume-data.json:/createUploadSession'
      );
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
      const result = await onedriveCore.uploadFile({
        seriesTitle: 'Series',
        filename: 'v1.cbz',
        blob,
        credentials: { accessToken: 'TOKEN' }
      });

      expect(result.fileId).toBe('done');
      // The fixture's final driveItem carried no lastModifiedDateTime, so the
      // result must NOT invent one — absent means "cache entry stays provisional".
      expect(result.modifiedTime).toBeUndefined();
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

    it(
      'retries a transient 503 chunk failure, resuming from nextExpectedRanges',
      { timeout: 15000 },
      async () => {
        const CHUNK = 10 * 1024 * 1024;
        // Session init
        vi.mocked(fetch).mockResolvedValueOnce({
          ok: true,
          json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
        } as Response);
        // Chunk 1 OK (202)
        vi.mocked(fetch).mockResolvedValueOnce({
          ok: true,
          status: 202,
          json: async () => ({ nextExpectedRanges: [`${CHUNK}-`] })
        } as Response);
        // Chunk 2 fails transiently
        vi.mocked(fetch).mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          text: async () => ''
        } as Response);
        // Session status query → resume where we left off
        vi.mocked(fetch).mockResolvedValueOnce({
          ok: true,
          json: async () => ({ nextExpectedRanges: [`${CHUNK}-`] })
        } as Response);
        // Chunk 2 retry succeeds (final → 201 + driveItem)
        vi.mocked(fetch).mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({ id: 'item-after-retry' })
        } as Response);

        const blob = new Blob([new Uint8Array(CHUNK + 100)]);
        const result = await onedriveCore.uploadFile({
          seriesTitle: 'S',
          filename: 'v.cbz',
          blob,
          credentials: { accessToken: 'TOKEN' }
        });
        expect(result.fileId).toBe('item-after-retry');
        // init + chunk1 + failed chunk2 + status query + retried chunk2
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(5);
      }
    );

    it(
      'gives up after repeated transient failures with a descriptive error',
      { timeout: 30000 },
      async () => {
        vi.mocked(fetch).mockResolvedValueOnce({
          ok: true,
          json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
        } as Response);
        // Every subsequent call (chunk PUTs and status queries) fails
        vi.mocked(fetch).mockResolvedValue({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          text: async () => '',
          json: async () => ({})
        } as Response);

        const blob = new Blob([new Uint8Array(100)]);
        await expect(
          onedriveCore.uploadFile({
            seriesTitle: 'S',
            filename: 'v.cbz',
            blob,
            credentials: { accessToken: 'TOKEN' }
          })
        ).rejects.toThrow(/after 5 attempts/i);
      }
    );

    // Every chunk PUT failed, then the lost-ack probe found a file of the same
    // size at the path. That may be THIS write, or the old file (a
    // positions.json whose page changed but not its length), or another
    // device's same-size write: nothing here tells them apart. The receipt
    // must not hand out that item's change token, or the root-file memo would
    // bind OUR bytes to its revision and stop reading the real file.
    it(
      'a write recovered by the lost-ack probe reports no revision and no server mtime',
      { timeout: 30000 },
      async () => {
        vi.mocked(fetch).mockImplementation((async (input: unknown, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith(':/createUploadSession')) {
            return { ok: true, json: async () => ({ uploadUrl: 'https://upload.example/xyz' }) };
          }
          if (url === 'https://upload.example/xyz' && init?.method === 'PUT') {
            throw new TypeError('network error');
          }
          if (url === 'https://upload.example/xyz') {
            return { ok: false, text: async () => '' }; // resume probe: no answer
          }
          // The lost-ack probe: whatever item sits at the path, same size.
          return {
            ok: true,
            json: async () => ({
              id: 'positions-id',
              size: 10,
              lastModifiedDateTime: '2026-11-01T09:00:00Z',
              cTag: 'ctag-already-there',
              eTag: 'etag-already-there'
            })
          };
        }) as unknown as typeof fetch);

        const result = await onedriveCore.uploadFile({
          seriesTitle: '',
          filename: 'positions.json',
          blob: new Blob([new Uint8Array(10)]),
          credentials: { accessToken: 'TOKEN' }
        });

        expect(result).toEqual({ fileId: 'positions-id', size: 10 });
        expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe(
          'https://graph.microsoft.com/v1.0/me/drive/root:/mokuro-reader/positions.json'
        );
      }
    );

    it('a final chunk that answered carries its revision (cTag, else eTag)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
      } as Response);
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'p', size: 10, cTag: 'ctag-ours', eTag: 'etag-ours' })
      } as Response);

      const result = await onedriveCore.uploadFile({
        seriesTitle: '',
        filename: 'positions.json',
        blob: new Blob([new Uint8Array(10)]),
        credentials: { accessToken: 'TOKEN' }
      });

      expect(result.revision).toBe('ctag-ours');
    });

    it('fails fast on a non-retryable 4xx without retrying', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
      } as Response);
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'invalid range'
      } as Response);

      const blob = new Blob([new Uint8Array(100)]);
      await expect(
        onedriveCore.uploadFile({
          seriesTitle: 'S',
          filename: 'v.cbz',
          blob,
          credentials: { accessToken: 'TOKEN' }
        })
      ).rejects.toThrow(/400/);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2); // no retry
    });

    it('fails a 507 session creation at once — a full drive is never retried', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 507,
        statusText: 'Insufficient Storage',
        text: async () => JSON.stringify({ error: { code: 'insufficientStorage' } }),
        headers: new Headers()
      } as Response);

      await expect(
        onedriveCore.uploadFile({
          seriesTitle: 'S',
          filename: 'v.cbz',
          blob: new Blob([new Uint8Array(10)]),
          credentials: { accessToken: 'TOKEN' }
        })
      ).rejects.toThrow(/storage full \(507 insufficientStorage\)/);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('names quotaLimitReached from a session-creation body', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => JSON.stringify({ error: { code: 'quotaLimitReached' } }),
        headers: new Headers()
      } as Response);

      await expect(
        onedriveCore.uploadFile({
          seriesTitle: 'S',
          filename: 'v.cbz',
          blob: new Blob([new Uint8Array(10)]),
          credentials: { accessToken: 'TOKEN' }
        })
      ).rejects.toThrow(/quotaLimitReached/);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });

    it('fails a 507 chunk at once, without retries or a completed-upload probe', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
      } as Response);
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 507,
        statusText: 'Insufficient Storage',
        text: async () => '',
        headers: new Headers()
      } as Response);

      await expect(
        onedriveCore.uploadFile({
          seriesTitle: 'S',
          filename: 'v.cbz',
          blob: new Blob([new Uint8Array(10)]),
          credentials: { accessToken: 'TOKEN' }
        })
      ).rejects.toThrow(/storage full \(507/);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });

    it('consumes 202 response bodies (no unread streams)', async () => {
      const CHUNK = 10 * 1024 * 1024;
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ uploadUrl: 'https://upload.example/xyz' })
      } as Response);
      const json202 = vi.fn(async () => ({ nextExpectedRanges: [`${CHUNK}-`] }));
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: json202
      } as unknown as Response);
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'done' })
      } as Response);

      await onedriveCore.uploadFile({
        seriesTitle: 'S',
        filename: 'v.cbz',
        blob: new Blob([new Uint8Array(CHUNK + 1)]),
        credentials: { accessToken: 'TOKEN' }
      });
      expect(json202).toHaveBeenCalled();
    });
  });
});
