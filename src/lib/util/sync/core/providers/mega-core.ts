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
    const storage = await storagePromise;
    await storage.close();
  } catch (error) {
    console.warn('Worker: Failed to close MEGA upload storage:', error);
  }
}

async function getUploadStorage(email: string, password: string): Promise<Storage> {
  const sessionKey = `${email}\u0000${password}`;

  if (uploadStoragePromise && uploadSessionKey === sessionKey) {
    return await uploadStoragePromise;
  }

  if (uploadStoragePromise && uploadSessionKey !== sessionKey) {
    await resetUploadStorage();
  }

  uploadSessionKey = sessionKey;
  const pendingSession = (async () => {
    const storage = new Storage({ email, password });
    await storage.ready;
    return storage;
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

export const megaCore: CloudProviderCore = {
  async downloadFile({ credentials, onProgress }): Promise<ArrayBuffer> {
    const shareUrl = requireCredentialString(credentials, 'megaShareUrl', 'MEGA share URL');

    return await new Promise((resolve, reject) => {
      try {
        const file = MegaFile.fromURL(shareUrl);

        file.loadAttributes((error) => {
          if (error) {
            reject(new Error(`MEGA metadata failed: ${error.message}`));
            return;
          }

          const totalSize = file.size || 0;
          const stream = file.download({});
          const chunks: Uint8Array[] = [];
          let loaded = 0;

          stream.on('data', (chunk: Uint8Array) => {
            chunks.push(chunk);
            loaded += chunk.length;
            onProgress(loaded, totalSize);
          });

          stream.on('end', async () => {
            const blob = new Blob(chunks as BlobPart[]);
            const buffer = await blob.arrayBuffer();
            chunks.length = 0;
            resolve(buffer);
          });

          stream.on('error', (streamError: Error) => {
            reject(new Error(`MEGA download failed: ${streamError.message}`));
          });
        });
      } catch (error) {
        reject(
          new Error(
            `MEGA initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          )
        );
      }
    });
  },

  async uploadFile({ seriesTitle, filename, blob, credentials, onProgress }): Promise<string> {
    const email = requireCredentialString(credentials, 'megaEmail', 'MEGA credentials');
    const password = requireCredentialString(credentials, 'megaPassword', 'MEGA credentials');
    const storage = await getUploadStorage(email, password);

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
