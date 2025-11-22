<script lang="ts">
  import { run } from 'svelte/legacy';

  import { profiles } from '$lib/settings';
  import { miscSettings, updateMiscSetting } from '$lib/settings/misc';

  import {
    promptConfirmation,
    showSnackbar,
    accessTokenStore,
    tokenClientStore,
    signIn,
    logout,
    syncReadProgress,
    READER_FOLDER,
    CLIENT_ID,
    API_KEY
  } from '$lib/util';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import type { ProviderType } from '$lib/util/sync/provider-interface';
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
  import {
    providerManager,
    megaProvider,
    webdavProvider,
    googleDriveProvider
  } from '$lib/util/sync';
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

  // Check if any provider is configured (not just authenticated)
  // This allows UI to show the provider page immediately while initializing
  let hasAnyProvider = $derived(
    $providerStatusStore.providers['google-drive']?.hasStoredCredentials ||
      $providerStatusStore.providers['mega']?.hasStoredCredentials ||
      $providerStatusStore.providers['webdav']?.hasStoredCredentials ||
      false
  );

  // Check if providers are configured (even if not currently connected)
  let googleDriveConfigured = $derived(
    $providerStatusStore.providers['google-drive']?.hasStoredCredentials || false
  );
  let megaConfigured = $derived(
    $providerStatusStore.providers['mega']?.hasStoredCredentials || false
  );
  let webdavConfigured = $derived(
    $providerStatusStore.providers['webdav']?.hasStoredCredentials || false
  );

  // Determine current configured provider (show UI even if still initializing)
  let currentProvider = $derived<ProviderType | null>(
    googleDriveConfigured
      ? 'google-drive'
      : megaConfigured
        ? 'mega'
        : webdavConfigured
          ? 'webdav'
          : null
  );

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
        'File picker for easy selection',
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
      // Use provider's file picker - it handles all the Drive-specific logic
      const pickedFiles = await googleDriveProvider.showFilePicker();

      if (pickedFiles.length === 0) {
        return; // User cancelled or no files selected
      }

      // Fetch full metadata from Drive API
      const cloudFiles = await googleDriveProvider.getCloudFileMetadata(pickedFiles);

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
   */
  async function handlePostLogin() {
    try {
      await performSync();
    } catch (error) {
      // Silently catch sync errors - don't block successful login
      console.error('Post-login sync failed:', error);
    }
  }

  onMount(() => {
    // Clear service worker cache for Google Drive downloads
    // This is cloud-page-specific and not part of global init
    clearServiceWorkerCache();
  });

  // Google Drive handlers
  async function handleGoogleDriveLogin() {
    googleDriveLoading = true;
    try {
      // Trigger OAuth flow (initialize and show OAuth popup)
      await signIn();

      // Hide spinner once popup appears - user is now interacting with Google's dialog
      googleDriveLoading = false;

      // Wait for authentication to complete by watching the accessToken store
      await new Promise<void>((resolve, reject) => {
        let unsubscribe: (() => void) | undefined;

        const timeout = setTimeout(() => {
          unsubscribe?.(); // Clean up subscription on timeout
          reject(new Error('Login timeout'));
        }, 90000); // 90 second timeout for OAuth popup

        unsubscribe = accessTokenStore.subscribe((token) => {
          if (token) {
            clearTimeout(timeout);
            unsubscribe?.(); // Use optional chaining in case callback fires immediately
            resolve();
          }
        });
      });

      // Set as current provider (auto-logs out any other provider)
      const provider = providerManager.getProviderInstance('google-drive');
      if (provider) {
        await providerManager.setCurrentProvider(provider);
      }

      // After successful login, populate unified cache for placeholders
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

  // Unified logout handler
  async function handleLogout() {
    if (currentProvider === 'google-drive') {
      await logout();
    } else if (currentProvider === 'mega') {
      await handleMegaLogout();
    } else if (currentProvider === 'webdav') {
      await handleWebDAVLogout();
    }
  }

  async function handleMegaLogout() {
    await megaProvider.logout();
    megaEmail = '';
    megaPassword = '';
    unifiedCloudManager.clearCache();
    providerManager.updateStatus();
    showSnackbar('Logged out of MEGA');
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

  async function handleWebDAVLogout() {
    await webdavProvider.logout();
    webdavUrl = '';
    webdavUsername = '';
    webdavPassword = '';
    unifiedCloudManager.clearCache();
    providerManager.updateStatus();
    showSnackbar('Logged out of WebDAV');
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

<div class="p-2 h-[90svh]">
  {#if !hasAnyProvider}
    <!-- Provider Selection Screen (like sign-in options) -->
    <div class="flex justify-center pt-0 sm:pt-20">
      <div class="w-full max-w-md">
        <h2 class="text-2xl font-semibold text-center mb-8">Choose a Cloud Storage Provider</h2>

        <div class="flex flex-col gap-3">
          <!-- Google Drive Option -->
          <button
            class="w-full border rounded-lg border-slate-600 p-6 border-opacity-50 hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onclick={handleGoogleDriveLogin}
            disabled={googleDriveLoading}
          >
            <div class="flex items-center gap-4">
              {#if googleDriveLoading}
                <Spinner size="8" />
              {:else}
                <GoogleSolid size="xl" />
              {/if}
              <div class="text-left flex-1">
                <div class="font-semibold text-lg">Google Drive</div>
                <div class="text-sm text-gray-400">15GB free • Requires re-auth every hour</div>
              </div>
            </div>
          </button>

          <!-- MEGA Option -->
          <button
            class="w-full border rounded-lg border-slate-600 p-6 border-opacity-50 hover:bg-slate-800 transition-colors"
            onclick={() => {
              // Show MEGA login form
              const megaForm = document.getElementById('mega-login-form');
              if (megaForm) megaForm.classList.toggle('hidden');
            }}
          >
            <div class="flex items-center gap-4">
              <div class="w-8 h-8 flex items-center justify-center text-2xl">M</div>
              <div class="text-left flex-1">
                <div class="font-semibold text-lg">MEGA</div>
                <div class="text-sm text-gray-400">20GB free • Persistent login</div>
              </div>
            </div>
          </button>

          <div id="mega-login-form" class="hidden pl-12 pr-4 pb-4">
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
                class="bg-gray-700 border border-gray-600 text-white rounded-lg p-2.5 text-sm"
              />
              <input
                type="password"
                bind:value={megaPassword}
                placeholder="Password"
                required
                class="bg-gray-700 border border-gray-600 text-white rounded-lg p-2.5 text-sm"
              />
              <Button type="submit" disabled={megaLoading} color="blue" size="sm">
                {megaLoading ? 'Connecting...' : 'Connect to MEGA'}
              </Button>
            </form>
          </div>

          <!-- WebDAV Option -->
          <button
            class="w-full border rounded-lg border-slate-600 p-6 border-opacity-50 opacity-50 cursor-not-allowed"
            disabled
          >
            <div class="flex items-center gap-4">
              <div class="w-8 h-8 flex items-center justify-center text-2xl">W</div>
              <div class="text-left flex-1">
                <div class="flex items-center gap-2">
                  <div class="font-semibold text-lg">WebDAV</div>
                  <Badge color="yellow">Under Development</Badge>
                </div>
                <div class="text-sm text-gray-400">Nextcloud, ownCloud, NAS • Persistent login</div>
              </div>
            </div>
          </button>

          <div id="webdav-login-form" class="hidden pl-12 pr-4 pb-4">
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
                class="bg-gray-700 border border-gray-600 text-white rounded-lg p-2.5 text-sm"
              />
              <input
                type="text"
                bind:value={webdavUsername}
                placeholder="Username"
                required
                class="bg-gray-700 border border-gray-600 text-white rounded-lg p-2.5 text-sm"
              />
              <input
                type="password"
                bind:value={webdavPassword}
                placeholder="Password or App Token"
                required
                class="bg-gray-700 border border-gray-600 text-white rounded-lg p-2.5 text-sm"
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
      <div class="flex justify-center items-center flex-col gap-6">
        <div class="w-full max-w-3xl">
          <!-- Header with provider name and logout -->
          <div class="flex justify-between items-center mb-6">
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
            <Button color="red" on:click={handleLogout}>Log out</Button>
          </div>

          <div class="flex flex-col gap-4">
            <!-- Provider-specific instructions -->
            {#if currentProvider === 'google-drive'}
              <p class="text-center text-gray-300">
                Add your zipped manga files (ZIP or CBZ) to the <span class="text-primary-700"
                  >{READER_FOLDER}</span
                > folder in your Google Drive.
              </p>
              <p class="text-center text-sm text-gray-500">
                You can select multiple ZIP/CBZ files or entire folders at once.
              </p>
            {:else}
              <p class="text-center text-gray-300 mb-2">
                Your read progress is synced with {providerNames[currentProvider]}.
              </p>
            {/if}

            <!-- Download Manga button (Google Drive only) -->
            {#if currentProvider === 'google-drive'}
              <Button color="blue" on:click={createPicker}>Download Manga</Button>
            {/if}

            <!-- Turbo Mode toggle with RAM configuration -->
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-3">
                <Toggle
                  bind:checked={$miscSettings.turboMode}
                  on:change={() => updateMiscSetting('turboMode', $miscSettings.turboMode)}
                >
                  Turbo Mode
                </Toggle>
              </div>
              <p class="text-xs text-gray-500">
                For users with fast internet and a lack of patience. Enables parallel
                downloads/uploads.
              </p>

              {#if $miscSettings.turboMode}
                <div class="flex flex-col gap-2 mt-2">
                  <div class="text-sm font-medium">Device RAM Configuration</div>
                  <div class="flex gap-4">
                    <Radio
                      name="ram-config-{currentProvider}"
                      value={4}
                      bind:group={$miscSettings.deviceRamGB}
                      on:change={() => updateMiscSetting('deviceRamGB', 4)}>4GB</Radio
                    >
                    <Radio
                      name="ram-config-{currentProvider}"
                      value={8}
                      bind:group={$miscSettings.deviceRamGB}
                      on:change={() => updateMiscSetting('deviceRamGB', 8)}>8GB</Radio
                    >
                    <Radio
                      name="ram-config-{currentProvider}"
                      value={16}
                      bind:group={$miscSettings.deviceRamGB}
                      on:change={() => updateMiscSetting('deviceRamGB', 16)}>16GB</Radio
                    >
                    <Radio
                      name="ram-config-{currentProvider}"
                      value={32}
                      bind:group={$miscSettings.deviceRamGB}
                      on:change={() => updateMiscSetting('deviceRamGB', 32)}>32GB+</Radio
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
                    on:change={() =>
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
                  <div class="mt-2 p-3 bg-yellow-900/30 border border-yellow-700/50 rounded-lg">
                    <h4 class="text-sm font-semibold text-yellow-200 mb-2">
                      ⚠️ Popup Permission Required ({browserInfo.name})
                    </h4>
                    <p class="text-xs text-gray-300 mb-3">
                      For auto re-authentication to work, you must allow popups for this site.
                      Otherwise, the browser will block automatic re-authentication attempts.
                    </p>
                    <div class="text-xs text-gray-300 space-y-1 mb-3">
                      <p class="font-medium">To enable popups:</p>
                      <ol class="list-decimal list-inside pl-2 space-y-1">
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
                              class="text-yellow-400 underline cursor-pointer hover:text-yellow-300 font-mono"
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
                      on:click={() => {
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
              on:click={currentProvider === 'google-drive' ? performSync : handleProviderSync}
            >
              Sync read progress
            </Button>

            <!-- Backup all series button -->
            <Button
              color="purple"
              on:click={() =>
                promptConfirmation('Backup all series to cloud storage?', backupAllSeries)}
            >
              Backup all series to cloud
            </Button>

            <!-- Profile sync button -->
            <Button color="blue" on:click={syncProfiles} disabled={isSyncingProfiles}>
              {#if isSyncingProfiles}
                <Spinner size="4" class="mr-2" />
                Syncing profiles...
              {:else}
                Sync profiles
              {/if}
            </Button>

            <!-- Provider info box -->
            <div class="mt-4 p-4 bg-gray-800 rounded-lg">
              <h3 class="font-semibold mb-2">About {providerNames[currentProvider]}</h3>
              <ul class="text-sm text-gray-300 space-y-1">
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
