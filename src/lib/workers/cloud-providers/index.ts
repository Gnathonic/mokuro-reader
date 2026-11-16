import { getCloudProviderCore } from '#lib/util/sync/core/cloud-provider-core-registry.js';
import type { WorkerCloudProviderAdapter, WorkerProviderType } from './types';

export function getWorkerCloudProvider(provider: WorkerProviderType): WorkerCloudProviderAdapter {
  return getCloudProviderCore(provider);
}
