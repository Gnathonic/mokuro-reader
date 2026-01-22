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
  import ImportPreparingModal from '$lib/components/ImportPreparingModal.svelte';
  import ProgressTracker from '$lib/components/ProgressTracker.svelte';
  import NightModeFilter from '$lib/components/NightModeFilter.svelte';
  import GlobalDropZone from '$lib/components/GlobalDropZone.svelte';
  import MigrationBlocker from '$lib/components/MigrationBlocker.svelte';
  import SwUpdateBanner from '$lib/components/SwUpdateBanner.svelte';
  import { initializeProviders } from '$lib/util/sync/init-providers';
  import { initFileHandler } from '$lib/util/file-handler';
  import { initSwUpdateDetection } from '$lib/util/sw-update';
  import { navigateBack, currentView } from '$lib/util/hash-router';
  import { checkMigrationNeeded } from '$lib/catalog/migration';
  import { get } from 'svelte/store';

  // Migration state
  let migrationNeeded: 1 | 2 | null = $state(null);
  let migrationChecked = $state(false);

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  inject({ mode: dev ? 'development' : 'production' });

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

    // Fire and forget - don't block app initialization
    initializeProviders().catch((error) => {
      console.error('Failed to initialize providers:', error);
    });

    // Initialize file handler for PWA file associations
    initFileHandler();

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
  <div class="h-full min-h-[100svh] text-white">
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
    <ImportPreparingModal />
    <ProgressTracker />
    <NightModeFilter />
    <GlobalDropZone />
    <SwUpdateBanner />
  </div>
{/if}
