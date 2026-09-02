<script lang="ts">
  import { nav } from '$lib/util/hash-router';
  import { downloadQueue } from '$lib/util/download-queue';
  import { needsDownload } from '$lib/catalog/volume-state';
  import { getCloudFileId, getCloudProvider } from '$lib/util/cloud-fields';
  import { showSnackbar } from '$lib/util/snackbar';
  import type { VolumeMetadata } from '$lib/types';
  import VolumeProgressBar from '$lib/components/VolumeProgressBar.svelte';
  import VolumeDeadline from '$lib/components/VolumeDeadline.svelte';
  import PlaceholderThumbnail from '$lib/components/PlaceholderThumbnail.svelte';
  import { createCoverClaims } from '$lib/catalog/cover-claims.svelte';
  import { untrack } from 'svelte';

  interface Props {
    volumeId: string;
    seriesId: string | undefined;
    volumeTitle: string | undefined;
    progressPercentString: string;
    remainingPages: number;
    isHovered: boolean;
    onHover: (volumeId: string | null) => void;
    showProgressBar?: boolean;
    showDeadline?: boolean;
    pagesReadInPeriod?: number | null;
    targetPagesPerPeriod?: number | null;
    subtitle?: string | null;
    /**
     * The catalog row, when there is one. Needed to tell an installed volume
     * from one whose pages are not on this device — the tracker lists and
     * counts both (progress is the volume's, not the file's), but only one of
     * them can be opened.
     */
    volume?: VolumeMetadata;
    /** The view's clock, so the deadline countdown rolls over. */
    now?: number;
  }

  let {
    volumeId,
    seriesId,
    volumeTitle,
    progressPercentString,
    remainingPages,
    isHovered,
    onHover,
    showProgressBar = true,
    showDeadline = true,
    pagesReadInPeriod = null,
    targetPagesPerPeriod = null,
    subtitle = null,
    volume,
    now = Date.now()
  }: Props = $props();

  /*
   * A volume read on another device and never downloaded here still belongs on
   * this page — it has progress, and it counts toward the goal. What it cannot
   * do is open: the reader has no pages to show. Clicking one used to navigate
   * into a dead end. It queues the download instead, the same thing clicking a
   * not-installed volume does everywhere else in the app.
   */
  let isNotInstalled = $derived(volume ? needsDownload(volume) : false);

  /** Can this not-installed volume actually be fetched from somewhere? */
  let downloadable = $derived(!!volume && !!getCloudFileId(volume) && !!getCloudProvider(volume));

  function openOrDownload(event: MouseEvent) {
    event.preventDefault();

    if (!isNotInstalled) {
      if (seriesId) nav.toReader(seriesId, volumeId);
      return;
    }

    /*
     * A not-installed volume is only downloadable when the cloud listing has
     * decorated it with a file id — which it has not while the user is signed
     * out, offline, or simply during the window before the first listing
     * lands. `queueVolume` returns silently in that case, so clicking did
     * literally nothing while the tooltip promised a download. Say what is
     * actually going on instead.
     */
    if (!downloadable) {
      showSnackbar('This volume is not on this device, and no cloud copy is available yet.');
      return;
    }

    downloadQueue.queueVolume(volume!);
  }

  /*
   * THE SHARED COVER EFFECT (`cover-claims.svelte.ts`) — the same three-part
   * rule every other cover-drawing surface runs: claim the cached cover for
   * the row's listing path, ask the one cover service for what is missing
   * once this card is near the viewport, release on unmount.
   *
   * Every volume the tracker lists has reading activity, so a request from
   * here resolves onto the ROW — promoted from `cloud_covers` if the volume
   * was browsed before it was read, fetched otherwise — and this card
   * repaints from `volume.thumbnail` when that write lands. The claim shows
   * the cached cover in the meantime, so a read-elsewhere volume is never a
   * blank box for the round trip.
   *
   * `volume` is the catalog's copy of the row, decorated with the listing's
   * `cloudPath`/`cloudThumbnail*` (never persisted); a tracker entry with no
   * row at all — synced progress whose series has not resolved yet — has no
   * `volume`, claims nothing and asks for nothing.
   */
  const coverClaims = createCoverClaims({
    claims: () => (volume ? [volume] : []),
    targets: () => (volume ? [volume] : [])
  });
  const { gate } = coverClaims;

  /*
   * Object URLs are keyed on CONTENT identity, not on the File object.
   *
   * The catalog store hands out fresh File objects on every re-read, so an
   * attachment that depends on the file itself revoked and recreated a URL for
   * every card on screen each time the catalog changed — a page turn is enough.
   * The rest of the app (VolumeItem, CatalogListItem) keys on
   * `uuid:size:lastModified`; this matches. The file is read UNTRACKED inside
   * the effect so a same-content re-emission cannot re-run it.
   */
  let thumbnailKey = $derived(
    volume?.thumbnail
      ? `${volumeId}:${volume.thumbnail.size}:${volume.thumbnail.lastModified ?? 0}`
      : undefined
  );

  let thumbnailUrl = $state<string | undefined>(undefined);

  $effect(() => {
    // Read the key so the effect re-runs only when the CONTENT changes.
    void thumbnailKey;
    const file = untrack(() => volume?.thumbnail);
    if (!file) {
      thumbnailUrl = undefined;
      return;
    }

    const url = URL.createObjectURL(file);
    thumbnailUrl = url;

    return () => {
      thumbnailUrl = undefined;
      URL.revokeObjectURL(url);
    };
  });

  /** Row cover first, resolver cover second — a row that HAS a thumbnail always wins. */
  let displayUrl = $derived(thumbnailUrl ?? coverClaims.cover?.url);
</script>

<div
  class="volume-card"
  role="group"
  title={volumeTitle || 'Unknown Title'}
  onmouseenter={() => onHover(volumeId)}
  onmouseleave={() => onHover(null)}
>
  <!-- `use:gate` arms the viewport gate the cover request waits on. -->
  <div use:gate class="imagebox">
    <a
      href={isNotInstalled
        ? `#/series/${seriesId ?? ''}`
        : `#/reader/${seriesId ?? ''}/${volumeId}`}
      title={isNotInstalled
        ? downloadable
          ? 'Not on this device — click to download'
          : 'Not on this device, and no cloud copy is available'
        : undefined}
      onclick={openOrDownload}
    >
      {#if displayUrl}
        <img
          alt={volumeTitle || 'Volume Cover'}
          class="mb-3 rounded"
          style="max-width: 125px; max-height: 180px; height: auto;"
          src={displayUrl}
        />
      {:else}
        <!-- No cover on the row and none in the cache yet. A src-less <img>
             renders the broken-image glyph; the house pattern (VolumeItem.svelte)
             is PlaceholderThumbnail. Deliberately NOT handed `volume`: this card
             owns the claim, and a second claim set for the same volume would
             double the reference. -->
        <PlaceholderThumbnail message={volumeTitle || 'Volume Cover'} />
      {/if}
    </a>
    <div class="pending bg-gray-950/55" style:--progress={progressPercentString}></div>
    {#if isNotInstalled}
      <div
        class="absolute right-1 bottom-1 rounded bg-gray-950/75 px-1 py-0.5 text-[10px] text-gray-200"
      >
        Not on device
      </div>
    {/if}
  </div>

  {#if showProgressBar}
    <VolumeProgressBar {progressPercentString} {remainingPages} {isHovered} />
  {/if}

  {#if showDeadline}
    <VolumeDeadline {volumeId} {pagesReadInPeriod} {targetPagesPerPeriod} {now} />
  {/if}

  {#if subtitle}
    <div class="mt-1 text-center text-xs text-gray-500">{subtitle}</div>
  {/if}
</div>

<style>
  /*
   * Scoped to the card, NEVER `:root`. Svelte does not scope `:root`, so a
   * component-level `:root` block escapes into the document — and Tailwind v4
   * compiles every numeric spacing utility to `calc(var(--spacing) * N)`, so a
   * stray `--spacing: 5px` here silently rescaled the whole app's padding,
   * margins and icon sizes the moment this lazy chunk loaded. `--spacing` was
   * never read by any rule in this PR; it is gone rather than renamed.
   *
   * The children (VolumeProgressBar, VolumeDeadline) inherit these.
   */
  .volume-card {
    --box-width: 125px;
    --box-height: 180px;
    --border-radius: 5px;
    --transition-duration: 0.3s;
    --hover-scale: 1.1;
  }

  .imagebox {
    position: relative;
    width: var(--box-width);
    height: var(--box-height);
    overflow: hidden;
    margin: auto;
    border-radius: var(--border-radius) var(--border-radius) 0 0;
  }

  .imagebox a {
    width: 100%;
    position: absolute;
    top: 0;
    left: 0;
    transition: transform var(--transition-duration) ease;
    will-change: transform;
    outline: none;
  }

  .imagebox a:focus,
  .imagebox a:hover {
    transform: scale(var(--hover-scale));
  }

  .imagebox a img {
    min-width: 125px;
    min-height: 180px;
    object-fit: cover;
    object-position: center;
  }

  .pending {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: calc(100% - var(--progress));
    pointer-events: none;
  }
</style>
