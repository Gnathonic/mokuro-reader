<script lang="ts">
  import '../app.css';
  // After app.css, the cascade position its inline <style> in app.html had.
  import '#lib/styles/night-mode.css';
  import { browser, dev } from '$app/env';
  import { inject } from '@vercel/analytics';
  import { scrubAnalyticsEvent } from '#lib/util/analytics-scrub.js';
  import { onMount } from 'svelte';
  import NavBar from '#lib/components/NavBar.svelte';
  import Snackbar from '#lib/components/Snackbar.svelte';
  import ConfirmationPopup from '#lib/components/ConfirmationPopup.svelte';
  import ExtractionModal from '#lib/components/ExtractionModal.svelte';
  import ImageOnlyReviewDialog from '#lib/components/ImageOnlyReviewDialog.svelte';
  import ImportMismatchModal from '#lib/components/ImportMismatchModal.svelte';
  import WebDAVErrorModal from '#lib/components/WebDAVErrorModal.svelte';
  import MissingFilesModal from '#lib/components/MissingFilesModal.svelte';
  import VolumeEditorModal from '#lib/components/VolumeEditorModal.svelte';
  import SeriesEditorModal from '#lib/components/Series/SeriesEditorModal.svelte';
  import AnkiFieldModal from '#lib/components/Reader/AnkiFieldModal.svelte';
  import ImportPreparingModal from '#lib/components/ImportPreparingModal.svelte';
  import ProgressTracker from '#lib/components/ProgressTracker.svelte';
  import NightModeFilter from '#lib/components/NightModeFilter.svelte';
  import ThemeController from '#lib/components/ThemeController.svelte';
  import GlobalDropZone from '#lib/components/GlobalDropZone.svelte';
  import MigrationBlocker from '#lib/components/MigrationBlocker.svelte';
  import SwUpdateBanner from '#lib/components/SwUpdateBanner.svelte';
  import { initializeProviders } from '#lib/util/sync/init-providers.js';
  import { foregroundSync } from '#lib/util/sync/foreground-sync.js';
  import { activityTracker } from '#lib/util/activity-tracker.js';
  import { initFileHandler } from '#lib/util/file-handler.js';
  import { initProgressTracker } from '#lib/metadata/progress-tracker.js';
  import { initSeriesFileSync } from '#lib/metadata/series-file-sync.js';
  import { initCatalogFileSync } from '#lib/metadata/catalog-file-sync.js';
  import { initSwUpdateDetection } from '#lib/util/sw-update.js';
  import { navigateBack, currentView } from '#lib/util/hash-router.js';
  import { checkMigrationNeeded } from '#lib/catalog/migration/index.js';
  import { startThumbnailProcessing } from '#lib/catalog/db.js';
  import { retirePreviousOcrLayers } from '#lib/catalog/retired-previous-ocr.js';
  import { fillSetAsideLayerVersions } from '#lib/catalog/set-aside-versions.js';
  import { historyDb } from '#lib/reading-history/history-db.js';
  import { loadHistoryTurns } from '#lib/reading-history/turns-store.js';
  import { getOrCreateDeviceId } from '#lib/reading-history/record.js';
  import {
    detectDeviceFacts,
    readDeviceEnv,
    touchDeviceRecord
  } from '#lib/reading-history/device-facts.js';
  import { initGoalsLifecycle } from '#lib/goals/index.js';
  import { cleanupLegacyEngineCredentials } from '#lib/settings/engine-credentials-cleanup.js';
  import { get } from 'svelte/store';
  import { loadWebFonts } from '#lib/util/web-fonts.js';

  if (browser) void loadWebFonts();

  // The interop rig's driver (`__mokuroInterop`), in a hooked build only: the
  // switch is a literal false in production, so the import and its chunk are
  // dropped.
  if (__MOKURO_TEST_HOOKS__ && browser) {
    import('#lib/interop/rig-driver.js')
      .then((m) => m.install())
      .catch((error) => console.error('[interop] rig driver failed to load', error));
  }

  // Migration state
  let migrationNeeded: 1 | 2 | null = $state(null);
  let migrationChecked = $state(false);

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  // Page views go out without sign-in secrets in their URL (OAuth codes,
  // AniList's `#access_token=` landing).
  inject({ mode: dev ? 'development' : 'production', beforeSend: scrubAnalyticsEvent });

  onMount(() => {
    const stopForeground = foregroundSync.listen();
    // Progress syncs are batched while reading (activity-tracker); a pending
    // change goes up at once when the tab hides or the page goes away. On
    // `visibilitychange` the document is already `hidden`, so the flush's sync
    // is outside the reading session and uploads what one deferred
    // (`util/sync/reading-session.ts`).
    const flushOnHide = () => {
      if (document.visibilityState === 'hidden') activityTracker.flush();
    };
    const flushOnPageHide = () => activityTracker.flush();
    document.addEventListener('visibilitychange', flushOnHide);
    window.addEventListener('pagehide', flushOnPageHide);
    return () => {
      stopForeground();
      document.removeEventListener('visibilitychange', flushOnHide);
      window.removeEventListener('pagehide', flushOnPageHide);
    };
  });

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
    // positions.json: mark this device's position changes and push them after
    // page turns settle. Started at once, so no turn goes unmarked.
    void Promise.all([
      import('#lib/positions/positions-local.js'),
      import('#lib/positions/positions-sync.js'),
      import('#lib/positions/visit.js')
    ])
      .then(([{ initPositionTracking }, { initPositionPush }, { initVisitTracking }]) => {
        initPositionTracking();
        initPositionPush();
        // Look-up visits give their position back; they need this device's id.
        return getOrCreateDeviceId(historyDb()).then(initVisitTracking);
      })
      .catch((error) => console.warn('[positions] could not start:', error));
    // Reading history's page turns load first (the stats read them); then turns
    // still held in volume records become history events (phase 2b). The
    // cut-over strips nothing unless that load succeeded.
    loadHistoryTurns(historyDb())
      .catch((error) => console.warn('[reading-history] could not load history turns:', error))
      .then(() => import('#lib/reading-history/cut-over.js'))
      .then(({ cutOverLegacyTurns }) => cutOverLegacyTurns(historyDb()))
      .catch((error) => console.warn('[reading-history] cut-over failed:', error))
      // Cross-device position offers (phase 2c): watch history once it is loaded.
      .then(() => import('#lib/reading-history/position-store.js'))
      .then(({ initPositionOffers }) => initPositionOffers(historyDb()))
      .catch((error) => console.warn('[reading-history] position offers failed:', error));

    // Reading stats from history (phase 3a). Each record's reading from
    // before history is frozen into a snapshot right away (it needs no
    // events: history from before the freeze is set against it as it arrives).
    void import('#lib/reading-history/stats-store.js')
      .then(({ initReadingStats, freezeLegacyBaselines }) => {
        freezeLegacyBaselines();
        initReadingStats();
      })
      .catch((error) => console.warn('[reading-history] stats failed to start:', error));

    // v1.10.0's "Previous OCR" keepsakes nobody claimed (the OCR upgrade no
    // longer keeps one): removed once per browser, from metadata rows alone.
    // Then the set-aside mains that are left learn the mokuro version their
    // pages name, once per browser (they are named by it — `ocr-label.ts`).
    retirePreviousOcrLayers()
      .catch((error) => console.debug('[layers] previous-ocr cleanup skipped:', error))
      .then(() => fillSetAsideLayerVersions())
      .catch((error) => console.debug('[layers] set-aside version fill skipped:', error));

    // Prune expired cloud cover cache, fire-and-forget
    void import('#lib/catalog/cloud-covers.js')
      .then((m) => m.pruneExpiredCloudCovers())
      .catch((error) => console.debug('[cloud-covers] prune skipped:', error));

    // Fire and forget - don't block app initialization
    initializeProviders()
      .catch((error) => {
        console.error('Failed to initialize providers:', error);
      })
      // Server OCR queues: the watched volumes' schedule and the cloud
      // library's marker poll (series pages read their own series files).
      // After the providers, so the connected server is known and can
      // authenticate.
      .finally(() => {
        void import('#lib/catalog/server-ocr-queue.js')
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
    <ImageOnlyReviewDialog />
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
