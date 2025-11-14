<script lang="ts">
  import type { Page } from '$lib/types';
  import { db } from '$lib/catalog/db';
  import MangaPage from './MangaPage.svelte';
  import { Spinner } from 'flowbite-svelte';

  interface Props {
    volumeUuid: string;
    pageNumber: number; // 0-indexed
    pages: Page[];
    useSinglePage: boolean;
    hasCover: boolean;
    isVisible: boolean; // Whether this is the currently visible page
    onReady?: () => void; // Callback when loading completes
  }

  let { volumeUuid, pageNumber, pages, useSinglePage, hasCover, isVisible, onReady }: Props = $props();

  // Calculate if this page should show a second page
  const showSecondPage = $derived(() => {
    if (useSinglePage || pageNumber + 1 >= pages.length) {
      return false;
    }

    if (pageNumber === 0 && hasCover) {
      return false;
    }

    return true;
  });

  // Self-managed state
  let primaryImage = $state<File | null>(null);
  let secondaryImage = $state<File | null>(null);
  let loading = $state(true);

  // Load images once when component is created (pageNumber is constant)
  (async () => {
    // Load primary page
    const primaryImg = await db.volumes_images
      .where('volume_uuid')
      .equals(volumeUuid)
      .and(img => img.page_number === pageNumber)
      .first();

    if (primaryImg) {
      primaryImage = primaryImg.image;
    }

    // Load secondary page if needed
    if (showSecondPage() && pageNumber + 1 < pages.length) {
      const secondaryImg = await db.volumes_images
        .where('volume_uuid')
        .equals(volumeUuid)
        .and(img => img.page_number === pageNumber + 1)
        .first();

      if (secondaryImg) {
        secondaryImage = secondaryImg.image;
      }
    }

    loading = false;
    onReady?.(); // Notify parent that loading is complete
  })();
</script>

{#if (loading || !primaryImage) && isVisible}
  <!-- Only show spinner if this is the visible page -->
  <div class="flex items-center justify-center w-screen h-screen">
    <Spinner size="12" />
  </div>
{:else if primaryImage}
  <!-- Render content as soon as images are loaded (even if hidden) -->
  <div class="flex flex-row">
    {#if showSecondPage() && secondaryImage}
      <MangaPage page={pages[pageNumber + 1]} src={secondaryImage} {volumeUuid} />
    {/if}
    <MangaPage page={pages[pageNumber]} src={primaryImage} {volumeUuid} />
  </div>
{/if}
