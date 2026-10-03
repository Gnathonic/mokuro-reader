<script lang="ts">
  import '../app.css';
  import { browser, dev } from '$app/environment';
  import { inject } from '@vercel/analytics';
  import { onMount } from 'svelte';
  import NavBar from '$lib/components/NavBar.svelte';
  import Snackbar from '$lib/components/Snackbar.svelte';
  import ConfirmationPopup from '$lib/components/ConfirmationPopup.svelte';
  import ExtractionModal from '$lib/components/ExtractionModal.svelte';
  import ImageOnlyImportModal from '$lib/components/ImageOnlyImportModal.svelte';
  import ImportMismatchModal from '$lib/components/ImportMismatchModal.svelte';
  import WebDAVErrorModal from '$lib/components/WebDAVErrorModal.svelte';
  import MissingFilesModal from '$lib/components/MissingFilesModal.svelte';
  import VolumeEditorModal from '$lib/components/VolumeEditorModal.svelte';
  import SeriesEditorModal from '$lib/components/Series/SeriesEditorModal.svelte';
  import AnkiFieldModal from '$lib/components/Reader/AnkiFieldModal.svelte';
  import ImportPreparingModal from '$lib/components/ImportPreparingModal.svelte';
  import ProgressTracker from '$lib/components/ProgressTracker.svelte';
  import NightModeFilter from '$lib/components/NightModeFilter.svelte';
  import ThemeController from '$lib/components/ThemeController.svelte';
  import GlobalDropZone from '$lib/components/GlobalDropZone.svelte';
  import MigrationBlocker from '$lib/components/MigrationBlocker.svelte';
  import SwUpdateBanner from '$lib/components/SwUpdateBanner.svelte';
  import { initializeProviders } from '$lib/util/sync/init-providers';
  import { initFileHandler } from '$lib/util/file-handler';
  import { initProgressTracker } from '$lib/metadata/progress-tracker';
  import { initSeriesFileSync } from '$lib/metadata/series-file-sync';
  import { initCatalogFileSync } from '$lib/metadata/catalog-file-sync';
  import { initSwUpdateDetection } from '$lib/util/sw-update';
  import { navigateBack, currentView } from '$lib/util/hash-router';
  import { checkMigrationNeeded } from '$lib/catalog/migration';
  import { startThumbnailProcessing } from '$lib/catalog/db';
  import { historyDb } from '$lib/reading-history/history-db';
  import {
    detectDeviceFacts,
    readDeviceEnv,
    touchDeviceRecord
  } from '$lib/reading-history/device-facts';
  import { initGoalsLifecycle } from '$lib/goals';
  import { cleanupLegacyEngineCredentials } from '$lib/settings/engine-credentials-cleanup';
  import { get } from 'svelte/store';
  import { loadWebFonts } from '$lib/util/web-fonts';

  if (browser) void loadWebFonts();

  // Migration state
  let migrationNeeded: 1 | 2 | null = $state(null);
  let migrationChecked = $state(false);

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  inject({ mode: dev ? 'development' : 'production' });

  onMount(() => {
    return initGoalsLifecycle();
  });

  // Handle global Escape key for back navigation
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      // Don't interfere with Escape on inputs or textareas
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return;
      }

      // Only navigate back if not already on catalog
      const view = get(currentView);
      if (view.type !== 'catalog') {
        event.preventDefault();
        navigateBack();
      }
    }
  }

  // Handle migration completion
  function handleMigrationComplete() {
    // Reload the page to use the new database
    window.location.reload();
  }

  // Initialize sync providers on app startup (non-blocking)
  onMount(async () => {
    // Check if migration is needed first
    if (browser) {
      try {
        migrationNeeded = await checkMigrationNeeded();
      } catch (error) {
        console.error('Failed to check migration:', error);
      }
      migrationChecked = true;

      // If migration is needed, don't initialize the rest of the app
      if (migrationNeeded !== null) {
        return;
      }
    }

    // One-time sweep of the removed experimental engines' API keys
    cleanupLegacyEngineCredentials();

    // Start background thumbnail generation once startup checks are complete
    startThumbnailProcessing();

    // Reading history: create/refresh this device's facts. Never blocks start-up.
    touchDeviceRecord(
      historyDb(),
      detectDeviceFacts(readDeviceEnv()),
      new Date().toISOString()
    ).catch((error) => console.warn('[reading-history] device record failed:', error));

    // Prune expired cloud cover cache, fire-and-forget
    void import('$lib/catalog/cloud-covers')
      .then((m) => m.pruneExpiredCloudCovers())
      .catch((error) => console.debug('[cloud-covers] prune skipped:', error));

    // Fire and forget - don't block app initialization
    initializeProviders()
      .catch((error) => {
        console.error('Failed to initialize providers:', error);
      })
      // Server OCR queues (one poller per bunko server): one look now, then
      // only while a volume of interest is pending. After the providers, so
      // the connected server is known and can authenticate.
      .finally(() => {
        void import('$lib/catalog/server-ocr-queue')
          .then((m) => m.startServerOcrQueue())
          .catch((error) => console.debug('[OCR queue] start skipped:', error));
      });

    // Initialize file handler for PWA file associations
    initFileHandler();

    // AniList progress push: completion listener + pending-queue flush
    initProgressTracker();

    // Debounced <Series>/series.json writes after local series-metadata edits
    initSeriesFileSync();

    // Debounced root catalog.json writes for backends that don't compile it
    initCatalogFileSync();

    // Initialize service worker update detection
    initSwUpdateDetection();
  });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if migrationNeeded !== null}
  <MigrationBlocker sourceVersion={migrationNeeded} onComplete={handleMigrationComplete} />
{:else if !migrationChecked}
  <!-- Show loading while checking for migration -->
  <div class="flex h-full min-h-[100svh] items-center justify-center bg-gray-900 text-white">
    <p>Loading...</p>
  </div>
{:else}
  <div class="h-full min-h-[100svh] text-gray-900 dark:text-white">
    <NavBar />
    {@render children?.()}
    <Snackbar />
    <ConfirmationPopup />
    <ExtractionModal />
    <ImageOnlyImportModal />
    <ImportMismatchModal />
    <WebDAVErrorModal />
    <MissingFilesModal />
    <VolumeEditorModal />
    <SeriesEditorModal />
    <AnkiFieldModal />
    <ImportPreparingModal />
    <ProgressTracker />
    <NightModeFilter />
    <ThemeController />
    <GlobalDropZone />
    <SwUpdateBanner />
  </div>
{/if}
