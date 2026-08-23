<script lang="ts">
  import type { VolumeMetadata } from '$lib/types';
  import { progress, catalogSettings } from '$lib/settings';
  import { downloadQueue } from '$lib/util/download-queue';
  import { nav } from '$lib/util/hash-router';
  import { promptSeriesEditor } from '$lib/util/modals';
  import { shouldOpenSeriesEditor } from '$lib/util/series-editor-shortcut';
  import { anyModalOpen, shouldTriggerDelete } from '$lib/util/delete-shortcut';
  import { promptSeriesRemoval } from '$lib/catalog/series-delete';
  import { seriesMetadataMap } from '$lib/metadata/store';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import {
    clampSpineOffset,
    clampVolumeOffset,
    getSpineOffsets,
    sameSpineOffsets,
    sameVolumeOffsets,
    scheduleSpineOffsetWrite,
    volumeOffsetsByIndex,
    type SpineOffsetPatch,
    type SpineOffsets
  } from '$lib/metadata/spine-offsets';
  import {
    computeStackLayout,
    hitTestStack,
    spineBadgePlacements
  } from '$lib/util/spine-stack-layout';
  import {
    CARD_BASE_HEIGHT,
    CARD_BASE_WIDTH,
    MAX_CLOUD_STACK,
    computeStepSizes,
    computeUniformHeight,
    getSpineCanvasDimensions,
    selectCardStackVolumes
  } from '$lib/util/spine-stack-geometry';
  import { Spinner } from 'flowbite-svelte';
  import { DownloadSolid } from 'flowbite-svelte-icons';
  import CompositeCanvas from './CompositeCanvas.svelte';
  import DownloadBadge from './DownloadBadge.svelte';
  import { needsDownload } from '$lib/catalog/volume-state';
  import { sortVolumes } from '$lib/catalog/sort-volumes';
  import {
    fetchCloudThumbnail,
    getCachedCloudThumbnail,
    type CloudThumbnailResult
  } from '$lib/catalog/cloud-thumbnails';
  const CATALOG_SCROLL_Y_KEY = 'mokuro:catalog:scroll-y';

  interface Props {
    volumes: VolumeMetadata[]; // Pre-computed by parent - avoids O(N) re-filtering
    providerName?: string; // Shared across all items - avoids repeated lookups
    displayTitle?: string; // Pre-resolved by the catalog store; falls back to series_title
  }

  let { volumes, providerName = 'Cloud', displayTitle }: Props = $props();

  // Volumes are pre-sorted by catalog store (natural sort)
  let seriesVolumes = $derived(volumes);

  // Split into local vs cloud placeholders
  let localVolumes = $derived(seriesVolumes.filter((v) => !v.isPlaceholder));
  let hasLocalVolumes = $derived(localVolumes.length > 0);

  // Find unread volumes (only among local volumes)
  let unreadVolumes = $derived(
    localVolumes.filter((v) => ($progress?.[v.volume_uuid] || 1) < v.page_count - 1)
  );

  // Display volume: first unread, or first local, or first placeholder
  let volume = $derived(unreadVolumes[0] ?? localVolumes[0] ?? seriesVolumes[0]);

  // UI state flag. Completion is the ONE thing a series with rows can say that a cloud-only
  // one cannot: it has read history. Everything else about an absent series' card is the
  // cloud treatment (see `seriesNeedsDownload` below).
  let isComplete = $derived(unreadVolumes.length === 0 && hasLocalVolumes);

  // Not one page of this series is on the device: cloud-only placeholders, rows whose
  // files were removed, or a mix of the two. `needsDownload` covers both absent states —
  // never `isPlaceholder` on its own (see $lib/catalog/volume-state).
  let seriesNeedsDownload = $derived(
    seriesVolumes.length > 0 && seriesVolumes.every(needsDownload)
  );

  /**
   * What the CLOUD half of the stack rule draws.
   *
   * For a series with nothing on the device: every volume. For one that is only PARTLY
   * here: its cloud-only volumes — they are part of the series and belong in the stack,
   * marked, not dropped (the metadata-only rows are already among `localVolumes`, drawn
   * from the covers they kept).
   */
  let cloudStackVolumes = $derived(
    seriesNeedsDownload ? seriesVolumes : seriesVolumes.filter((vol) => vol.isPlaceholder)
  );

  // Those volumes, each carrying whatever cover has been found for it. A cloud
  // placeholder's arrives from the fetch below; a removed row already has one, which is
  // the whole of the difference between the two (it paints immediately instead of popping
  // in). Includes ALL target volumes (not just those with loaded thumbnails) so that
  // stackedVolumes.length is stable. CompositeCanvas skips volumes without thumbnail,
  // so positions are pre-allocated: each thumbnail pops into its fixed slot without
  // shifting existing ones.
  let enrichedPlaceholders = $derived.by(() => {
    if (cloudStackVolumes.length === 0) return [];
    return cloudStackVolumes.map((vol) => {
      const ct = cloudThumbnailData[vol.volume_uuid];
      if (ct) {
        return {
          ...vol,
          thumbnail: ct.file,
          thumbnail_width: ct.width,
          thumbnail_height: ct.height
        };
      }
      return vol;
    });
  });

  // Check if cloud series should use compact layout
  let useCompactForCloud = $derived(
    seriesNeedsDownload && ($catalogSettings?.compactCloudSeries ?? false)
  );

  // Get volumes for stacked thumbnail based on settings.
  // The rule itself lives in $lib/util/spine-stack-geometry so the series editor's spine
  // shelf stacks EXACTLY the same volumes (cloud placeholders capped there too).
  //
  // A series with nothing on the device goes down the CLOUD path of that rule even when
  // its volumes are real rows: `localVolumes` is what the selector reads as "there is
  // something to read here", and a removed series has to stack, cap and collapse exactly
  // like a cloud one — same treatment, only the covers arrive sooner.
  let stackedVolumes = $derived(
    selectCardStackVolumes({
      localVolumes: seriesNeedsDownload ? [] : localVolumes,
      unreadVolumes: seriesNeedsDownload ? [] : unreadVolumes,
      placeholders: enrichedPlaceholders,
      hideRead: $catalogSettings?.hideReadVolumes ?? true,
      stackCount: $catalogSettings?.stackCount ?? 3,
      compactCloud: useCompactForCloud,
      // Keeps a missing volume in its own place in the series rather than after the ones
      // that are here.
      compare: sortVolumes
    })
  );

  let showDropShadow = $derived($catalogSettings?.dropShadow ?? true);

  // Spine offsets live on the synced series record (see $lib/metadata/spine-offsets).
  // Local copies are optimistic: the wheel updates them immediately while the debounced
  // write lands, and they resync from the store once our write has come back around.
  let seriesKey = $derived(normalizeSeriesKey(volume?.series_title ?? ''));
  let storedRecord = $derived($seriesMetadataMap.get(seriesKey));
  let storedOffsets = $derived(getSpineOffsets(storedRecord));

  // Per-series horizontal offset adjustment, in percent
  let hOffsetAdjust = $state(0);
  // Per-volume horizontal offset adjustments (volume_uuid → pixels)
  let volumeOffsetsByUuid = $state<Record<string, number>>({});
  let pendingOffsetWrites = $state(0);
  // The record our last write produced, until the store echoes it back. Deliberately not
  // reactive: only the effect below clears it, and it must not re-trigger that effect.
  let awaitingEcho: { offsets: SpineOffsets; updatedAt: string } | null = null;

  $effect(() => {
    const stored = storedOffsets;
    const storedUpdatedAt = storedRecord?.updated_at ?? '';
    // While a write of ours is in flight the local values are the newer truth.
    if (pendingOffsetWrites > 0) return;
    if (awaitingEcho) {
      // The write resolves when its transaction commits, but the liveQuery emission lands
      // a beat later — until it does, `stored` is still the PRE-write record and applying
      // it would visibly bounce the stack back for ~300 ms after every gesture. Wait for
      // the emission that carries our own values (or, if another writer got in after us,
      // for anything strictly newer, so this can never wedge).
      const settled =
        sameSpineOffsets(stored, awaitingEcho.offsets) || storedUpdatedAt > awaitingEcho.updatedAt;
      if (!settled) return;
      awaitingEcho = null;
    }
    // Assign only on a real change: `seriesMetadataMap` emits on ANY series' metadata write
    // (a tag edit, a tracking push, a sync), and a fresh-but-equal object here would
    // invalidate containerDimensions → stepSizes → the canvas draw on every mounted card.
    if (hOffsetAdjust !== stored.spineOffset) hOffsetAdjust = stored.spineOffset;
    if (!sameVolumeOffsets(volumeOffsetsByUuid, stored.volumeOffsets)) {
      volumeOffsetsByUuid = stored.volumeOffsets;
    }
  });

  function writeSpineOffsets(patch: SpineOffsetPatch) {
    const seriesTitle = volume?.series_title;
    if (!seriesTitle) return;
    // Nothing queued and the gesture landed back on what is already stored (a reset on a
    // series that never had offsets): skip the write rather than create an empty record /
    // bump `updated_at` for nothing. With a write still queued the patch is corrective —
    // it has to go out to undo what that queued write is about to store.
    if (
      pendingOffsetWrites === 0 &&
      sameSpineOffsets(storedOffsets, {
        spineOffset: hOffsetAdjust,
        volumeOffsets: volumeOffsetsByUuid
      })
    ) {
      return;
    }
    pendingOffsetWrites++;
    void scheduleSpineOffsetWrite(seriesTitle, patch)
      .then((written) => {
        if (written) {
          awaitingEcho = { offsets: getSpineOffsets(written), updatedAt: written.updated_at };
        }
      })
      .finally(() => {
        pendingOffsetWrites--;
      });
  }

  // Index-keyed view of the offsets for the stack currently on screen. Keyed by uuid in
  // storage precisely because this list changes (hideReadVolumes, stackCount), so an
  // index-keyed record would drift onto the wrong volume.
  let volumeOffsets = $derived(volumeOffsetsByIndex(stackedVolumes, volumeOffsetsByUuid));

  let isHovered = $state(false);
  let modifierState = $state<'none' | 'shift' | 'alt-shift'>('none');
  let hoveredVolumeIndex = $state<number | null>(null);
  let containerEl = $state<HTMLElement | null>(null);
  let outerEl = $state<HTMLElement | null>(null);

  const ADJUST_STEP = 0.25; // % per scroll tick for series
  const VOLUME_ADJUST_STEP = 1; // pixels per scroll tick for individual volume

  // Cumulative offset at index i = sum of volumeOffsets[0..i-1]
  // Each volume's offset pushes all subsequent volumes
  function getCumulativeOffset(index: number): number {
    let total = 0;
    for (let i = 0; i < index; i++) {
      total += volumeOffsets.get(i) ?? 0;
    }
    return total;
  }

  // Total cascading offset across all volumes (affects container sizing)
  // Only offsets 0..N-2 matter; the last volume's offset has no volume after it
  function getCumulativeOffsetTotal(count: number): number {
    return getCumulativeOffset(count - 1);
  }

  function updateModifierState(e: KeyboardEvent | MouseEvent) {
    if (e.shiftKey && e.altKey) {
      modifierState = 'alt-shift';
    } else if (e.shiftKey) {
      modifierState = 'shift';
    } else {
      modifierState = 'none';
    }
  }

  function handleKeyChange(e: KeyboardEvent) {
    if (!isHovered) return;
    if (e.type === 'keydown' && shouldOpenSeriesEditor(e, isHovered, document.activeElement)) {
      e.preventDefault();
      if (volume) promptSeriesEditor(volume.series_title);
      return;
    }
    // Hover + Delete raises the series page's own "Remove manga" dialog — the same
    // prompt, with the same forget/cloud checkboxes. Shift is left alone: the card has
    // no cloud-only delete to map it to.
    if (
      e.type === 'keydown' &&
      !e.shiftKey &&
      shouldTriggerDelete(e, isHovered, document.activeElement, anyModalOpen())
    ) {
      e.preventDefault();
      void promptSeriesRemoval(seriesVolumes);
      return;
    }
    updateModifierState(e);
  }

  function handleWheel(e: WheelEvent) {
    if (!isHovered) return;
    updateModifierState(e);

    // Holding shift makes some browsers (Chrome) report a vertical wheel as deltaX, so the
    // gesture's direction has to come from whichever axis actually carries it.
    const wheelDelta = e.deltaY || e.deltaX;

    // No delta on either axis is no gesture. Without this, `wheelDelta > 0 ? … : …` reads a
    // stationary wheel as "up" and every stray event nudges the offset by a step.
    if (wheelDelta === 0) return;

    if (e.shiftKey && e.altKey && hoveredVolumeIndex !== null) {
      // Alt+Shift+Scroll: adjust individual volume
      const target = stackedVolumes[hoveredVolumeIndex];
      if (!target) return;
      e.preventDefault();
      const delta = wheelDelta > 0 ? -VOLUME_ADJUST_STEP : VOLUME_ADJUST_STEP;
      setVolumeOffset(target.volume_uuid, (volumeOffsetsByUuid[target.volume_uuid] ?? 0) + delta);
    } else if (e.shiftKey && !e.altKey) {
      // Shift+Scroll: adjust series offset
      e.preventDefault();
      const delta = wheelDelta > 0 ? -ADJUST_STEP : ADJUST_STEP;
      // Clamped with the same rule the writer applies, so the stack never shows a value
      // that storage would refuse.
      hOffsetAdjust = clampSpineOffset(hOffsetAdjust + delta);
      writeSpineOffsets({ spineOffset: hOffsetAdjust });
    }
  }

  function setVolumeOffset(volumeUuid: string, value: number) {
    const px = clampVolumeOffset(value);
    const next = { ...volumeOffsetsByUuid };
    if (px === 0) delete next[volumeUuid];
    else next[volumeUuid] = px;
    volumeOffsetsByUuid = next;
    // 0 tells the writer to delete this volume's key rather than store a no-op.
    writeSpineOffsets({ volumeOffsets: { [volumeUuid]: px } });
  }

  function handleContextMenu(e: MouseEvent) {
    if (e.shiftKey && e.altKey && hoveredVolumeIndex !== null) {
      // Alt+Shift+RMB: reset individual volume offset
      const target = stackedVolumes[hoveredVolumeIndex];
      if (!target) return;
      e.preventDefault();
      setVolumeOffset(target.volume_uuid, 0);
    } else if (e.shiftKey && !e.altKey) {
      // Shift+RMB: reset series offset
      e.preventDefault();
      hOffsetAdjust = 0;
      writeSpineOffsets({ spineOffset: 0 });
    }
  }

  // Determine which volume index the mouse is over based on cascading positions
  function handleMouseMove(e: MouseEvent) {
    updateModifierState(e);
    if (!containerEl || stackedVolumes.length <= 1) {
      hoveredVolumeIndex = 0;
      return;
    }

    const rect = containerEl.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;

    const sizes =
      stackedVolumes.length > 0 && hasRenderableThumbnails ? stepSizes : placeholderStepSizes;
    const count = stackedVolumes.length;

    // Shared with the series editor's spine showcase so both agree on which spine a
    // pointer is over. `leftOffset` is the stack's own inset, so the hit test runs in
    // stack-local coordinates; past every spine's right edge falls back to the back-most
    // volume (nothing is drawn there, but the nudge gesture still needs a target).
    const layout = computeStackLayout({
      count,
      baseWidth: BASE_WIDTH,
      horizontalStepPx: sizes.horizontal,
      volumeOffsetsByIndex: volumeOffsets
    });
    hoveredVolumeIndex = hitTestStack(layout, mouseX - sizes.leftOffset, BASE_WIDTH) ?? count - 1;
  }

  $effect(() => {
    if (isHovered) {
      window.addEventListener('keydown', handleKeyChange);
      window.addEventListener('keyup', handleKeyChange);
      // Non-passive wheel listener so we can preventDefault on shift+scroll
      outerEl?.addEventListener('wheel', handleWheel as EventListener, { passive: false });
      return () => {
        window.removeEventListener('keydown', handleKeyChange);
        window.removeEventListener('keyup', handleKeyChange);
        outerEl?.removeEventListener('wheel', handleWheel as EventListener);
      };
    } else {
      modifierState = 'none';
    }
  });

  // Key for CompositeCanvas - forces fresh component on settings change
  let volumeOffsetsKey = $derived(
    [...volumeOffsets.entries()].map(([k, v]) => `${k}:${v}`).join(',')
  );
  let compositeKey = $derived(
    `${$catalogSettings?.stackCount ?? 3}-${$catalogSettings?.horizontalStep ?? 11}-${$catalogSettings?.verticalStep ?? 5}-${($catalogSettings?.compactCloudSeries ?? false) ? 'compact' : 'full'}-${showDropShadow}-${hOffsetAdjust}-${volumeOffsetsKey}`
  );

  /**
   * Where to mark the individual spines whose pages are not on this device, for a series
   * that still has something to read. The placement rule is shared with the series
   * editor's spine shelf (`spineBadgePlacements`), so both ride the painted spines the
   * same way, and it is overlays only — the card's geometry is untouched.
   *
   * Skipped entirely when the WHOLE series is absent: the card is then the cloud card,
   * which carries one mark of its own (see `absentMark`), and marking every spine on top
   * of it would say the same thing four times.
   */
  let stackBadges = $derived.by(() => {
    if (seriesNeedsDownload || !hasRenderableThumbnails) return [];
    // Nothing in the drawn stack is absent: skip the placement pass entirely. In spine
    // mode this derived re-runs on every wheel tick, over every card on screen.
    if (!stackedVolumes.some(needsDownload)) return [];

    return spineBadgePlacements({
      volumes: stackedVolumes,
      // A volume with no pixels is not painted, so it has no corner to mark.
      isMarked: (vol) => needsDownload(vol) && !!vol.thumbnail,
      drawnSize: (vol) => getCanvasDimensions(vol.volume_uuid),
      horizontalStepPx: stepSizes.horizontal,
      verticalStepPx: stepSizes.vertical,
      topOffsetPx: stepSizes.topOffset,
      canvasWidth: containerDimensions.innerWidth,
      volumeOffsetsByIndex: volumeOffsets
    });
  });

  // Visual indicator state
  let showSeriesIndicator = $derived(isHovered && modifierState === 'shift');
  let showVolumeIndicator = $derived(isHovered && modifierState === 'alt-shift');

  // Check if this series is downloading or queued
  let isDownloading = $derived(
    seriesNeedsDownload && volume
      ? $downloadQueue.some((item) => item.seriesTitle === volume.series_title)
      : false
  );

  // Cloud thumbnail data keyed by volume_uuid (File objects, no blob URLs needed)
  let cloudThumbnailData: Record<string, CloudThumbnailResult> = $state({});

  // Base thumbnail dimensions (shared with the series editor's spine shelf)
  const BASE_WIDTH = CARD_BASE_WIDTH;
  const BASE_HEIGHT = CARD_BASE_HEIGHT;
  const OUTER_PADDING = 25; // pt-4 pb-6 ≈ 25px

  // Get dimensions from volume metadata, with fallback to defaults
  let thumbnailDimensions = $derived.by(() => {
    const dims = new Map<string, { width: number; height: number }>();
    for (const vol of stackedVolumes) {
      if (vol.thumbnail_width && vol.thumbnail_height) {
        dims.set(vol.volume_uuid, {
          width: vol.thumbnail_width,
          height: vol.thumbnail_height
        });
      } else if (vol.thumbnail) {
        // Fallback to default aspect ratio for volumes without stored dimensions
        dims.set(vol.volume_uuid, {
          width: BASE_WIDTH,
          height: BASE_HEIGHT
        });
      }
    }
    return dims;
  });

  // Local series can briefly have no usable thumbnail while generation catches up.
  // In that window, render a stable placeholder stack instead of a blank canvas.
  let hasRenderableThumbnails = $derived(thumbnailDimensions.size > 0);

  // Thumbnail dimensions in stack order (undefined where a thumbnail is still missing) —
  // the shape the shared geometry module works in.
  let stackedDims = $derived(stackedVolumes.map((vol) => thumbnailDimensions.get(vol.volume_uuid)));

  // Calculate uniform height when vertical offset is 0 or stack count is 0 (spine mode)
  let uniformHeight = $derived(
    computeUniformHeight({
      dims: stackedDims,
      verticalStepPct: $catalogSettings?.verticalStep ?? 5,
      stackCountSetting: $catalogSettings?.stackCount ?? 3,
      baseWidth: BASE_WIDTH,
      baseHeight: BASE_HEIGHT
    })
  );

  // Get the rendered width of the top (first) volume - defines the left edge of the stack
  // Wider volumes underneath will be clipped by overflow-hidden
  let topVolumeWidth = $derived(
    getSpineCanvasDimensions(stackedDims[0], uniformHeight, BASE_WIDTH, BASE_HEIGHT)?.width ??
      BASE_WIDTH
  );

  // Calculate container dimensions based on settings
  let containerDimensions = $derived.by(() => {
    // Use compact settings for cloud series if enabled
    if (useCompactForCloud) {
      return {
        innerWidth: BASE_WIDTH,
        innerHeight: BASE_HEIGHT,
        outerWidth: BASE_WIDTH,
        outerHeight: BASE_HEIGHT + OUTER_PADDING
      };
    }

    const stackCountSetting = $catalogSettings?.stackCount ?? 3;
    const hOffsetPercent = (($catalogSettings?.horizontalStep ?? 11) + hOffsetAdjust) / 100;
    // Force vertical offset to 0 when stack count is 0 (all volumes / spine mode)
    const vOffsetPercent =
      stackCountSetting === 0 ? 0 : ($catalogSettings?.verticalStep ?? 5) / 100;

    // stackedVolumes.length is now always the target count (stable for both local and cloud)
    const volumeCount = stackedVolumes.length;
    const effectiveStackCount = stackCountSetting === 0 ? volumeCount : stackCountSetting;

    // topVolumeWidth falls back to BASE_WIDTH when no thumbnail dimensions are available yet
    const baseWidth = topVolumeWidth;

    // Extra space needed for stacking: offset% × base × (count - 1)
    const extraWidth = BASE_WIDTH * hOffsetPercent * (effectiveStackCount - 1);
    const extraHeight = BASE_HEIGHT * vOffsetPercent * (effectiveStackCount - 1);

    // Per-volume offsets cascade: each offset shifts all subsequent volumes
    const cumulativeOffsetPx = getCumulativeOffsetTotal(effectiveStackCount);

    // Inner container (thumbnail area) — clamp so it never shrinks below one volume
    const innerWidth = Math.max(
      BASE_WIDTH,
      Math.round(baseWidth + extraWidth + cumulativeOffsetPx)
    );
    const innerHeight = Math.round(BASE_HEIGHT + extraHeight);

    // Outer container (with padding)
    const outerWidth = innerWidth;
    const outerHeight = innerHeight + OUTER_PADDING;

    return {
      innerWidth,
      innerHeight,
      outerWidth,
      outerHeight
    };
  });

  // Calculate canvas dimensions for a volume thumbnail
  function getCanvasDimensions(volumeUuid: string): { width: number; height: number } | null {
    return getSpineCanvasDimensions(
      thumbnailDimensions.get(volumeUuid),
      uniformHeight,
      BASE_WIDTH,
      BASE_HEIGHT
    );
  }

  // Calculate step sizes and centering/spreading offsets
  let stepSizes = $derived(
    computeStepSizes({
      stackCountSetting: $catalogSettings?.stackCount ?? 3,
      horizontalStepPct: $catalogSettings?.horizontalStep ?? 11,
      verticalStepPct: $catalogSettings?.verticalStep ?? 5,
      hOffsetAdjust,
      centerHorizontal: $catalogSettings?.centerHorizontal ?? true,
      centerVertical: $catalogSettings?.centerVertical ?? false,
      actualCount: stackedVolumes.length,
      innerWidth: containerDimensions.innerWidth,
      innerHeight: containerDimensions.innerHeight,
      uniformHeight,
      dims: stackedDims,
      baseWidth: BASE_WIDTH,
      baseHeight: BASE_HEIGHT
    })
  );

  // Calculate step sizes for placeholder thumbnails: the same rule over all series volumes,
  // drawn as uniform base-size boxes (no thumbnails yet) in the capped number of slots the
  // container was sized for.
  let placeholderStepSizes = $derived.by(() => {
    // Use compact settings for cloud series if enabled
    if (useCompactForCloud) {
      return {
        count: 1,
        horizontal: 0,
        vertical: 0,
        leftOffset: 0,
        topOffset: 0
      };
    }

    const stackCountSetting = $catalogSettings?.stackCount ?? 3;
    const maxCount = seriesNeedsDownload
      ? stackCountSetting === 0
        ? MAX_CLOUD_STACK
        : Math.min(stackCountSetting, MAX_CLOUD_STACK)
      : stackCountSetting;
    const actualCount = Math.min(seriesVolumes.length, maxCount);

    return {
      count: actualCount,
      ...computeStepSizes({
        stackCountSetting,
        horizontalStepPct: $catalogSettings?.horizontalStep ?? 11,
        verticalStepPct: $catalogSettings?.verticalStep ?? 5,
        hOffsetAdjust,
        centerHorizontal: $catalogSettings?.centerHorizontal ?? true,
        centerVertical: $catalogSettings?.centerVertical ?? false,
        actualCount,
        effectiveStackCount: maxCount,
        innerWidth: containerDimensions.innerWidth,
        innerHeight: containerDimensions.innerHeight,
        // Placeholder boxes are always full base size.
        uniformHeight: BASE_HEIGHT,
        dims: [],
        baseWidth: BASE_WIDTH,
        baseHeight: BASE_HEIGHT
      })
    };
  });

  // Fetch cloud thumbnails for visible placeholder volumes
  // Fetch targets are computed from stable inputs only (seriesVolumes, catalogSettings)
  // to avoid a reactive cycle: thumbnails loaded → containerDimensions changed →
  // placeholderStepSizes recomputed → effect re-triggered → cleanup resets data → loop
  $effect(() => {
    const stackCount = $catalogSettings?.stackCount ?? 3;
    const maxCount = stackCount === 0 ? MAX_CLOUD_STACK : Math.min(stackCount, MAX_CLOUD_STACK);
    const count = useCompactForCloud ? 1 : maxCount;
    // Whatever the cloud half of the stack can draw — an absent series' whole stack, or the
    // cloud-only tail of a series that is partly here. A volume that already has its cover
    // locally (a removed row keeps it) has nothing to fetch.
    const vols = cloudStackVolumes
      .filter((vol) => !vol.thumbnail && !!vol.cloudThumbnailFileId)
      .slice(0, count);
    if (vols.length === 0) return;
    let cancelled = false;

    for (const vol of vols) {
      // Check synchronous cache first
      const cached = getCachedCloudThumbnail(vol.volume_uuid);
      if (cached) {
        cloudThumbnailData[vol.volume_uuid] = cached;
        continue;
      }

      // Fetch async
      fetchCloudThumbnail(vol).then((result) => {
        if (cancelled || !result) return;
        console.log(
          `[CatalogItem] Cloud thumbnail loaded: ${vol.volume_title} ${result.width}x${result.height}`
        );
        cloudThumbnailData[vol.volume_uuid] = result;
      });
    }

    return () => {
      cancelled = true;
      // Don't reset cloudThumbnailData - File objects don't need cleanup (unlike blob URLs),
      // and resetting triggers expensive enrichedPlaceholders → template flip-flop when the
      // parent re-renders (e.g., from local thumbnail processing updating the catalog store)
    };
  });

  // Use series title for navigation so grouping and routing align with user-visible identity.
  let navId = $derived(volume?.series_title || '');

  function persistCatalogScrollPosition() {
    const y = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    sessionStorage.setItem(CATALOG_SCROLL_Y_KEY, String(y));
  }

  async function handleClick(e: MouseEvent) {
    e.preventDefault();
    persistCatalogScrollPosition();
    nav.toSeries(navId);
  }
</script>

<!-- Nothing of this series is here: the same mark every absent volume gets, on whichever
     cover stack the card ended up drawing (real thumbnails, or the boxes it falls back to
     while they are generated). Named for screen readers: on a card it is the only cue. -->
{#snippet absentMark()}
  {#if seriesNeedsDownload}
    {#if isDownloading}
      <div
        class="pointer-events-none absolute right-2 bottom-8 z-10 rounded-full bg-black/60 p-1.5"
      >
        <Spinner size="4" color="blue" />
      </div>
    {:else}
      <DownloadBadge class="right-2 bottom-8" label="Not on this device" />
    {/if}
  {/if}
{/snippet}

{#if volume}
  <a href="#/series/{encodeURIComponent(navId)}" onclick={handleClick}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={outerEl}
      class:text-green-400={isComplete}
      class:opacity-70={seriesNeedsDownload}
      class="relative flex flex-col items-center gap-[5px] rounded-lg border-2 p-3 text-center transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
      class:border-transparent={!showSeriesIndicator}
      class:border-blue-400={showSeriesIndicator}
      class:border-dashed={showSeriesIndicator}
      class:cursor-pointer={seriesNeedsDownload}
      onmouseenter={() => (isHovered = true)}
      onmouseleave={() => {
        isHovered = false;
        hoveredVolumeIndex = null;
      }}
      onmousemove={handleMouseMove}
      oncontextmenu={handleContextMenu}
    >
      {#if stackedVolumes.length > 0 && hasRenderableThumbnails}
        <!-- CompositeCanvas - unified for BOTH local and cloud thumbnails -->
        <div
          class="relative pt-4 pb-6"
          style="width: {containerDimensions.outerWidth}px; height: {containerDimensions.outerHeight}px;"
        >
          <div
            bind:this={containerEl}
            class="relative overflow-hidden"
            style="width: {containerDimensions.innerWidth}px; height: {containerDimensions.innerHeight}px;"
          >
            {#key compositeKey}
              <CompositeCanvas
                volumes={stackedVolumes}
                canvasWidth={containerDimensions.innerWidth}
                canvasHeight={containerDimensions.innerHeight}
                {getCanvasDimensions}
                {stepSizes}
                dropShadow={showDropShadow}
                {volumeOffsets}
                highlightIndex={showVolumeIndicator ? hoveredVolumeIndex : null}
              />
            {/key}
            {#each stackBadges as mark (stackedVolumes[mark.index].volume_uuid)}
              <!-- Named: on a card that is otherwise a normal library card, this badge is
                   the only thing that says the volume under it is not here. -->
              <DownloadBadge
                size="sm"
                class=""
                style="left: {mark.left}px; top: {mark.top}px;"
                label="{stackedVolumes[mark.index].volume_title} not on this device"
              />
            {/each}
          </div>
          {@render absentMark()}
        </div>
      {:else if seriesNeedsDownload}
        <!-- Nothing here to draw a cover from: the download boxes. Not "Generating…" —
             nothing is generating a cover for a series whose pages are all gone. -->
        <div
          class="relative pt-4 pb-6"
          style="width: {containerDimensions.outerWidth}px; height: {containerDimensions.outerHeight}px;"
        >
          <div
            class="relative overflow-hidden"
            style="width: {containerDimensions.innerWidth}px; height: {containerDimensions.innerHeight}px;"
          >
            {#each Array(placeholderStepSizes.count) as _, i}
              <div
                class="absolute flex items-center justify-center bg-gray-200 dark:bg-gray-800"
                class:border={showDropShadow}
                class:border-gray-300={showDropShadow}
                class:dark:border-gray-600={showDropShadow}
                style="width: {BASE_WIDTH}px; height: {BASE_HEIGHT}px; left: {placeholderStepSizes.leftOffset +
                  i * placeholderStepSizes.horizontal +
                  getCumulativeOffset(i)}px; top: {placeholderStepSizes.topOffset +
                  i * placeholderStepSizes.vertical}px; z-index: {placeholderStepSizes.count -
                  i};{showDropShadow
                  ? ' filter: drop-shadow(2px 4px 6px rgba(0, 0, 0, 0.5));'
                  : ''}"
              >
                {#if i === 0}
                  <div class="flex flex-col items-center gap-3">
                    {#if isDownloading}
                      <Spinner size="16" color="blue" />
                      <span class="text-sm text-gray-300">Downloading...</span>
                    {:else}
                      <DownloadSolid class="h-16 w-16 text-blue-400" />
                      <span class="text-sm text-gray-300">Click to download</span>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
          <!-- No badge here: the 64px download icon and "Click to download" under it ARE
               the mark, and a second glyph in the corner only repeats them. -->
        </div>
      {:else if stackedVolumes.length > 0}
        <!-- Local volumes exist, but thumbnails are not ready yet -->
        <div
          class="relative pt-4 pb-6"
          style="width: {containerDimensions.outerWidth}px; height: {containerDimensions.outerHeight}px;"
        >
          <div
            class="relative overflow-hidden"
            style="width: {containerDimensions.innerWidth}px; height: {containerDimensions.innerHeight}px;"
          >
            {#each Array(Math.max(stackedVolumes.length, 1)) as _, i}
              <div
                class="absolute flex items-center justify-center bg-gray-200 dark:bg-gray-800"
                class:border={showDropShadow}
                class:border-gray-300={showDropShadow}
                class:dark:border-gray-600={showDropShadow}
                style="width: {BASE_WIDTH}px; height: {BASE_HEIGHT}px; left: {stepSizes.leftOffset +
                  i * stepSizes.horizontal +
                  getCumulativeOffset(i)}px; top: {stepSizes.topOffset +
                  i * stepSizes.vertical}px; z-index: {Math.max(stackedVolumes.length, 1) -
                  i};{showDropShadow
                  ? ' filter: drop-shadow(2px 4px 6px rgba(0, 0, 0, 0.5));'
                  : ''}"
              >
                {#if i === 0}
                  <span class="text-sm text-gray-500 dark:text-gray-400">Generating...</span>
                {/if}
              </div>
            {/each}
          </div>
          <!-- No mark here: this branch is only reached by a series with pages on the
               device, whose covers are still being generated. -->
        </div>
      {/if}
      <!-- Muted while the series is not here — the same grey the cloud series page titles
           itself in. A series you finished keeps its green: that is progress, not identity. -->
      <p
        class="line-clamp-2 font-semibold"
        class:text-gray-400={seriesNeedsDownload && !isComplete}
        style="width: {containerDimensions.outerWidth}px;"
      >
        {displayTitle ?? volume.series_title}
      </p>
      {#if seriesNeedsDownload}
        <!-- Keyed: a count is exactly the text Migaku rewrites and then holds stale. -->
        {#key seriesVolumes.length}
          <p class="text-xs text-blue-400">
            {seriesVolumes.length} volume{seriesVolumes.length !== 1 ? 's' : ''} in {providerName}
          </p>
        {/key}
      {/if}
    </div>
  </a>
{/if}
