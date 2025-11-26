<script lang="ts">
  import { run } from 'svelte/legacy';

  import { profiles } from '$lib/settings';
  import { miscSettings, updateMiscSetting } from '$lib/settings/misc';

  import {
    promptConfirmation,
    showSnackbar,
    accessTokenStore,
    tokenClientStore,
    syncReadProgress,
    READER_FOLDER,
    CLIENT_ID,
    API_KEY
  } from '$lib/util';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import type { ProviderType, StorageQuota } from '$lib/util/sync/provider-interface';
  import { backupQueue } from '$lib/util/backup-queue';
  import { driveState, tokenManager } from '$lib/util/sync/providers/google-drive';
  import type { DriveState } from '$lib/util/sync/providers/google-drive';
  import { progressTrackerStore } from '$lib/util/progress-tracker';
  import { get } from 'svelte/store';
  import { Badge, Button, Radio, Toggle, Spinner } from 'flowbite-svelte';
  import { onMount } from 'svelte';
  import { GoogleSolid } from 'flowbite-svelte-icons';
  import { catalog } from '$lib/catalog';
  import type { VolumeMetadata } from '$lib/types';

  // Import multi-provider sync
  // Note: Provider instances are lazy-loaded via providerManager.getOrLoadProvider()
  import { providerManager } from '$lib/util/sync';
  import { queueVolumesFromCloudFiles } from '$lib/util/download-queue';
  import { unifiedSyncService } from '$lib/util/sync/unified-sync-service';
  import { cacheManager } from '$lib/util/sync/cache-manager';

  // Get store references for auto-subscription
  const providerStatusStore = providerManager.status;
  const cacheIsFetchingStore = cacheManager.isFetchingState;

  // Use Svelte's derived runes for automatic store subscriptions
  let accessToken = $derived($accessTokenStore);
  // Note: readerFolderId, volumeDataId, profilesId removed - legacy Drive-specific stores (now use unified provider system)
  let tokenClient = $derived($tokenClientStore);
  let driveStateValue = $derived($driveState);
  let cacheIsFetching = $derived($cacheIsFetchingStore);

  // Reactive provider authentication checks - now using provider manager for all providers
  // Use derived to reactively compute auth states from the status store
  let googleDriveAuth = $derived(
    $providerStatusStore.providers['google-drive']?.isAuthenticated || false
  );
  let megaAuth = $derived($providerStatusStore.providers['mega']?.isAuthenticated || false);
  let webdavAuth = $derived($providerStatusStore.providers['webdav']?.isAuthenticated || false);

  // Use active_cloud_provider key (via currentProviderType) for UI state
  // This properly clears on logout unlike hasStoredCredentials
  let currentProvider = $derived<ProviderType | null>($providerStatusStore.currentProviderType);

  // Show provider UI if there's an active provider
  let hasAnyProvider = $derived(currentProvider !== null);

  // Provider display names
  const providerNames: Record<ProviderType, string> = {
    'google-drive': 'Google Drive',
    mega: 'MEGA Cloud Storage',
    webdav: 'WebDAV Server'
  };

  // Provider info
  const providerInfo = {
    'google-drive': {
      items: [
        '15GB free storage',
        'Seamless Google account integration',
        'Back up from app, download on any device',
        'Auto re-authentication support'
      ]
    },
    mega: {
      items: [
        '20GB free storage',
        'End-to-end encryption',
        'Persistent login (no re-authentication needed)'
      ]
    },
    webdav: {
      items: [
        'Compatible with Nextcloud, ownCloud, and NAS devices',
        'Persistent login (no re-authentication needed)',
        'Self-hosted and private'
      ]
    }
  };

  // Google Drive login state
  let googleDriveLoading = $state(false);

  // MEGA login state
  let megaEmail = $state('');
  let megaPassword = $state('');
  let megaLoading = $state(false);

  // WebDAV login state
  let webdavUrl = $state('');
  let webdavUsername = $state('');
  let webdavPassword = $state('');
  let webdavLoading = $state(false);

  // Storage quota state
  let storageQuota = $state<StorageQuota | null>(null);
  let quotaLoading = $state(false);

  /**
   * Format bytes to human-readable string
   */
  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Fetch storage quota from the active provider
   */
  async function fetchStorageQuota() {
    const provider = providerManager.getActiveProvider();
    if (!provider) return;

    quotaLoading = true;
    try {
      storageQuota = await provider.getStorageQuota();
    } catch (error) {
      console.error('Failed to fetch storage quota:', error);
      storageQuota = null;
    } finally {
      quotaLoading = false;
    }
  }

  // Reactively fetch storage quota when provider auth state changes
  $effect(() => {
    // Track auth state for any provider
    const isAuthenticated = googleDriveAuth || megaAuth || webdavAuth;

    if (isAuthenticated) {
      fetchStorageQuota();
    } else {
      storageQuota = null;
    }
  });

  // Use constants from the google-drive utility
  const type = 'application/json';

  // Error handler for Google Drive operations
  function handleDriveError(error: unknown, context: string): void {
    console.error(`Google Drive error (${context}):`, error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    showSnackbar(`Failed ${context}: ${message}`);
  }

  // Function to clear service worker cache for Google Drive downloads
  async function clearServiceWorkerCache() {
    if ('caches' in window) {
      try {
        console.log('Clearing service worker cache for Google Drive downloads...');

        // Get all cache keys
        const cacheKeys = await caches.keys();
        console.log('Found caches:', cacheKeys);

        for (const cacheName of cacheKeys) {
          const cache = await caches.open(cacheName);

          // Get all cache entries
          const requests = await cache.keys();
          console.log(`Cache ${cacheName} has ${requests.length} entries`);

          // Filter for Google Drive API requests
          const driveRequests = requests.filter(
            (request) =>
              request.url.includes('googleapis.com/drive') || request.url.includes('alt=media')
          );

          console.log(
            `Found ${driveRequests.length} Google Drive API requests in cache ${cacheName}`
          );

          // Delete each Google Drive API request from the cache
          for (const request of driveRequests) {
            console.log(`Deleting cached request: ${request.url}`);
            await cache.delete(request);
          }
        }

        console.log('Service worker cache cleared for Google Drive downloads');
      } catch (error) {
        console.error('Error clearing service worker cache:', error);
      }
    }
  }

  async function createPicker() {
    try {
      // Lazy-load Google Drive provider for file picker functionality
      const provider = await providerManager.getOrLoadProvider('google-drive');
      // Cast to access Drive-specific methods
      const driveProvider = provider as typeof provider & {
        showFilePicker: () => Promise<
          Array<{ id: string; name: string | undefined; mimeType: string | undefined }>
        >;
        getCloudFileMetadata: (
          files: Array<{ id: string; name: string | undefined; mimeType: string | undefined }>
        ) => Promise<import('$lib/util/sync/provider-interface').CloudFileMetadata[]>;
      };

      // Use provider's file picker - it handles all the Drive-specific logic
      const pickedFiles = await driveProvider.showFilePicker();

      if (pickedFiles.length === 0) {
        return; // User cancelled or no files selected
      }

      // Fetch full metadata from Drive API
      const cloudFiles = await driveProvider.getCloudFileMetadata(pickedFiles);

      // Queue volumes for download via the unified queue system
      queueVolumesFromCloudFiles(cloudFiles);

      showSnackbar(
        `Queued ${cloudFiles.length} file${cloudFiles.length === 1 ? '' : 's'} for download`
      );
    } catch (error) {
      handleDriveError(error, 'selecting files');
    }
  }

  let isSyncingProfiles = $state(false);

  async function syncProfiles() {
    console.log('🔘 Sync profiles button clicked');
    const provider = providerManager.getActiveProvider();
    if (!provider) {
      showSnackbar('No cloud provider connected');
      return;
    }

    console.log('🔘 Provider found:', provider.name);
    isSyncingProfiles = true;
    try {
      // Sync profiles using smart merge logic
      console.log('🔘 Calling unifiedSyncService.syncProvider with syncProfiles: true');
      await unifiedSyncService.syncProvider(provider, { syncProfiles: true, silent: false });
      console.log('🔘 Sync completed successfully');
      showSnackbar('Profiles synced');
    } catch (error) {
      console.error('Profile sync error:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      showSnackbar(`Sync failed: ${message}`);
    } finally {
      isSyncingProfiles = false;
    }
  }

  // For backward compatibility with the button in the cloud page
  async function performSync() {
    await syncReadProgress();
  }

  /**
   * Common post-login handler for all providers
   * Automatically syncs progress after successful login
   * (Storage quota is fetched reactively via $effect when auth state changes)
   */
  async function handlePostLogin() {
    try {
      await performSync();
    } catch (error) {
      // Silently catch sync errors - don't block successful login
      console.error('Post-login sync failed:', error);
    }
  }

  onMount(async () => {
    // Clear service worker cache for Google Drive downloads
    // This is cloud-page-specific and not part of global init
    clearServiceWorkerCache();
    // Storage quota is fetched reactively via $effect when auth state changes

    // Pre-fill WebDAV form fields from last session (Issue #206 Lesson #10)
    try {
      const webdavProviderInstance = await providerManager.getOrLoadProvider('webdav');
      const lastUrl = (webdavProviderInstance as any).getLastServerUrl?.();
      const lastUsername = (webdavProviderInstance as any).getLastUsername?.();
      if (lastUrl) webdavUrl = lastUrl;
      if (lastUsername) webdavUsername = lastUsername;
    } catch {
      // Provider not loadable, ignore
    }
  });

  // Google Drive handlers
  async function handleGoogleDriveLogin() {
    googleDriveLoading = true;
    try {
      // Lazy-load Google Drive provider and login (handles OAuth popup + waiting + key setting)
      const googleDriveProvider = await providerManager.getOrLoadProvider('google-drive');
      await googleDriveProvider.login();

      // Set as current provider (auto-logs out any other provider)
      await providerManager.setCurrentProvider(googleDriveProvider);

      // Populate unified cache for rest of app to use
      showSnackbar('Connected to Google Drive - loading cloud data...');
      await unifiedCloudManager.fetchAllCloudVolumes();

      // Update status after cache loads to ensure UI shows "Connected"
      providerManager.updateStatus();
      showSnackbar('Google Drive connected');

      // Automatically sync after login
      await handlePostLogin();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed';
      showSnackbar(message);
    } finally {
      googleDriveLoading = false;
    }
  }

  // MEGA handlers
  async function handleMegaLogin() {
    megaLoading = true;
    try {
      // Lazy-load MEGA provider
      const megaProvider = await providerManager.getOrLoadProvider('mega');
      await megaProvider.login({ email: megaEmail, password: megaPassword });

      // Set as current provider (auto-logs out any other provider)
      await providerManager.setCurrentProvider(megaProvider);

      // Populate unified cache for rest of app to use
      showSnackbar('Connected to MEGA - loading cloud data...');
      await unifiedCloudManager.fetchAllCloudVolumes();

      // Update status after cache loads to ensure UI shows "Connected"
      providerManager.updateStatus();
      showSnackbar('MEGA connected');

      // Clear form and trigger reactivity
      megaEmail = '';
      megaPassword = '';

      // Automatically sync after login
      await handlePostLogin();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      showSnackbar(message);
    } finally {
      megaLoading = false;
    }
  }

  // Unified logout handler - all providers use providerManager.logout()
  // (Storage quota is cleared reactively via $effect when auth state changes)
  async function handleLogout() {
    const provider = currentProvider;

    // Use providerManager.logout() for all providers
    // This properly clears currentProvider, active_cloud_provider key, and updates status
    await providerManager.logout();

    // Provider-specific cleanup
    if (provider === 'mega') {
      megaEmail = '';
      megaPassword = '';
      showSnackbar('Logged out of MEGA');
    } else if (provider === 'webdav') {
      webdavPassword = '';
      showSnackbar('Logged out of WebDAV');
    } else if (provider === 'google-drive') {
      showSnackbar('Logged out of Google Drive');
    }
  }

  async function handleProviderSync() {
    try {
      // Use unified sync service - handles merge logic, deletion tracking, and tombstone purging
      await unifiedCloudManager.syncProgress();
      showSnackbar('Synced read progress');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      showSnackbar(`Sync failed: ${message}`);
    }
  }

  // WebDAV handlers
  async function handleWebDAVLogin() {
    webdavLoading = true;
    try {
      // Lazy-load WebDAV provider
      const webdavProvider = await providerManager.getOrLoadProvider('webdav');
      await webdavProvider.login({
        serverUrl: webdavUrl,
        username: webdavUsername,
        password: webdavPassword
      });

      // Set as current provider (auto-logs out any other provider)
      await providerManager.setCurrentProvider(webdavProvider);

      // Populate unified cache for rest of app to use
      showSnackbar('Connected to WebDAV - loading cloud data...');
      await unifiedCloudManager.fetchAllCloudVolumes();
      showSnackbar('WebDAV connected');

      // Clear form and trigger reactivity
      webdavUrl = '';
      webdavUsername = '';
      webdavPassword = '';

      // Automatically sync after login
      await handlePostLogin();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      showSnackbar(message);
    } finally {
      webdavLoading = false;
    }
  }

  // Browser detection and settings URL generation
  function getBrowserInfo() {
    const ua = navigator.userAgent;
    const isChrome = /Chrome/.test(ua) && /Google Inc/.test(navigator.vendor);
    const isEdge = /Edg/.test(ua);
    const isFirefox = /Firefox/.test(ua);
    const isSafari = /Safari/.test(ua) && !/Chrome/.test(ua);

    // Get current site URL for settings
    const siteUrl = encodeURIComponent(window.location.origin);

    if (isEdge) {
      return {
        name: 'Edge',
        settingsUrl: `edge://settings/content/siteDetails?site=${siteUrl}`,
        instructions: [
          'Click the link below to copy the Edge settings URL',
          'Paste it into your address bar and press Enter',
          'Toggle "Pop-ups and redirects" to "Allow"',
          'Return here and click the test button to verify'
        ]
      };
    } else if (isChrome) {
      return {
        name: 'Chrome',
        settingsUrl: `chrome://settings/content/siteDetails?site=${siteUrl}`,
        instructions: [
          'Click the link below to copy the Chrome settings URL',
          'Paste it into your address bar and press Enter',
          'Toggle "Pop-ups and redirects" to "Allow"',
          'Return here and click the test button to verify'
        ]
      };
    } else if (isFirefox) {
      return {
        name: 'Firefox',
        settingsUrl: 'about:preferences#privacy',
        instructions: [
          'Click the permissions icon (🔒) in the address bar',
          'Find "Open pop-up windows" and change to "Allow"',
          'Or: Settings → Privacy & Security → Permissions → Pop-ups → Exceptions'
        ]
      };
    } else if (isSafari) {
      return {
        name: 'Safari',
        settingsUrl: null,
        instructions: [
          'Safari → Settings → Websites → Pop-up Windows',
          'Find this website in the list',
          'Change setting to "Allow"'
        ]
      };
    } else {
      return {
        name: 'Unknown',
        settingsUrl: null,
        instructions: [
          'Click the popup blocked icon in your address bar',
          'Select "Always allow popups from this site"',
          'Click the test button below to verify it works'
        ]
      };
    }
  }

  let browserInfo = $derived(getBrowserInfo());

  async function backupAllSeries() {
    // Get default provider
    const provider = unifiedCloudManager.getDefaultProvider();
    if (!provider) {
      showSnackbar('Please connect to a cloud storage provider first');
      return;
    }

    // Get all volumes from catalog
    const allVolumes: VolumeMetadata[] = [];
    if ($catalog) {
      for (const series of $catalog) {
        allVolumes.push(...series.volumes);
      }
    }

    if (allVolumes.length === 0) {
      showSnackbar('No volumes to backup');
      return;
    }

    // Filter out already backed up volumes
    const volumesToBackup = allVolumes.filter(
      (vol) => !unifiedCloudManager.existsInCloud(vol.series_title, vol.volume_title)
    );

    const skippedCount = allVolumes.length - volumesToBackup.length;

    if (volumesToBackup.length === 0) {
      showSnackbar('All volumes already backed up');
      return;
    }

    // Add all volumes to the backup queue
    backupQueue.queueSeriesVolumesForBackup(volumesToBackup, provider);

    // Show notification
    const message =
      skippedCount > 0
        ? `Added ${volumesToBackup.length} volumes to backup queue (${skippedCount} already backed up)`
        : `Added ${volumesToBackup.length} volumes to backup queue`;
    showSnackbar(message);
  }
</script>

<svelte:head>
  <title>Cloud</title>
</svelte:head>

<div class="h-[90svh] p-2">
  {#if !hasAnyProvider}
    <!-- Provider Selection Screen (like sign-in options) -->
    <div class="flex justify-center pt-0 sm:pt-20">
      <div class="w-full max-w-md">
        <h2 class="mb-8 text-center text-2xl font-semibold">Choose a Cloud Storage Provider</h2>

        <div class="flex flex-col gap-3">
          <!-- Google Drive Option -->
          <button
            class="border-opacity-50 w-full rounded-lg border border-slate-600 p-6 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            onclick={handleGoogleDriveLogin}
            disabled={googleDriveLoading}
          >
            <div class="flex items-center gap-4">
              {#if googleDriveLoading}
                <Spinner size="8" />
              {:else}
                <GoogleSolid size="xl" />
              {/if}
              <div class="flex-1 text-left">
                <div class="text-lg font-semibold">Google Drive</div>
                <div class="text-sm text-gray-400">15GB free • Requires re-auth every hour</div>
              </div>
            </div>
          </button>

          <!-- MEGA Option -->
          <button
            class="border-opacity-50 w-full rounded-lg border border-slate-600 p-6 transition-colors hover:bg-slate-800"
            onclick={() => {
              // Show MEGA login form
              const megaForm = document.getElementById('mega-login-form');
              if (megaForm) megaForm.classList.toggle('hidden');
            }}
          >
            <div class="flex items-center gap-4">
              <div class="flex h-8 w-8 items-center justify-center text-2xl">M</div>
              <div class="flex-1 text-left">
                <div class="text-lg font-semibold">MEGA</div>
                <div class="text-sm text-gray-400">20GB free • Persistent login</div>
              </div>
            </div>
          </button>

          <div id="mega-login-form" class="hidden pr-4 pb-4 pl-12">
            <form
              onsubmit={(e) => {
                e.preventDefault();
                handleMegaLogin();
              }}
              class="flex flex-col gap-3"
            >
              <input
                type="email"
                bind:value={megaEmail}
                placeholder="Email"
                required
                class="rounded-lg border border-gray-600 bg-gray-700 p-2.5 text-sm text-white"
              />
              <input
                type="password"
                bind:value={megaPassword}
                placeholder="Password"
                required
                class="rounded-lg border border-gray-600 bg-gray-700 p-2.5 text-sm text-white"
              />
              <Button type="submit" disabled={megaLoading} color="blue" size="sm">
                {megaLoading ? 'Connecting...' : 'Connect to MEGA'}
              </Button>
            </form>
          </div>

          <!-- WebDAV Option -->
          <button
            class="border-opacity-50 w-full rounded-lg border border-slate-600 p-6 transition-colors hover:bg-slate-800"
            onclick={() => {
              const webdavForm = document.getElementById('webdav-login-form');
              if (webdavForm) webdavForm.classList.toggle('hidden');
            }}
          >
            <div class="flex items-center gap-4">
              <div class="flex h-8 w-8 items-center justify-center text-2xl">W</div>
              <div class="flex-1 text-left">
                <div class="text-lg font-semibold">WebDAV</div>
                <div class="text-sm text-gray-400">Nextcloud, ownCloud, NAS • Persistent login</div>
              </div>
            </div>
          </button>

          <div id="webdav-login-form" class="hidden pr-4 pb-4 pl-12">
            <form
              onsubmit={(e) => {
                e.preventDefault();
                handleWebDAVLogin();
              }}
              class="flex flex-col gap-3"
            >
              <input
                type="url"
                bind:value={webdavUrl}
                placeholder="Server URL (e.g., https://cloud.example.com/remote.php/dav)"
                required
                class="rounded-lg border border-gray-600 bg-gray-700 p-2.5 text-sm text-white"
              />
              <input
                type="text"
                bind:value={webdavUsername}
                placeholder="Username (optional for some servers)"
                class="rounded-lg border border-gray-600 bg-gray-700 p-2.5 text-sm text-white"
              />
              <input
                type="password"
                bind:value={webdavPassword}
                placeholder="Password or App Token"
                class="rounded-lg border border-gray-600 bg-gray-700 p-2.5 text-sm text-white"
              />
              <Button type="submit" disabled={webdavLoading} color="blue" size="sm">
                {webdavLoading ? 'Connecting...' : 'Connect to WebDAV'}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  {:else}
    <!-- Unified Connected Provider Interface -->
    {#if currentProvider}
      <div class="flex flex-col items-center justify-center gap-6">
        <div class="w-full max-w-3xl">
          <!-- Header with provider name and logout -->
          <div class="mb-6 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <h2 class="text-3xl font-semibold">{providerNames[currentProvider]}</h2>
              {#if $providerStatusStore.providers[currentProvider]?.needsAttention}
                <Badge color="red">Action Required</Badge>
              {:else if !$providerStatusStore.providers[currentProvider]?.isAuthenticated}
                <Badge color="yellow">Initializing...</Badge>
              {:else if currentProvider === 'google-drive' && cacheIsFetching}
                <Badge color="yellow">Loading Drive data...</Badge>
              {:else}
                <Badge color="green">Connected</Badge>
              {/if}
            </div>
            <Button color="red" onclick={handleLogout}>Log out</Button>
          </div>

          <div class="flex flex-col gap-4">
            <!-- Provider-specific instructions -->
            {#if currentProvider === 'google-drive'}
              <p class="text-center text-gray-300">
                Back up volumes from any series page, then tap placeholders in your catalog to
                download on other devices.
              </p>
              <p class="text-center text-sm text-gray-500">
                Or use the picker to download ZIP/CBZ files you've added to the <span
                  class="text-primary-600">{READER_FOLDER}</span
                > folder in Drive.
              </p>
            {:else}
              <p class="text-center text-gray-300">
                Back up volumes from any series page, then tap placeholders in your catalog to
                download on other devices.
              </p>
            {/if}

            <!-- File picker button (Google Drive only) -->
            {#if currentProvider === 'google-drive'}
              <Button color="dark" onclick={createPicker}>Open file picker</Button>
            {/if}

            <!-- Turbo Mode toggle with RAM configuration -->
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-3">
                <Toggle
                  bind:checked={$miscSettings.turboMode}
                  onchange={() => updateMiscSetting('turboMode', $miscSettings.turboMode)}
                >
                  Turbo Mode
                </Toggle>
              </div>
              <p class="text-xs text-gray-500">
                For users with fast internet and a lack of patience. Enables parallel
                downloads/uploads.
              </p>

              {#if $miscSettings.turboMode}
                <div class="mt-2 flex flex-col gap-2">
                  <div class="text-sm font-medium">Device RAM Configuration</div>
                  <div class="flex gap-4">
                    <Radio
                      name="ram-config-{currentProvider}"
                      value={4}
                      bind:group={$miscSettings.deviceRamGB}
                      onchange={() => updateMiscSetting('deviceRamGB', 4)}>4GB</Radio
                    >
                    <Radio
                      name="ram-config-{currentProvider}"
                      value={8}
                      bind:group={$miscSettings.deviceRamGB}
                      onchange={() => updateMiscSetting('deviceRamGB', 8)}>8GB</Radio
                    >
                    <Radio
                      name="ram-config-{currentProvider}"
                      value={16}
                      bind:group={$miscSettings.deviceRamGB}
                      onchange={() => updateMiscSetting('deviceRamGB', 16)}>16GB</Radio
                    >
                    <Radio
                      name="ram-config-{currentProvider}"
                      value={32}
                      bind:group={$miscSettings.deviceRamGB}
                      onchange={() => updateMiscSetting('deviceRamGB', 32)}>32GB+</Radio
                    >
                  </div>
                  <p class="text-xs text-gray-500">
                    Configure your device's RAM to optimize parallel download performance and
                    prevent memory issues.
                  </p>
                </div>
              {/if}
            </div>

            <!-- Auto re-authenticate toggle (Google Drive only) -->
            {#if currentProvider === 'google-drive'}
              <div class="flex flex-col gap-2">
                <div class="flex items-center gap-3">
                  <Toggle
                    bind:checked={$miscSettings.gdriveAutoReAuth}
                    onchange={() =>
                      updateMiscSetting('gdriveAutoReAuth', $miscSettings.gdriveAutoReAuth)}
                  >
                    Auto re-authenticate on token expiration
                  </Toggle>
                </div>
                <p class="text-xs text-gray-500">
                  Keeps your progress synced during long reading sessions. Automatically prompts
                  re-authentication when your session expires (~1 hour).
                </p>

                {#if $miscSettings.gdriveAutoReAuth}
                  <div class="mt-2 rounded-lg border border-yellow-700/50 bg-yellow-900/30 p-3">
                    <h4 class="mb-2 text-sm font-semibold text-yellow-200">
                      ⚠️ Popup Permission Required ({browserInfo.name})
                    </h4>
                    <p class="mb-3 text-xs text-gray-300">
                      For auto re-authentication to work, you must allow popups for this site.
                      Otherwise, the browser will block automatic re-authentication attempts.
                    </p>
                    <div class="mb-3 space-y-1 text-xs text-gray-300">
                      <p class="font-medium">To enable popups:</p>
                      <ol class="list-inside list-decimal space-y-1 pl-2">
                        {#each browserInfo.instructions as instruction}
                          <li>{instruction}</li>
                        {/each}
                      </ol>
                      {#if browserInfo.settingsUrl}
                        <div class="mt-2">
                          <p class="text-xs text-gray-400">
                            <span
                              role="button"
                              tabindex="0"
                              class="cursor-pointer font-mono text-yellow-400 underline hover:text-yellow-300"
                              onclick={() => {
                                navigator.clipboard.writeText(browserInfo.settingsUrl);
                                showSnackbar(`Copied! Paste this into your address bar`);
                              }}
                              onkeydown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  navigator.clipboard.writeText(browserInfo.settingsUrl);
                                  showSnackbar(`Copied! Paste this into your address bar`);
                                }
                              }}
                            >
                              {browserInfo.settingsUrl}
                            </span>
                          </p>
                        </div>
                      {/if}
                    </div>
                    <Button
                      size="xs"
                      color="yellow"
                      onclick={() => {
                        showSnackbar(
                          'Testing in 5 seconds... Do NOT click or interact until the popup appears!'
                        );
                        // Use 5 second timeout to escape Chrome's user gesture window (~2-5 seconds)
                        // This properly tests if popups are allowed for true background triggers (like auto re-auth)
                        setTimeout(() => {
                          try {
                            tokenManager.reAuthenticate();
                            showSnackbar(
                              '✅ Test triggered - if you see the Google auth popup, popups are allowed!'
                            );
                          } catch (error) {
                            showSnackbar(
                              '❌ Test failed - popup was blocked! Please enable popups for this site.'
                            );
                          }
                        }, 5000);
                      }}
                    >
                      Test Popup Permission
                    </Button>
                  </div>
                {/if}
              </div>
            {/if}

            <!-- Sync read progress button -->
            <Button
              color="dark"
              onclick={currentProvider === 'google-drive' ? performSync : handleProviderSync}
            >
              Sync read progress
            </Button>

            <!-- Backup all series button -->
            <Button
              color="purple"
              onclick={() =>
                promptConfirmation('Backup all series to cloud storage?', backupAllSeries)}
            >
              Backup all series to cloud
            </Button>

            <!-- Profile sync button -->
            <Button color="blue" onclick={syncProfiles} disabled={isSyncingProfiles}>
              {#if isSyncingProfiles}
                <Spinner size="4" class="mr-2" />
                Syncing profiles...
              {:else}
                Sync profiles
              {/if}
            </Button>

            <!-- Storage quota section -->
            <div class="mt-4 rounded-lg bg-gray-800 p-4">
              <h3 class="mb-2 font-semibold">Storage</h3>
              {#if quotaLoading}
                <div class="flex items-center gap-2 text-sm text-gray-400">
                  <Spinner size="4" />
                  Loading storage info...
                </div>
              {:else if storageQuota && storageQuota.total !== null}
                <div class="space-y-2">
                  <div class="flex justify-between text-sm">
                    <span class="text-gray-300">{formatBytes(storageQuota.used)} used</span>
                    <span class="text-gray-300"
                      >{formatBytes(storageQuota.available ?? 0)} available</span
                    >
                  </div>
                  <div class="h-2.5 w-full rounded-full bg-gray-700">
                    <div
                      class="h-2.5 rounded-full transition-all duration-300"
                      class:bg-blue-500={(storageQuota.used / storageQuota.total) * 100 < 80}
                      class:bg-yellow-500={(storageQuota.used / storageQuota.total) * 100 >= 80 &&
                        (storageQuota.used / storageQuota.total) * 100 < 95}
                      class:bg-red-500={(storageQuota.used / storageQuota.total) * 100 >= 95}
                      style="width: {Math.min(
                        (storageQuota.used / storageQuota.total) * 100,
                        100
                      )}%"
                    ></div>
                  </div>
                  <div class="text-center text-xs text-gray-500">
                    {formatBytes(storageQuota.total)} total ({Math.round(
                      (storageQuota.used / storageQuota.total) * 100
                    )}% used)
                  </div>
                </div>
              {:else if storageQuota && storageQuota.used > 0}
                <p class="text-sm text-gray-300">{formatBytes(storageQuota.used)} used</p>
              {:else}
                <p class="text-sm text-gray-500">Storage information unavailable</p>
              {/if}
            </div>

            <!-- Provider info box -->
            <div class="mt-4 rounded-lg bg-gray-800 p-4">
              <h3 class="mb-2 font-semibold">About {providerNames[currentProvider]}</h3>
              <ul class="space-y-1 text-sm text-gray-300">
                {#each providerInfo[currentProvider].items as item}
                  <li>{item}</li>
                {/each}
              </ul>
            </div>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>
