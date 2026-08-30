<script lang="ts">
  import { nav } from '$lib/util/hash-router';
  import VolumeProgressBar from '$lib/components/VolumeProgressBar.svelte';
  import VolumeDeadline from '$lib/components/VolumeDeadline.svelte';
  import PlaceholderThumbnail from '$lib/components/PlaceholderThumbnail.svelte';

  interface Props {
    volumeId: string;
    seriesId: string | undefined;
    volumeTitle: string | undefined;
    thumbnail: Blob | undefined;
    progressPercentString: string;
    remainingPages: number;
    isHovered: boolean;
    onHover: (volumeId: string | null) => void;
    showProgressBar?: boolean;
    showDeadline?: boolean;
    pagesReadInPeriod?: number | null;
    targetPagesPerPeriod?: number | null;
    subtitle?: string | null;
    /** The view's clock, so the deadline countdown rolls over. */
    now?: number;
  }

  let {
    volumeId,
    seriesId,
    volumeTitle,
    thumbnail,
    progressPercentString,
    remainingPages,
    isHovered,
    onHover,
    showProgressBar = true,
    showDeadline = true,
    pagesReadInPeriod = null,
    targetPagesPerPeriod = null,
    subtitle = null,
    now = Date.now()
  }: Props = $props();

  /*
   * Object URLs are keyed on CONTENT identity, not on the Blob object.
   *
   * The catalog store hands out fresh File objects on every re-read, so an
   * attachment that depends on the blob itself revoked and recreated a URL for
   * every card on screen each time the catalog changed — a page turn is enough.
   * The rest of the app (VolumeItem, CatalogListItem) keys on
   * `uuid:size:lastModified`; this matches.
   */
  let thumbnailKey = $derived(
    thumbnail ? `${volumeId}:${thumbnail.size}:${(thumbnail as File).lastModified ?? 0}` : undefined
  );

  let thumbnailUrl = $state<string | undefined>(undefined);

  $effect(() => {
    // Read the key so the effect re-runs only when the CONTENT changes.
    void thumbnailKey;
    if (!thumbnail) {
      thumbnailUrl = undefined;
      return;
    }

    const url = URL.createObjectURL(thumbnail);
    thumbnailUrl = url;

    return () => {
      thumbnailUrl = undefined;
      URL.revokeObjectURL(url);
    };
  });
</script>

<div
  class="volume-card"
  role="group"
  title={volumeTitle || 'Unknown Title'}
  onmouseenter={() => onHover(volumeId)}
  onmouseleave={() => onHover(null)}
>
  <div class="imagebox">
    <a
      href="#/reader/{seriesId}/{volumeId}"
      onclick={(e) => {
        e.preventDefault();
        if (seriesId) nav.toReader(seriesId, volumeId);
      }}
    >
      {#if thumbnailUrl}
        <img
          alt={volumeTitle || 'Volume Cover'}
          class="mb-3 rounded"
          style="max-width: 125px; max-height: 180px; height: auto;"
          src={thumbnailUrl}
        />
      {:else}
        <!-- A metadata-only or cloud-only volume has no local thumbnail blob.
             A src-less <img> renders the broken-image glyph; the house pattern
             (VolumeItem.svelte) is PlaceholderThumbnail. -->
        <PlaceholderThumbnail message={volumeTitle || 'Volume Cover'} />
      {/if}
    </a>
    <div class="pending bg-gray-950/55" style:--progress={progressPercentString}></div>
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
