<script lang="ts">
  import type { VolumeMetadata } from '$lib/types';
  import { Spinner } from 'flowbite-svelte';
  import { DownloadSolid } from 'flowbite-svelte-icons';
  import { createCoverClaims } from '$lib/catalog/cover-claims.svelte';

  interface Props {
    /** Number of items to show in stack (1 = single, 2-3 = stacked) */
    count?: number;
    /** Whether download is in progress */
    isDownloading?: boolean;
    /** Show download UI (icon + status text) */
    showDownloadUI?: boolean;
    /** Custom message to display (overrides default) */
    message?: string;
    /** Volume metadata for cloud thumbnail fetching */
    volume?: VolumeMetadata;
    /** Whether to show drop shadow on stacked items */
    dropShadow?: boolean;
  }

  let {
    count = 1,
    isDownloading = false,
    showDownloadUI = false,
    message,
    volume,
    dropShadow = true
  }: Props = $props();

  // Limit stack to 3 items max
  let stackCount = $derived(Math.min(Math.max(count, 1), 3));

  // Step sizes for stacking effect
  const stepH = 35;
  let stepV = $derived(stackCount > 1 ? Math.min(40, 35 / (stackCount - 1)) : 0);

  // Cloud thumbnail state — an object URL over `volume.thumbnail`, kept in sync with it.
  // This effect only manages the object URL's lifecycle (create/revoke), never the fetch.
  //
  // A ROW's cover only. A cloud volume with no row of its own — a placeholder, or a
  // metadata-only row a series open materialized — has its cover in `cloud_covers`, and
  // that one is resolved by path below.
  let cloudThumbnailUrl: string | null = $state(null);

  /**
   * THIS BOX RESOLVES ITS OWN CLOUD COVER.
   *
   * Cloud covers used to arrive on the `volume` prop: `generatePlaceholders` stamped the
   * cached blob onto every placeholder it minted, and the catalog decorated a
   * metadata-only row's copy the same way. That is exactly what made one cover landing
   * re-derive the whole library and re-render every mounted card (a measured 1,784 ms
   * long task on a 1,027-series library), so covers were cut out of the derivation. This
   * is the replacement for the surfaces that box draws: one keyed `cloud_covers` read for
   * the one volume on screen.
   *
   * The path comes from the LISTING-derived object — `cloudPath` is decorated onto the
   * catalog's in-memory copy and is NEVER persisted on a stored row, so it is only ever
   * present on the props handed down from the catalog, which is what these are.
   */
  const coverClaims = createCoverClaims({
    claims: () => (volume ? [volume] : []),
    targets: () => (volume ? [volume] : [])
  });
  const { gate } = coverClaims;

  /** The resolved cover's object URL, minted lazily and revoked by the resolver. */
  let resolvedCoverUrl = $derived(coverClaims.cover?.url ?? null);

  /** Row cover first, resolver cover second — a row that HAS a thumbnail always wins. */
  let displayUrl = $derived(cloudThumbnailUrl ?? resolvedCoverUrl);

  // A CATALOG-WIDE re-derive (any row anywhere committing) hands every mounted card a
  // BRAND NEW `volume` object, even for a row whose own cover has not changed — Dexie
  // gives back a fresh `File` instance per read regardless. Without this key, the effect
  // below would treat every re-derive as "a new cover", tearing down and recreating the
  // object URL (and forcing the browser to re-decode/re-paint the `<img>`) for every
  // already-painted card on screen, every time. `size`+`lastModified` is cheap to compare
  // and, unlike object identity, survives a structured-clone round trip through IndexedDB
  // unchanged — a GENUINELY new cover (a fresh fetch, a self-heal overwrite) always gets a
  // new `lastModified` (see `cloud-thumbnails.ts`), so this never masks a real update.
  let renderedCoverKey: string | null = null;
  let activeThumbnailUrl: string | null = null; // mirrors `cloudThumbnailUrl`; read/written outside reactivity so comparing it never itself triggers a re-run.

  function releaseActiveThumbnailUrl(): void {
    if (activeThumbnailUrl) {
      URL.revokeObjectURL(activeThumbnailUrl);
      activeThumbnailUrl = null;
    }
  }

  $effect(() => {
    const file = volume?.thumbnail;
    const uuid = volume?.volume_uuid;
    const key = file && uuid ? `${uuid}:${file.size}:${file.lastModified}` : null;
    if (key === renderedCoverKey) return; // Same cover as already rendered — nothing to do.
    renderedCoverKey = key;

    releaseActiveThumbnailUrl();
    if (!file) {
      cloudThumbnailUrl = null;
      return;
    }
    const url = URL.createObjectURL(file);
    activeThumbnailUrl = url;
    cloudThumbnailUrl = url;
  });

  // Revoke whatever is active when this component is torn down. Deliberately a SEPARATE
  // effect with no reactive reads of its own (so it runs its body once, on mount, and its
  // cleanup only on unmount) — folding this into the effect above would tie revocation to
  // Svelte's automatic "run the previous cleanup before every re-run" behavior, which fires
  // on EVERY re-run regardless of the early return above and would revoke a URL this
  // component is still actively showing.
  $effect(() => {
    return () => releaseActiveThumbnailUrl();
  });
</script>

{#if displayUrl}
  <!-- Cloud thumbnail loaded: render like VolumeItem's local thumbnail -->
  <!-- use:gate on BOTH branches: this box swaps its root element the moment a cover
       lands, and the gate has to survive that swap (it latches, so the second attach is
       a no-op). Still armed here because a row that already HAS a cover can be a
       self-heal target — a stale stamp against the listing's current one. -->
  <div use:gate class="flex items-center justify-center sm:h-[350px] sm:w-[250px]">
    <img
      src={displayUrl}
      alt={volume?.volume_title || ''}
      style="max-width: 250px; max-height: 350px; width: auto; height: auto;"
      class="border border-gray-300 bg-gray-100 dark:border-gray-900 dark:bg-black"
    />
    {#if showDownloadUI}
      <div class="absolute right-2 bottom-2 rounded-full bg-black/60 p-1.5">
        {#if isDownloading}
          <Spinner size="4" color="blue" />
        {:else}
          <DownloadSolid class="h-4 w-4 text-blue-400" />
        {/if}
      </div>
    {/if}
  </div>
{:else}
  <!-- Placeholder boxes (thumbnail loading or unavailable) -->
  <div
    use:gate
    class="relative overflow-hidden sm:h-[350px] sm:w-[250px]"
    class:sm:h-[385px]={stackCount > 1}
    class:sm:w-[325px]={stackCount > 1}
  >
    {#each Array(stackCount) as _, i}
      <div
        class="flex items-center justify-center bg-gray-200 sm:h-[350px] sm:w-[250px] dark:bg-gray-800"
        class:border={dropShadow}
        class:border-gray-300={dropShadow}
        class:dark:border-gray-600={dropShadow}
        class:absolute={stackCount > 1}
        style={stackCount > 1
          ? `left: ${i * stepH}px; top: ${i * stepV}px; z-index: ${stackCount - i};${dropShadow ? ' filter: drop-shadow(2px 4px 6px rgba(0, 0, 0, 0.5));' : ''}`
          : ''}
      >
        {#if i === 0}
          {#if showDownloadUI}
            <div class="flex flex-col items-center gap-3">
              {#if isDownloading}
                <Spinner size="16" color="blue" />
                <span class="text-sm text-gray-300">Downloading...</span>
              {:else}
                <DownloadSolid class="h-16 w-16 text-blue-400" />
                <span class="text-sm text-gray-300">{message || 'Click to download'}</span>
              {/if}
            </div>
          {:else}
            <span class="text-gray-300">{message || 'No thumbnail'}</span>
          {/if}
        {/if}
      </div>
    {/each}
  </div>
{/if}
