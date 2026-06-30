import { File as MegaFile, Storage } from 'megajs';
import type { CloudProviderCore } from '../cloud-provider-core-types';
import { requireCredentialString } from '../cloud-provider-core-types';

let uploadStoragePromise: Promise<Storage> | null = null;
let uploadSessionKey: string | null = null;

async function resetUploadStorage(): Promise<void> {
  const storagePromise = uploadStoragePromise;
  uploadStoragePromise = null;
  uploadSessionKey = null;
  if (!storagePromise) return;

  try {
    const storage = (await storagePromise) as any;
    // Release the keepalive/server-change poll WITHOUT terminating the session:
    // storage.close() issues {a:'sml'}, which kills the shared session sid (used by
    // the persisted token and every other storage). api.close() only aborts the poll.
    storage?.api?.close?.();
  } catch (error) {
    console.warn('Worker: Failed to release MEGA upload storage:', error);
  }
}

async function getUploadStorage(session: string): Promise<Storage> {
  const parsed = JSON.parse(session);
  const sessionKey: string = parsed.sid;

  if (uploadStoragePromise && uploadSessionKey === sessionKey) {
    return await uploadStoragePromise;
  }

  if (uploadStoragePromise && uploadSessionKey !== sessionKey) {
    await resetUploadStorage();
  }

  uploadSessionKey = sessionKey;
  const pendingSession = (async () => {
    const storage = Storage.fromJSON(parsed) as any;
    // fromJSON loads no tree; reload populates storage.root for folder navigation/upload.
    await storage.reload(true);
    return storage as Storage;
  })();
  uploadStoragePromise = pendingSession;

  try {
    return await pendingSession;
  } catch (error) {
    if (uploadStoragePromise === pendingSession) {
      uploadStoragePromise = null;
      uploadSessionKey = null;
    }
    throw error;
  }
}

// Lightweight, per-sid API instances for owned-node downloads. A Storage built with
// autologin/autoload false makes no network call and loads no tree; we only need its
// `api` (with the session id) to authorize `a:"g", n:<nodeId>` requests.
const downloadApiBySid = new Map<string, any>();

function getDownloadApi(sid: string): any {
  let api = downloadApiBySid.get(sid);
  if (!api) {
    const storage: any = new Storage({
      autologin: false,
      autoload: false,
      keepalive: false
    } as any);
    storage.api.sid = sid;
    api = storage.api;
    downloadApiBySid.set(sid, api);
  }
  return api;
}

export const megaCore: CloudProviderCore = {
  async downloadFile({ credentials, onProgress }): Promise<ArrayBuffer> {
    const sid = requireCredentialString(credentials, 'sid', 'MEGA session id');
    const nodeId = requireCredentialString(credentials, 'nodeId', 'MEGA node id');
    const fileKey = requireCredentialString(credentials, 'fileKey', 'MEGA file key');
    const api = getDownloadApi(sid);

    return await new Promise<ArrayBuffer>((resolve, reject) => {
      try {
        // formatKey(fileKey) base64url-decodes into a real megajs Buffer.
        const file: any = new MegaFile({ downloadId: nodeId, key: fileKey, api });
        // Force the owned-node download path (req.n = nodeId, authorized by api.sid).
        file.nodeId = nodeId;

        const stream = file.download({});
        const chunks: Uint8Array[] = [];

        stream.on('data', (chunk: Uint8Array) => {
          chunks.push(chunk);
        });
        stream.on('progress', (p: { bytesLoaded: number; bytesTotal: number }) => {
          onProgress(p.bytesLoaded, p.bytesTotal);
        });
        stream.on('end', async () => {
          try {
            const blob = new Blob(chunks as BlobPart[]);
            const buffer = await blob.arrayBuffer();
            chunks.length = 0;
            resolve(buffer);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        stream.on('error', (streamError: Error) => {
          reject(new Error(`MEGA download failed: ${streamError.message}`));
        });
      } catch (error) {
        reject(
          new Error(
            `MEGA download init failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          )
        );
      }
    });
  },

  async uploadFile({ seriesTitle, filename, blob, credentials, onProgress }): Promise<string> {
    const session = requireCredentialString(credentials, 'megaSession', 'MEGA session');
    const storage = await getUploadStorage(session);

    try {
      const CHUNK_SIZE = 1024 * 1024;

      let mokuroFolder = storage.root.children?.find(
        (child: any) => child.name === 'mokuro-reader' && child.directory
      );

      if (!mokuroFolder) {
        mokuroFolder = await storage.root.mkdir('mokuro-reader');
      }

      let seriesFolder = mokuroFolder.children?.find(
        (child: any) => child.name === seriesTitle && child.directory
      );

      if (!seriesFolder) {
        seriesFolder = await mokuroFolder.mkdir(seriesTitle);
      }

      const uploadStream: any = seriesFolder.upload({ name: filename, size: blob.size });
      let uploadedFileId: string | undefined;

      await new Promise<void>((resolve, reject) => {
        let offset = 0;

        uploadStream.on('progress', (stats: any) => {
          const uploaded = stats?.bytesUploaded || stats?.loaded || 0;
          const total = stats?.bytesTotal || stats?.total || blob.size;
          if (onProgress) {
            onProgress(uploaded, total);
          }
        });

        uploadStream.on('complete', (file: any) => {
          uploadedFileId = file?.nodeId || file?.id || uploadedFileId;
          resolve();
        });

        uploadStream.on('error', (error: unknown) => {
          reject(error);
        });

        const writeNextChunk = async () => {
          if (offset >= blob.size) {
            uploadStream.end();
            return;
          }

          const chunk = blob.slice(offset, Math.min(offset + CHUNK_SIZE, blob.size));
          const arrayBuffer = await chunk.arrayBuffer();
          uploadStream.write(new Uint8Array(arrayBuffer));
          offset += CHUNK_SIZE;
          setTimeout(() => writeNextChunk(), 0);
        };

        writeNextChunk();
      });

      if (!uploadedFileId) {
        throw new Error('MEGA upload succeeded but did not return file ID');
      }

      return uploadedFileId;
    } catch (error: any) {
      throw new Error(`MEGA upload failed: ${error.message || error}`);
    }
  }
};
