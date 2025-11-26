import { browser } from '$app/environment';
import { GOOGLE_DRIVE_CONFIG } from '$lib/util/sync/providers/google-drive/constants';
import type { ProviderType } from './provider-interface';

/** localStorage key for tracking the active cloud provider */
export const ACTIVE_PROVIDER_KEY = 'active_cloud_provider';

/**
 * Set the active provider key in localStorage
 * Called on successful login
 */
export function setActiveProviderKey(type: ProviderType): void {
  if (!browser) return;
  localStorage.setItem(ACTIVE_PROVIDER_KEY, type);
}

/**
 * Clear the active provider key from localStorage
 * Called on logout
 */
export function clearActiveProviderKey(): void {
  if (!browser) return;
  localStorage.removeItem(ACTIVE_PROVIDER_KEY);
}

/**
 * Get the active provider key from localStorage
 */
export function getActiveProviderKey(): ProviderType | null {
  if (!browser) return null;
  const value = localStorage.getItem(ACTIVE_PROVIDER_KEY);
  if (value === 'google-drive' || value === 'mega' || value === 'webdav') {
    return value;
  }
  return null;
}

/**
 * Legacy detection: check provider credentials in localStorage
 * Used for migration of existing users who don't have the new key yet
 */
function detectProviderFromCredentials(): ProviderType | null {
  if (!browser) return null;

  // Check Google Drive auth history
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

  return null;
}

/**
 * Get the configured provider type
 *
 * First checks the explicit active_cloud_provider key, then falls back to
 * legacy credential detection (for migration of existing users).
 * If legacy detection finds a provider, it auto-sets the new key.
 */
export function getConfiguredProviderType(): ProviderType | null {
  if (!browser) return null;

  // First check the explicit active provider key
  const activeKey = getActiveProviderKey();
  if (activeKey) {
    return activeKey;
  }

  // Fall back to legacy credential detection for migration
  const legacyProvider = detectProviderFromCredentials();
  if (legacyProvider) {
    // Auto-migrate: set the new key so subsequent loads are faster
    setActiveProviderKey(legacyProvider);
    return legacyProvider;
  }

  return null;
}
