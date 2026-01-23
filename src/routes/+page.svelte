<script lang="ts">
  import { onMount } from 'svelte';
  import { initRouter, currentView, type View } from '$lib/util/hash-router';
  import { Spinner } from 'flowbite-svelte';
  import type { Component } from 'svelte';

  // Dynamic component imports for each view type
  const viewComponents: Record<View['type'], () => Promise<{ default: Component }>> = {
    catalog: () => import('$lib/views/CatalogView.svelte'),
    series: () => import('$lib/views/SeriesView.svelte'),
    reader: () => import('$lib/views/ReaderView.svelte'),
    'volume-text': () => import('$lib/views/VolumeTextView.svelte'),
    'series-text': () => import('$lib/views/SeriesTextView.svelte'),
    cloud: () => import('$lib/views/CloudView.svelte'),
    upload: () => import('$lib/views/UploadView.svelte'),
    'reading-speed': () => import('$lib/views/ReadingSpeedView.svelte'),
    'merge-series': () => import('$lib/views/MergeSeriesView.svelte')
  };

  // Currently loaded component
  let CurrentComponent: Component | null = $state(null);
  let loading = $state(true);

  // Track which view type we're loading to prevent stale imports from overwriting
  let loadingViewType: View['type'] | null = null;

  // Load component when view changes
  $effect(() => {
    const viewType = $currentView.type;
    loadingViewType = viewType;
    loading = true;

    viewComponents[viewType]()
      .then((module) => {
        // Only apply if this is still the view we want (prevents race condition)
        if (loadingViewType === viewType) {
          CurrentComponent = module.default;
          loading = false;
        }
      })
      .catch((error) => {
        if (loadingViewType === viewType) {
          console.error(`Failed to load view component for ${viewType}:`, error);
          loading = false;
        }
      });
  });

  onMount(() => {
    // Initialize hash router and get cleanup function
    const cleanup = initRouter();
    return cleanup;
  });
</script>

{#if loading}
  <div class="flex h-[90svh] items-center justify-center">
    <Spinner size="12" />
  </div>
{:else if CurrentComponent}
  <CurrentComponent />
{/if}
