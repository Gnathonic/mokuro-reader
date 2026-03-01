import type { CloudCoreProviderType, CloudProviderCore } from './cloud-provider-core-types';
import { googleDriveCore } from './providers/google-drive-core';
import { webdavCore } from './providers/webdav-core';
import { megaCore } from './providers/mega-core';

const coreRegistry: Record<CloudCoreProviderType, CloudProviderCore> = {
  'google-drive': googleDriveCore,
  webdav: webdavCore,
  mega: megaCore
};

export function getCloudProviderCore(provider: CloudCoreProviderType): CloudProviderCore {
  return coreRegistry[provider];
}
