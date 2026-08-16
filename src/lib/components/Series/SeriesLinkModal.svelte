<script lang="ts">
  import { Button, Modal, Input, Spinner } from 'flowbite-svelte';
  import { onDestroy } from 'svelte';
  import { showSnackbar } from '$lib/util';
  import {
    anilistProvider,
    parseAniListIdInput,
    toSeriesMetadataPatch
  } from '$lib/metadata/providers/anilist';
  import { createLinkSearch, describeSearchError } from '$lib/metadata/link-search';
  import { updateSeriesMetadata } from '$lib/metadata/store';
  import type { MetadataSearchResult } from '$lib/metadata/provider-interface';

  let {
    open = $bindable(false),
    seriesTitle,
    onLinked
  }: { open?: boolean; seriesTitle: string; onLinked?: () => void } = $props();

  let query = $state('');
  let idInput = $state('');
  let results = $state<MetadataSearchResult[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let linking = $state(false);

  const search = createLinkSearch({
    provider: anilistProvider,
    onResults: (r) => {
      results = r;
      error = null;
    },
    onError: (message) => {
      error = message;
      results = [];
    },
    onLoading: (l) => (loading = l)
  });
  onDestroy(() => search.cancel());

  // Prefill and search when the modal opens
  $effect(() => {
    if (open) {
      query = seriesTitle;
      idInput = '';
      error = null;
      search.setQuery(seriesTitle);
    } else {
      search.cancel();
      results = [];
    }
  });

  // Capture Escape so it doesn't propagate to the series page's back-navigation handler
  $effect(() => {
    if (!open) return;

    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (!linking) open = false;
      }
    }

    window.addEventListener('keydown', handleKeydown, true);
    return () => window.removeEventListener('keydown', handleKeydown, true);
  });

  function onQueryInput(e: Event) {
    query = (e.currentTarget as HTMLInputElement).value;
    search.setQuery(query);
  }

  function primaryTitle(r: MetadataSearchResult): string {
    return r.titles.romaji ?? r.titles.english ?? r.titles.native ?? `#${r.id}`;
  }
  function secondaryTitles(r: MetadataSearchResult): string {
    const primary = primaryTitle(r);
    return [r.titles.native, r.titles.english]
      .filter((t): t is string => !!t && t !== primary)
      .join(' · ');
  }
  function detailLine(r: MetadataSearchResult): string {
    const parts = [r.format, r.year != null ? String(r.year) : null, r.status];
    if (r.volumes != null) parts.push(`${r.volumes} vols`);
    else if (r.chapters != null) parts.push(`${r.chapters} ch`);
    return parts.filter(Boolean).join(' · ');
  }

  async function link(result: MetadataSearchResult) {
    linking = true;
    try {
      await updateSeriesMetadata(seriesTitle, {
        ...toSeriesMetadataPatch(result),
        linked_at: new Date().toISOString()
      });
      showSnackbar(`Linked to AniList: ${primaryTitle(result)}`);
      onLinked?.();
      open = false;
    } catch (e) {
      console.error('Failed to save series link:', e);
      error = 'Could not save the link.';
    } finally {
      linking = false;
    }
  }

  async function linkById() {
    const id = parseAniListIdInput(idInput);
    if (id == null) {
      error = 'Enter an AniList manga ID or URL (e.g. https://anilist.co/manga/30013)';
      return;
    }
    loading = true;
    error = null;
    try {
      const result = await anilistProvider.getById(id);
      if (!result) {
        error = `No AniList manga with id ${id}`;
        return;
      }
      await link(result);
    } catch (e) {
      error = describeSearchError(e);
    } finally {
      loading = false;
    }
  }
</script>

<Modal bind:open size="md" title="Link to AniList" outsideclose>
  <div class="flex flex-col gap-3">
    <Input value={query} oninput={onQueryInput} placeholder="Search AniList…" autofocus />

    {#if loading}
      <div class="flex items-center gap-2 text-sm text-gray-500">
        <Spinner size="4" /> Searching…
      </div>
    {/if}
    {#if error}
      <p class="text-sm text-red-500">{error}</p>
    {/if}

    {#if results.length > 0}
      <ul
        class="max-h-80 divide-y divide-gray-200 overflow-y-auto rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700"
      >
        {#each results as r (r.id)}
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-3 p-2 text-left hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-700"
              disabled={linking}
              onclick={() => link(r)}
            >
              {#if r.coverUrl}
                <img
                  src={r.coverUrl}
                  alt=""
                  class="h-16 w-11 flex-shrink-0 rounded object-cover"
                  loading="lazy"
                />
              {:else}
                <div class="h-16 w-11 flex-shrink-0 rounded bg-gray-200 dark:bg-gray-600"></div>
              {/if}
              <div class="min-w-0 flex-1">
                <div class="truncate font-medium">{primaryTitle(r)}</div>
                {#if secondaryTitles(r)}
                  <div class="truncate text-sm text-gray-500 dark:text-gray-400">
                    {secondaryTitles(r)}
                  </div>
                {/if}
                <div class="text-xs text-gray-400">{detailLine(r)}</div>
              </div>
            </button>
          </li>
        {/each}
      </ul>
    {:else if !loading && !error && query.trim()}
      <p class="text-sm text-gray-500">No results.</p>
    {/if}

    <div class="flex items-center gap-2 pt-2">
      <Input bind:value={idInput} placeholder="…or paste an AniList URL / ID" class="flex-1" />
      <Button size="sm" color="light" onclick={linkById} disabled={loading || linking}
        >Link by ID</Button
      >
    </div>
  </div>

  <!-- relative z-10: night-mode filter on <dialog> creates a stacking context -->
  <div class="relative z-10 flex justify-end gap-2 pt-2">
    <Button color="alternative" onclick={() => (open = false)} disabled={linking}>Cancel</Button>
  </div>
</Modal>
