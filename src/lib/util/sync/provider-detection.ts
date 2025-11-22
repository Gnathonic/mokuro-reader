import { browser } from '$app/environment';
import { GOOGLE_DRIVE_CONFIG } from '$lib/util/sync/providers/google-drive/constants';
import type { ProviderType } from './provider-interface';

/**
 * Synchronously check which provider (if any) has stored credentials
 * Since providers are mutually exclusive, returns the active provider type or null
 *
 * This can be called synchronously during page load to immediately show configured state
 * before async initialization completes.
 */
export function getConfiguredProviderType(): ProviderType | null {
  if (!browser) return null;

  // Check Google Drive auth history (not token validity - user needs to re-auth with expired token)
  const hasGdriveAuth =
    localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED) === 'true';
  const gdriveToken = localStorage.getItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.TOKEN);
  if (hasGdriveAuth && gdriveToken) {
    return 'google-drive';
  }

  // Check MEGA credentials
  const megaEmail = localStorage.getItem('mega_email');
  const megaPassword = localStorage.getItem('mega_password');
  if (megaEmail && megaPassword) {
    return 'mega';
  }

  // Check WebDAV credentials
  const webdavUrl = localStorage.getItem('webdav_server_url');
  const webdavUsername = localStorage.getItem('webdav_username');
  const webdavPassword = localStorage.getItem('webdav_password');
  if (webdavUrl && webdavUsername && webdavPassword) {
    return 'webdav';
  }

  return null; // No provider has credentials
}
