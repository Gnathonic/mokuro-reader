<script lang="ts">
  import { currentView } from '$lib/util/hash-router';
  import {
    CatalogView,
    SeriesView,
    ReaderView,
    VolumeTextView,
    SeriesTextView,
    CloudView,
    UploadView,
    ReadingSpeedView
  } from '$lib/views';
</script>

{#if $currentView.type === 'catalog'}
  <CatalogView />
{:else if $currentView.type === 'series'}
  <SeriesView />
{:else if $currentView.type === 'reader'}
  <ReaderView />
{:else if $currentView.type === 'volume-text'}
  <VolumeTextView />
{:else if $currentView.type === 'series-text'}
  <SeriesTextView />
{:else if $currentView.type === 'cloud'}
  <CloudView />
{:else if $currentView.type === 'upload'}
  <UploadView />
{:else if $currentView.type === 'reading-speed'}
  <ReadingSpeedView />
{/if}
