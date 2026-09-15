<script lang="ts">
  import { onMount } from 'svelte';
  import { initRouter, currentView, type View } from '$lib/util/hash-router';
  import { Spinner } from 'flowbite-svelte';
  import type { Component } from 'svelte';

  // Dynamic component imports for each view type (same as root page)
  const viewComponents: Record<View['type'], () => Promise<{ default: Component }>> = {
    catalog: () => import('$lib/views/CatalogView.svelte'),
    series: () => import('$lib/views/SeriesView.svelte'),
    reader: () => import('$lib/views/ReaderView.svelte'),
    'volume-text': () => import('$lib/views/VolumeTextView.svelte'),
    'series-text': () => import('$lib/views/SeriesTextView.svelte'),
    cloud: () => import('$lib/views/CloudView.svelte'),
    upload: () => import('$lib/views/UploadView.svelte'),
    'reading-speed': () => import('$lib/views/ReadingSpeedView.svelte'),
    'merge-series': () => import('$lib/views/MergeSeriesView.svelte'),
    'progress-tracker': () => import('$lib/views/ProgressTrackerView.svelte'),
    'manage-goals': () => import('$lib/views/ManageGoalsView.svelte')
  };

  // Currently loaded component
  let CurrentComponent: Component | null = $state(null);
  let loading = $state(true);
  // Which type the in-flight import is for. The heavier views (tracker, goals)
  // can resolve after the user has already moved on, and without this a late
  // chunk would overwrite the newer view with a stale one.
  let loadingViewType: View['type'] | null = null;

  // Hoisted out of the effect on purpose: reading `$currentView.type` inside it
  // would rerun the loader on every store emission, remounting the whole view
  // even when only its params changed (series A -> series B).
  let viewType = $derived($currentView.type);

  // Load component when the view type changes
  $effect(() => {
    const requestedType = viewType;
    loadingViewType = requestedType;
    loading = true;

    viewComponents[requestedType]()
      .then((module) => {
        if (loadingViewType !== requestedType) return;
        CurrentComponent = module.default;
        loading = false;
      })
      .catch((error) => {
        if (loadingViewType !== requestedType) return;
        console.error(`Failed to load view component for ${requestedType}:`, error);
        loading = false;
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
