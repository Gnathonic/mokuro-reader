import type {
  CloudProviderCore,
  CloudCoreDownloadArgs,
  CloudCoreUploadArgs
} from '../cloud-provider-core-types';

/**
 * Filesystem provider does not use the worker-based download path
 * (supportsWorkerDownload = false on FilesystemProvider).
 * This stub satisfies the exhaustive Record<ProviderType, CloudProviderCore>
 * in cloud-provider-core-registry.ts and should never be called at runtime.
 */
export const filesystemCore: CloudProviderCore = {
  downloadFile(_args: CloudCoreDownloadArgs): Promise<ArrayBuffer> {
    throw new Error('FilesystemProvider does not use worker-based downloads');
  },
  uploadFile(_args: CloudCoreUploadArgs): Promise<string> {
    throw new Error('FilesystemProvider does not use worker-based uploads');
  }
};
