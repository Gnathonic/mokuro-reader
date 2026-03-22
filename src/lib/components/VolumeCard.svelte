<script lang="ts">
  import type { Attachment } from 'svelte/attachments';
  import { nav } from '$lib/util/hash-router';
  import VolumeProgressBar from '$lib/components/VolumeProgressBar.svelte';
  import VolumeDeadline from '$lib/components/VolumeDeadline.svelte';

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
    subtitle = null
  }: Props = $props();

  function thumbnailAttachment(
    thumbnail: Blob | undefined
  ): Attachment<HTMLImageElement> | undefined {
    if (!thumbnail) {
      return undefined;
    }

    return (element) => {
      const url = URL.createObjectURL(thumbnail);
      element.src = url;

      return () => {
        if (element.src === url) {
          element.removeAttribute('src');
        }
        URL.revokeObjectURL(url);
      };
    };
  }
</script>

<div
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
      <img
        alt={volumeTitle || 'Volume Cover'}
        class="mb-3 rounded"
        style="max-width: 125px; max-height: 180px; height: auto;"
        {@attach thumbnailAttachment(thumbnail)}
      />
    </a>
    <div class="pending" style:--progress={progressPercentString}></div>
  </div>

  {#if showProgressBar}
    <VolumeProgressBar {progressPercentString} {remainingPages} {isHovered} />
  {/if}

  {#if showDeadline}
    <VolumeDeadline {volumeId} {pagesReadInPeriod} {targetPagesPerPeriod} />
  {/if}

  {#if subtitle}
    <div class="mt-1 text-center text-xs text-gray-500">{subtitle}</div>
  {/if}
</div>

<style>
  :root {
    --box-width: 125px;
    --box-height: 180px;
    --border-radius: 5px;
    --spacing: 5px;
    --transition-duration: 0.3s;
    --hover-scale: 1.1;
  }

  .imagebox {
    position: relative;
    border: var(--border-style);
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
    background-color: #333;
    opacity: 0.55;
    pointer-events: none;
  }
</style>
