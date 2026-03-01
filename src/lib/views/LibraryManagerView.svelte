<script lang="ts">
  import { Button, Card, Spinner, Badge } from 'flowbite-svelte';
  import {
    CirclePlusSolid,
    RefreshOutline,
    TrashBinSolid,
    PenSolid,
    CheckCircleSolid,
    ExclamationCircleSolid,
    ArrowLeftOutline
  } from 'flowbite-svelte-icons';
  import { nav } from '$lib/util/hash-router';
  import { libraries, removeLibrary, type LibraryConfig } from '$lib/settings/libraries';
  import {
    fetchLibrary,
    fetchAllLibraries,
    libraryStatusStore,
    libraryErrors,
    totalLibraryFileCount,
    clearLibraryCache
  } from '$lib/util/libraries';
  import { showSnackbar, promptConfirmation } from '$lib/util';
  import { promptAddLibrary, promptEditLibrary } from '$lib/util/modals';
  import AddLibraryModal from '$lib/components/AddLibraryModal.svelte';

  // Reactive state
  let libraryList = $derived($libraries);
  let statusMap = $derived($libraryStatusStore);
  let errorMap = $derived($libraryErrors);
  let totalFiles = $derived($totalLibraryFileCount);

  // Refresh state
  let refreshingAll = $state(false);
  let refreshingIds = $state<Set<string>>(new Set());

  // Open add library modal
  function openAddLibrary() {
    promptAddLibrary();
  }

  // Navigate back to catalog
  function goBack() {
    nav.toCatalog();
  }

  // Refresh all libraries
  async function handleRefreshAll() {
    refreshingAll = true;
    try {
      await fetchAllLibraries();
      showSnackbar('Libraries refreshed');
    } catch (error) {
      console.error('Failed to refresh libraries:', error);
      showSnackbar('Some libraries failed to refresh');
    } finally {
      refreshingAll = false;
    }
  }

  // Refresh single library
  async function handleRefresh(library: LibraryConfig) {
    refreshingIds = new Set([...refreshingIds, library.id]);
    try {
      await fetchLibrary(library);
      showSnackbar(`${library.name} refreshed`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      showSnackbar(`Failed to refresh ${library.name}`);
      console.error(`Failed to refresh ${library.name}:`, message);
    } finally {
      refreshingIds = new Set([...refreshingIds].filter((id) => id !== library.id));
    }
  }

  // Remove library
  function handleRemove(library: LibraryConfig) {
    promptConfirmation(
      `Remove library "${library.name}"? Downloaded volumes will remain in your catalog.`,
      () => {
        // On confirm callback
        clearLibraryCache(library.id);
        removeLibrary(library.id);
        showSnackbar(`${library.name} removed`);
      }
    );
  }

  // Edit library (open modal in edit mode)
  function handleEdit(library: LibraryConfig) {
    promptEditLibrary(library.id);
  }

  // Get status display
  function getStatusInfo(library: LibraryConfig): {
    text: string;
    color: 'green' | 'red' | 'yellow' | 'gray';
  } {
    const error = errorMap.get(library.id);
    if (error) {
      return { text: 'Error', color: 'red' };
    }

    const status = statusMap.get(library.id);
    if (status === 'fetching') {
      return { text: 'Loading...', color: 'yellow' };
    }
    if (status === 'ready') {
      return { text: 'Connected', color: 'green' };
    }
    return { text: 'Not loaded', color: 'gray' };
  }

  // Format date
  function formatDate(isoString?: string): string {
    if (!isoString) return 'Never';
    const date = new Date(isoString);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
</script>

<div class="mx-auto max-w-4xl p-4">
  <!-- Header -->
  <div class="mb-6 flex items-center justify-between">
    <div class="flex items-center gap-4">
      <button onclick={goBack} class="rounded-lg p-2 hover:bg-gray-100 dark:hover:bg-gray-700">
        <ArrowLeftOutline class="h-5 w-5" />
      </button>
      <div>
        <h1 class="text-2xl font-bold dark:text-white">Libraries</h1>
        <p class="text-sm text-gray-500 dark:text-gray-400">
          {libraryList.length}
          {libraryList.length === 1 ? 'library' : 'libraries'}
          {#if totalFiles > 0}
            &bull; {totalFiles} volumes available
          {/if}
        </p>
      </div>
    </div>
    <div class="flex gap-2">
      {#if libraryList.length > 0}
        <Button color="light" size="sm" onclick={handleRefreshAll} disabled={refreshingAll}>
          {#if refreshingAll}
            <Spinner size="4" class="me-2" />
          {:else}
            <RefreshOutline class="me-2 h-4 w-4" />
          {/if}
          Refresh All
        </Button>
      {/if}
      <Button color="primary" size="sm" onclick={openAddLibrary}>
        <CirclePlusSolid class="me-2 h-4 w-4" />
        Add Library
      </Button>
    </div>
  </div>

  <!-- Library List -->
  {#if libraryList.length === 0}
    <Card class="text-center">
      <p class="mb-4 text-gray-500 dark:text-gray-400">
        No libraries configured. Add a WebDAV library to browse and download manga from external
        servers.
      </p>
      <Button color="primary" onclick={openAddLibrary}>
        <CirclePlusSolid class="me-2 h-4 w-4" />
        Add Your First Library
      </Button>
    </Card>
  {:else}
    <div class="flex flex-col gap-4">
      {#each libraryList as library}
        {@const statusInfo = getStatusInfo(library)}
        {@const isRefreshing = refreshingIds.has(library.id)}
        <Card class="p-4">
          <div class="flex items-start justify-between">
            <div class="flex-1">
              <div class="mb-1 flex items-center gap-2">
                <h3 class="text-lg font-semibold dark:text-white">{library.name}</h3>
                <Badge color={statusInfo.color}>{statusInfo.text}</Badge>
              </div>
              <p class="mb-2 text-sm break-all text-gray-500 dark:text-gray-400">
                {library.serverUrl}{library.basePath !== '/' ? library.basePath : ''}
              </p>
              {#if library.lastFetched}
                <p class="text-xs text-gray-400 dark:text-gray-500">
                  Last refreshed: {formatDate(library.lastFetched)}
                </p>
              {/if}
              {#if errorMap.has(library.id)}
                <p class="mt-1 text-xs text-red-500">
                  {errorMap.get(library.id)}
                </p>
              {/if}
            </div>
            <div class="flex gap-2">
              <Button
                color="light"
                size="xs"
                onclick={() => handleRefresh(library)}
                disabled={isRefreshing}
                title="Refresh"
              >
                {#if isRefreshing}
                  <Spinner size="4" />
                {:else}
                  <RefreshOutline class="h-4 w-4" />
                {/if}
              </Button>
              <Button color="light" size="xs" onclick={() => handleEdit(library)} title="Edit">
                <PenSolid class="h-4 w-4" />
              </Button>
              <Button
                color="light"
                size="xs"
                onclick={() => handleRemove(library)}
                title="Remove"
                class="text-red-500 hover:text-red-600"
              >
                <TrashBinSolid class="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Card>
      {/each}
    </div>
  {/if}

  <!-- Info Section -->
  <div class="mt-8 rounded-lg bg-gray-50 p-4 dark:bg-gray-800">
    <h4 class="mb-2 font-semibold dark:text-white">About Libraries</h4>
    <ul class="space-y-1 text-sm text-gray-600 dark:text-gray-400">
      <li>• Libraries are read-only WebDAV sources for browsing and downloading manga</li>
      <li>• Downloaded volumes are imported into your local catalog</li>
      <li>• Libraries are separate from cloud sync - they don't sync reading progress</li>
      <li>• Share a library link with others: copy the "Add Library" URL from your server</li>
    </ul>
  </div>
</div>

<AddLibraryModal />
