<script lang="ts">
  import { Dropdown, DropdownItem, DropdownDivider, Spinner } from 'flowbite-svelte';
  import {
    BookSolid,
    CheckCircleSolid,
    ExclamationCircleSolid,
    CogOutline
  } from 'flowbite-svelte-icons';
  import {
    libraries,
    selectedLibraryId,
    setSelectedLibrary,
    hasLibraries,
    type LibraryConfig
  } from '$lib/settings/libraries';
  import { libraryStatusStore, isAnyLibraryFetching, libraryErrors } from '$lib/util/libraries';
  import { nav } from '$lib/util/hash-router';

  // Reactive state
  let libraryList = $derived($libraries);
  let selected = $derived($selectedLibraryId);
  let statusMap = $derived($libraryStatusStore);
  let errorMap = $derived($libraryErrors);
  let isFetching = $derived($isAnyLibraryFetching);
  let showSelector = $derived($hasLibraries);

  // Get the display name for the current selection
  function getSelectedName(): string {
    if (!selected) return 'All Libraries';
    const lib = libraryList.find((l) => l.id === selected);
    return lib?.name || 'Unknown';
  }

  // Handle library selection
  function selectLibrary(id: string | null) {
    setSelectedLibrary(id);
  }

  // Navigate to library manager
  function goToLibraries() {
    nav.toLibraries();
  }
</script>

<div class="relative">
  <button
    id="library-selector-btn"
    class="flex h-6 w-6 items-center justify-center"
    title={showSelector ? `Library: ${getSelectedName()}` : 'Manage Libraries'}
  >
    {#if isFetching}
      <Spinner size="4" />
    {:else if errorMap.size > 0}
      <BookSolid class="h-6 w-6 cursor-pointer text-yellow-500 hover:text-yellow-600" />
    {:else if showSelector}
      <BookSolid class="h-6 w-6 cursor-pointer text-primary-600 hover:text-primary-700" />
    {:else}
      <BookSolid class="h-6 w-6 cursor-pointer hover:text-primary-700" />
    {/if}
  </button>

  <Dropdown triggeredBy="#library-selector-btn" placement="bottom-end">
    {#if showSelector}
      <!-- All Libraries option -->
      <DropdownItem
        onclick={() => selectLibrary(null)}
        class="flex items-center gap-2 {!selected ? 'bg-gray-100 dark:bg-gray-700' : ''}"
      >
        {#if !selected}
          <CheckCircleSolid class="h-4 w-4 text-primary-500" />
        {:else}
          <span class="w-4"></span>
        {/if}
        <span>All Libraries</span>
      </DropdownItem>

      <DropdownDivider />

      <!-- Individual libraries -->
      {#each libraryList as library}
        <DropdownItem
          onclick={() => selectLibrary(library.id)}
          class="flex items-center gap-2 {selected === library.id
            ? 'bg-gray-100 dark:bg-gray-700'
            : ''}"
        >
          {#if selected === library.id}
            <CheckCircleSolid class="h-4 w-4 text-primary-500" />
          {:else if errorMap.has(library.id)}
            <ExclamationCircleSolid class="h-4 w-4 text-red-500" />
          {:else if statusMap.get(library.id) === 'fetching'}
            <Spinner size="4" />
          {:else if statusMap.get(library.id) === 'ready'}
            <CheckCircleSolid class="h-4 w-4 text-green-500" />
          {:else}
            <span class="w-4"></span>
          {/if}
          <span class="max-w-[200px] flex-1 truncate">{library.name}</span>
        </DropdownItem>
      {/each}

      <DropdownDivider />
    {/if}

    <!-- Manage Libraries link -->
    <DropdownItem
      onclick={goToLibraries}
      class="flex items-center gap-2 text-gray-500 dark:text-gray-400"
    >
      <CogOutline class="h-4 w-4" />
      <span>Manage Libraries</span>
    </DropdownItem>
  </Dropdown>
</div>
