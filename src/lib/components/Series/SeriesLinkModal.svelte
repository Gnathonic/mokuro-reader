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
  import { getSeriesMetadataForTitle, updateSeriesMetadata } from '$lib/metadata/store';
  import { splitFolderTag } from '$lib/metadata/folder-tag';
  import {
    activeMetadataPermissions,
    canEditSeriesMetadata
  } from '$lib/util/sync/metadata-permissions';
  import type { MetadataSearchResult } from '$lib/metadata/provider-interface';

  let { open = $bindable(false), seriesTitle }: { open?: boolean; seriesTitle: string } = $props();

  // Defense in depth: SeriesLinkControls already disables the buttons that open this modal,
  // but the actions here are gated too — see $lib/util/sync/metadata-permissions.ts.
  // Touches $activeMetadataPermissions so this recomputes if the scope changes after mount.
  let editGate = $derived.by(() => {
    void $activeMetadataPermissions;
    return canEditSeriesMetadata(seriesTitle);
  });

  let query = $state('');
  let idInput = $state('');
  let results = $state<MetadataSearchResult[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let linking = $state(false);
  // The folder name split into a clean search base and its baked-in variant tag
  // (`One Piece (color)` → search "One Piece", offer tag "color").
  let folderTag = $derived(splitFolderTag(seriesTitle).tag);

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
      const { base } = splitFolderTag(seriesTitle);
      query = base;
      idInput = '';
      error = null;
      search.setQuery(base);
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
    if (!editGate.allowed) return;
    linking = true;
    try {
      // Adopt the folder's bracket tag unless the series already has one.
      const existingTag = (await getSeriesMetadataForTitle(seriesTitle))?.tag?.trim();
      await updateSeriesMetadata(seriesTitle, {
        ...toSeriesMetadataPatch(result),
        ...(folderTag && !existingTag ? { tag: folderTag } : {}),
        linked_at: new Date().toISOString()
      });
      showSnackbar(`Linked to AniList: ${primaryTitle(result)}`);
      open = false;
    } catch (e) {
      console.error('Failed to save series link:', e);
      error = 'Could not save the link.';
    } finally {
      linking = false;
    }
  }

  async function linkById() {
    if (!editGate.allowed) return;
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

  // Enter in the paste field submits, like the "Link by ID" button next to it.
  function onIdKeydown(e: KeyboardEvent) {
    if (e.key !== 'Enter' || loading || linking || !editGate.allowed) return;
    e.preventDefault();
    void linkById();
  }
</script>

<Modal bind:open size="md" title="Link to AniList" outsideclose>
  <div class="flex flex-col gap-3">
    <Input
      value={query}
      oninput={onQueryInput}
      disabled={!editGate.allowed}
      placeholder="Search AniList…"
      autofocus
    />
    {#if !editGate.allowed}
      <p class="text-sm text-amber-600 dark:text-amber-400">{editGate.reason}</p>
    {:else if folderTag}
      <p class="text-xs text-gray-500 dark:text-gray-400">
        Folder tag <span class="font-medium">({folderTag})</span> left out of the search; it becomes
        the series tag on link if none is set.
      </p>
    {/if}

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
              class="flex w-full items-center gap-3 p-2 text-left hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-700"
              disabled={linking || !editGate.allowed}
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

    <!-- relative z-10: the night-mode filter on <dialog> creates a stacking context, so the
         scrollable results list above can otherwise capture clicks meant for this row -->
    <div class="relative z-10 flex items-center gap-2 pt-2">
      <Input
        bind:value={idInput}
        placeholder="…or paste an AniList URL / ID"
        class="flex-1"
        disabled={!editGate.allowed}
        onkeydown={onIdKeydown}
      />
      <Button
        size="sm"
        color="light"
        onclick={linkById}
        disabled={loading || linking || !editGate.allowed}>Link by ID</Button
      >
    </div>
  </div>

  <!-- relative z-10: night-mode filter on <dialog> creates a stacking context -->
  <div class="relative z-10 flex justify-end gap-2 pt-2">
    <Button color="alternative" onclick={() => (open = false)} disabled={linking}>Cancel</Button>
  </div>
</Modal>
