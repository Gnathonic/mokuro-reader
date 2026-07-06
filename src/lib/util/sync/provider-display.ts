import type { ProviderType } from './provider-interface';

/** Full names for headers and provider-selection screens. */
export const PROVIDER_LABELS: Record<ProviderType, string> = {
  'google-drive': 'Google Drive',
  mega: 'MEGA Cloud Storage',
  webdav: 'WebDAV Server',
  filesystem: 'Local Folder',
  onedrive: 'OneDrive'
};

/** Short names for badges and snackbars. */
export const PROVIDER_SHORT_LABELS: Record<ProviderType, string> = {
  'google-drive': 'Drive',
  mega: 'MEGA',
  webdav: 'WebDAV',
  filesystem: 'Local Folder',
  onedrive: 'OneDrive'
};

export type ProviderBadgeColor = 'blue' | 'purple' | 'green' | 'yellow' | 'indigo' | 'gray';

export const PROVIDER_BADGE_COLORS: Record<ProviderType, ProviderBadgeColor> = {
  'google-drive': 'blue',
  mega: 'purple',
  webdav: 'green',
  filesystem: 'yellow',
  onedrive: 'indigo'
};
