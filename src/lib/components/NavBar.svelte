<script lang="ts">
  import { Navbar, NavBrand, Spinner } from 'flowbite-svelte';
  import {
    CloudArrowUpOutline,
    UploadSolid,
    UserSettingsSolid,
    RefreshOutline,
    ChartLineUpOutline
  } from 'flowbite-svelte-icons';
  import { nav, isOnReader } from '$lib/util/hash-router';
  import Settings from './Settings/Settings.svelte';
  import UploadModal from './UploadModal.svelte';
  import Icon from '$lib/assets/icon.webp';
  import { showSnackbar } from '$lib/util';
  import { tokenManager } from '$lib/util/sync/providers/google-drive';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import { unifiedProviderState } from '$lib/util/sync/unified-provider-state';

  // Use $state to make these reactive
  let settingsOpen = $state(false);
  let uploadModalOpen = $state(false);
  let isReader = $state(false);

  // Read unified provider state synchronously
  let providerState = $derived($unifiedProviderState);

  // Track if any cloud providers are configured (derived from active_cloud_provider key)
  let hasActiveProvider = $derived(providerState?.hasActiveProvider ?? false);

  // Google Drive specific: Track token expiry for debug display
  let tokenMinutesLeft = $state<number | null>(null);
  let isGoogleDrive = $state<boolean>(false);

  // Track global sync state
  let isSyncing = $state<boolean>(false);

  // Get active provider's display name
  let providerDisplayName = $derived.by(() => {
    const provider = unifiedCloudManager.getActiveProvider();
    return provider?.name || 'cloud';
  });

  // Subscribe to global sync state
  $effect(() => {
    const unsubscribe = unifiedCloudManager.isSyncing.subscribe((value) => {
      isSyncing = value;
    });
    return unsubscribe;
  });

  // Check for configured providers (even if not currently connected) and determine provider type
  $effect(() => {
    const checkProviders = () => {
      const activeProvider = unifiedCloudManager.getActiveProvider();
      isGoogleDrive = activeProvider?.type === 'google-drive';
    };

    checkProviders(); // Initial check
    const interval = setInterval(checkProviders, 5000); // Check every 5 seconds

    return () => clearInterval(interval);
  });

  // Google Drive specific: Update token minutes every 10 seconds when authenticated
  $effect(() => {
    if (!isGoogleDrive || !providerState.isAuthenticated) {
      tokenMinutesLeft = null;
      return;
    }

    const updateTokenTime = () => {
      tokenMinutesLeft = tokenManager.getExpiryMinutes();
    };

    updateTokenTime(); // Initial update
    const interval = setInterval(updateTokenTime, 10000); // Update every 10 seconds

    return () => clearInterval(interval);
  });

  // Define event handlers
  function navigateToCatalog() {
    nav.toCatalog();
  }

  function openSettings() {
    settingsOpen = true;
  }

  function openUploadModal() {
    uploadModalOpen = true;
  }

  function navigateToCloud() {
    nav.toCloud();
  }

  function navigateToReadingSpeed() {
    nav.toReadingSpeed();
  }

  async function handleSync() {
    if (isSyncing) return; // Prevent multiple simultaneous syncs

    try {
      // Sync with all authenticated providers
      // State is managed automatically by unifiedSyncService
      await unifiedCloudManager.syncProgress();
    } catch (error) {
      console.error('Manual sync failed:', error);
      showSnackbar('Sync failed');
    }
  }

  // Google Drive specific: Manual token refresh handler
  function handleTokenRefresh() {
    if (isGoogleDrive && providerState.isAuthenticated) {
      tokenManager.reAuthenticate();
      showSnackbar(`Refreshing ${providerDisplayName} session...`);
    }
  }

  // Reactively update reader state - works for both browser mode (URL-based)
  // and PWA mode (view state-based)
  $effect(() => {
    isReader = $isOnReader;

    if (isReader) {
      window.document.body.classList.add('reader');
    } else {
      window.document.body.classList.remove('reader');
    }
  });
</script>

<div class="relative z-10">
  <Navbar hidden={isReader} class="bg-white dark:bg-gray-800">
    <NavBrand>
      <button onclick={navigateToCatalog} class="flex cursor-pointer flex-row items-center gap-2">
        <img src={Icon} alt="icon" class="h-[32px] w-[32px]" />
        <span class="text-xl font-semibold dark:text-white">Mokuro</span>
      </button>
    </NavBrand>
    <div class="flex gap-5 md:order-2">
      <button
        onclick={navigateToReadingSpeed}
        class="flex h-6 w-6 items-center justify-center"
        title="Reading Speed Stats"
      >
        <ChartLineUpOutline class="h-6 w-6 cursor-pointer hover:text-primary-700" />
      </button>
      <button onclick={openSettings} class="flex h-6 w-6 items-center justify-center">
        <UserSettingsSolid class="h-6 w-6 cursor-pointer hover:text-primary-700" />
      </button>
      <button onclick={openUploadModal} class="flex h-6 w-6 items-center justify-center">
        <UploadSolid class="h-6 w-6 cursor-pointer hover:text-primary-700" />
      </button>
      <button
        onclick={navigateToCloud}
        class="flex h-6 w-6 items-center justify-center"
        title={providerState.needsAttention
          ? `${providerDisplayName} - Action Required (click to sign in)`
          : providerState.isFullyConnected
            ? `${providerDisplayName} - Connected`
            : providerState.isAuthenticated
              ? `${providerDisplayName} - Loading...`
              : providerState.hasActiveProvider
                ? `${providerDisplayName} - Initializing...`
                : `${providerDisplayName} - Not connected`}
      >
        {#if providerState.needsAttention}
          <CloudArrowUpOutline class="h-6 w-6 cursor-pointer text-red-600 hover:text-red-700" />
        {:else if providerState.isCacheLoading && !providerState.isCacheLoaded}
          <Spinner size="4" />
        {:else if providerState.isFullyConnected}
          <CloudArrowUpOutline class="h-6 w-6 cursor-pointer text-green-600 hover:text-green-700" />
        {:else if providerState.isAuthenticated}
          <CloudArrowUpOutline
            class="h-6 w-6 cursor-pointer text-yellow-600 hover:text-yellow-700"
          />
        {:else if providerState.hasActiveProvider}
          <CloudArrowUpOutline
            class="h-6 w-6 cursor-pointer text-yellow-600 hover:text-yellow-700"
          />
        {:else}
          <CloudArrowUpOutline class="h-6 w-6 cursor-pointer hover:text-primary-700" />
        {/if}
      </button>
      {#if isGoogleDrive && providerState.isAuthenticated && tokenMinutesLeft !== null}
        {#key tokenMinutesLeft}
          <button
            onclick={handleTokenRefresh}
            class="flex cursor-pointer items-center justify-center rounded px-2 py-1 font-mono text-xs transition-colors
              {tokenMinutesLeft > 30
              ? 'text-green-600 hover:bg-green-50 hover:text-green-700 dark:hover:bg-green-900/20'
              : tokenMinutesLeft > 10
                ? 'text-yellow-600 hover:bg-yellow-50 hover:text-yellow-700 dark:hover:bg-yellow-900/20'
                : 'text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-900/20'}"
            title="Token expires in {tokenMinutesLeft} minutes. Click to refresh now."
          >
            {tokenMinutesLeft}m
          </button>
        {/key}
      {/if}
      {#if hasActiveProvider}
        <button
          onclick={handleSync}
          class="flex h-6 w-6 items-center justify-center"
          title={isSyncing ? 'Syncing...' : `Sync read progress with ${providerDisplayName}`}
          disabled={isSyncing}
        >
          <RefreshOutline
            class="h-6 w-6 cursor-pointer hover:text-primary-700 {isSyncing ? 'animate-spin' : ''}"
          />
        </button>
      {/if}
    </div>
  </Navbar>
</div>

<Settings bind:open={settingsOpen} />
<UploadModal bind:open={uploadModalOpen} />
