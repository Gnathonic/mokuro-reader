<!-- src/lib/components/Series/SeriesSpineShowcase.svelte -->
<script lang="ts">
  /**
   * The whole series as a shelf of spines, with the controls for the offsets that shape it.
   *
   * The catalog card shows at most a handful of volumes and only exposes these offsets
   * through modifier-key gestures on a stack you cannot scroll. Here every volume is laid
   * out in one strip (vertical step forced to 0 — spine mode) so a long series can actually
   * be tuned: the strip scrolls sideways, and the same gestures work over it plus a slider
   * and reset buttons for people who would rather not learn the chords.
   *
   * Offsets are the SAME synced values the card reads (`$lib/metadata/spine-offsets`), so a
   * card and this showcase can be on screen at once. Local state is optimistic and resyncs
   * from the store only once our own write has echoed back — see the `awaitingEcho` note
   * below, which mirrors CatalogItem.svelte.
   *
   * GEOMETRY: every number here comes from `$lib/util/spine-stack-geometry`, the card's own
   * rules, in card pixels — the same uniform height (the AVERAGE of the contain-fitted
   * thumbnail heights, never upscaled), the same per-volume aspect widths and the same step.
   * Zoom is applied last, purely as a render scale. Anything computed independently here
   * would make a gap tuned in the editor land differently on the card.
   *
   * Two deliberate differences, both bounded:
   *
   * 1. This shelf ALWAYS uses spine-mode semantics (`stackCount = 0`: one row, no vertical
   *    step, uniform height). When the catalog is configured that way — stack count "all
   *    volumes", or any stack count with a vertical step of 0 — the card is in uniform mode
   *    too and 1× is literally its on-screen pixel size. When the catalog runs a fixed stack
   *    count WITH a vertical step, the card is not in uniform mode at all (each cover is
   *    contain-fitted on its own, stepped down as well as across), so there is no single
   *    card size for 1× to match; the horizontal step still transfers, which is what the
   *    offsets being tuned here actually control.
   * 2. This is a placement editor, so it draws the whole series; the card may hide read
   *    volumes or cap a cloud stack. Sizes and steps still match — the uniform height is
   *    measured over the CARD's subset — but a per-volume nudge cascades over the volumes
   *    each one is showing, so with `hideReadVolumes` on, a nudged volume shifts a different
   *    set of neighbours here than on the card, and shared volumes can sit at different
   *    absolute positions.
   */
  import { Button, ButtonGroup, Range } from 'flowbite-svelte';
  import type { VolumeMetadata } from '$lib/types';
  import { catalogSettings } from '$lib/settings/settings';
  import { progress } from '$lib/settings/volume-data';
  import { seriesMetadataMap } from '$lib/metadata/store';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import { sortVolumes } from '$lib/catalog/sort-volumes';
  import {
    fetchCloudThumbnail,
    getCachedCloudThumbnail,
    type CloudThumbnailResult
  } from '$lib/catalog/cloud-thumbnails';
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
  import { computeStackLayout, hitTestStack } from '$lib/util/spine-stack-layout';
  import {
    CARD_BASE_HEIGHT,
    CARD_BASE_WIDTH,
    computeStepSizes,
    computeUniformHeight,
    getSpineCanvasDimensions,
    selectCardStackVolumes,
    type Dimensions
  } from '$lib/util/spine-stack-geometry';
  import { SPINE_OFFSET_LIMIT } from '$lib/metadata/sanitize';
  import CompositeCanvas from '../CompositeCanvas.svelte';
  import DownloadBadge from '../DownloadBadge.svelte';
  import { needsDownload } from '$lib/catalog/volume-state';

  let { seriesTitle, volumes }: { seriesTitle: string; volumes: VolumeMetadata[] } = $props();

  /**
   * Memory bound. Every rendered spine holds a decoded bitmap (~360KB at card size) and,
   * for cloud-only series, one thumbnail download each. A 200-volume series would thrash
   * the thumbnail cache for no benefit — the shelf is for judging spacing, and 60 spines
   * is already far more than fits on screen.
   */
  const MAX_SHOWCASE_VOLUMES = 60;

  // Card-space geometry (what the offsets are expressed in) and the zoom this strip
  // draws at. Per-volume nudges are stored in card pixels, so they are scaled here too:
  // the strip is a zoomed view of the card's stack, not a different layout. Zoom 1×
  // means "card scale" — a spine is drawn at exactly the size the card draws it.
  const BASE_WIDTH = CARD_BASE_WIDTH;
  const BASE_HEIGHT = CARD_BASE_HEIGHT;

  const ADJUST_STEP = 0.25; // % of the horizontal step, per wheel tick
  const VOLUME_ADJUST_STEP = 1; // card px, per wheel tick
  const KEY_PAN_PX = 120;
  /**
   * Slider range. Deliberately tighter than the storable `SPINE_OFFSET_LIMIT` (±50 %):
   * anything past ±25 % is already a degenerate stack, and the wheel still reaches the
   * full range for anyone who wants it (both paths clamp to the storable limit).
   */
  const SLIDER_LIMIT = Math.min(25, SPINE_OFFSET_LIMIT);

  // ── Zoom: a device-local, session-only render scale ────────────────────────────────────
  // Two states only — 1× is card scale (what the catalog actually draws) and 2× is the
  // magnifier for judging a few pixels of overlap. Not persisted anywhere (not synced, not
  // in miscSettings): it resets to 1× every time the showcase mounts. Offsets are
  // unaffected — they stay in card px and only the drawing scales, so a +1 px nudge remains
  // +1 px in storage at either zoom.
  const ZOOM_LEVELS = [1, 2] as const;

  let zoom = $state<number>(ZOOM_LEVELS[0]);

  let spineWidth = $derived(BASE_WIDTH * zoom);

  let sortedVolumes = $derived([...volumes].sort(sortVolumes));
  let localVolumes = $derived(sortedVolumes.filter((v) => !v.isPlaceholder));
  let unreadVolumes = $derived(
    localVolumes.filter((v) => ($progress?.[v.volume_uuid] || 1) < v.page_count - 1)
  );

  /**
   * Exactly the volumes the catalog card stacks in spine mode (`stackCount = 0`) — NOT what
   * the shelf draws (that is every volume, below). This subset exists only to measure the
   * card's uniform height from, so a volume the two have in common is drawn at the same
   * size in both places.
   *
   * Derived from props and settings only — never from the fetched thumbnails below, which
   * would turn the fetch effect into a loop.
   */
  let cardVolumes = $derived(
    selectCardStackVolumes({
      localVolumes,
      unreadVolumes,
      placeholders: sortedVolumes,
      hideRead: $catalogSettings?.hideReadVolumes ?? true,
      // The shelf IS spine mode: all of the subset, one row, no vertical step.
      stackCount: 0,
      // The card's compact cloud mode collapses to a single cover; a one-spine shelf could
      // not be spaced at all, so the shelf always measures the (capped) stack.
      compactCloud: false
    })
  );

  /**
   * The shelf is a placement editor: it always shows the whole series, read or not, up to
   * its own memory cap. Only the SIZE of each spine comes from the card's stack.
   */
  let displayedVolumes = $derived(sortedVolumes.slice(0, MAX_SHOWCASE_VOLUMES));

  // Cloud placeholders enriched with their fetched thumbnail, exactly like the catalog
  // card: the volume keeps its slot in the strip whether or not the image has landed, so
  // each thumbnail pops into a fixed position instead of shifting the ones already drawn.
  let cloudThumbnailData = $state<Record<string, CloudThumbnailResult>>({});
  let showcaseVolumes = $derived(
    displayedVolumes.map((vol) => {
      const ct = cloudThumbnailData[vol.volume_uuid];
      return ct
        ? { ...vol, thumbnail: ct.file, thumbnail_width: ct.width, thumbnail_height: ct.height }
        : vol;
    })
  );

  // Fetch targets come from `displayedVolumes` (props/settings only), never from the
  // enriched list: depending on `cloudThumbnailData` here would make each arriving
  // thumbnail re-run the effect that fetches thumbnails.
  $effect(() => {
    let cancelled = false;
    for (const vol of displayedVolumes) {
      // Already have pixels locally, or nothing to fetch: leave it alone.
      if (vol.thumbnail || !vol.cloudThumbnailFileId) continue;
      const cached = getCachedCloudThumbnail(vol.volume_uuid);
      if (cached) {
        cloudThumbnailData[vol.volume_uuid] = cached;
        continue;
      }
      void fetchCloudThumbnail(vol).then((result) => {
        if (cancelled || !result) return;
        cloudThumbnailData[vol.volume_uuid] = result;
      });
    }
    return () => {
      cancelled = true;
    };
  });

  /** The card's dimension rule: stored size, else the base box once there are pixels. */
  function dimensionsOf(vol: VolumeMetadata): Dimensions | undefined {
    const ct = cloudThumbnailData[vol.volume_uuid];
    const width = ct?.width ?? vol.thumbnail_width;
    const height = ct?.height ?? vol.thumbnail_height;
    if (width && height) return { width, height };
    if (ct?.file || vol.thumbnail) return { width: BASE_WIDTH, height: BASE_HEIGHT };
    return undefined;
  }

  let thumbnailDimensions = $derived.by(() => {
    const dims = new Map<string, Dimensions>();
    for (const vol of showcaseVolumes) {
      const d = dimensionsOf(vol);
      if (d) dims.set(vol.volume_uuid, d);
    }
    return dims;
  });

  /**
   * The height every spine is drawn at, in card px: the average contain-fitted height of
   * the CARD's stack. Deliberately measured over `cardVolumes` even when "show all" is on,
   * so widening the shelf cannot change how big the volumes it shares with the card are.
   */
  let uniformHeight = $derived(
    computeUniformHeight({
      dims: cardVolumes.map(dimensionsOf),
      verticalStepPct: $catalogSettings?.verticalStep ?? 5,
      stackCountSetting: 0,
      baseWidth: BASE_WIDTH,
      baseHeight: BASE_HEIGHT
    })
  );

  /** Drawn height of a spine. Small scans stay small — the card never upscales either. */
  let spineHeight = $derived((uniformHeight ?? BASE_HEIGHT) * zoom);

  /** Card geometry × zoom: the same picture, drawn bigger. */
  function getCanvasDimensions(volumeUuid: string): { width: number; height: number } | null {
    const dims = getSpineCanvasDimensions(
      thumbnailDimensions.get(volumeUuid),
      uniformHeight,
      BASE_WIDTH,
      BASE_HEIGHT
    );
    return dims ? { width: dims.width * zoom, height: dims.height * zoom } : null;
  }

  // ── Offsets: optimistic local state over the synced record ────────────────────────────
  let seriesKey = $derived(normalizeSeriesKey(seriesTitle));
  let storedRecord = $derived($seriesMetadataMap.get(seriesKey));
  let storedOffsets = $derived(getSpineOffsets(storedRecord));

  let hOffsetAdjust = $state(0);
  let volumeOffsetsByUuid = $state<Record<string, number>>({});
  let pendingOffsetWrites = $state(0);
  // The record our last write produced, until the store echoes it back. Deliberately not
  // reactive: only the effect below clears it, and it must not re-trigger that effect.
  let awaitingEcho: { offsets: SpineOffsets; updatedAt: string } | null = null;

  $effect(() => {
    const stored = storedOffsets;
    const storedUpdatedAt = storedRecord?.updated_at ?? '';
    if (pendingOffsetWrites > 0) return;
    if (awaitingEcho) {
      // The write resolves when its transaction commits, but the liveQuery emission lands a
      // beat later — until it does, `stored` is still the PRE-write record and applying it
      // would bounce the shelf back for ~300 ms after every gesture. Wait for the emission
      // carrying our own values (or anything strictly newer, so this can never wedge).
      const settled =
        sameSpineOffsets(stored, awaitingEcho.offsets) || storedUpdatedAt > awaitingEcho.updatedAt;
      if (!settled) return;
      awaitingEcho = null;
    }
    if (hOffsetAdjust !== stored.spineOffset) hOffsetAdjust = stored.spineOffset;
    if (!sameVolumeOffsets(volumeOffsetsByUuid, stored.volumeOffsets)) {
      volumeOffsetsByUuid = stored.volumeOffsets;
    }
  });

  function writeSpineOffsets(patch: SpineOffsetPatch) {
    if (!seriesTitle) return;
    // Nothing queued and the gesture landed back on what is already stored (Reset on a
    // series that never had offsets): skip rather than create an empty record for nothing.
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

  function setSeriesOffset(value: number) {
    hOffsetAdjust = clampSpineOffset(value);
    writeSpineOffsets({ spineOffset: hOffsetAdjust });
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

  function resetAllVolumeOffsets() {
    volumeOffsetsByUuid = {};
    // An EMPTY map is the writer's "reset every volume offset for this series".
    writeSpineOffsets({ volumeOffsets: {} });
  }

  // ── Layout ────────────────────────────────────────────────────────────────────────────
  /** The card's own step for this series, in card px, before zoom. */
  let cardStepSizes = $derived(
    computeStepSizes({
      stackCountSetting: 0,
      horizontalStepPct: $catalogSettings?.horizontalStep ?? 11,
      verticalStepPct: $catalogSettings?.verticalStep ?? 5,
      hOffsetAdjust,
      centerHorizontal: $catalogSettings?.centerHorizontal ?? true,
      centerVertical: $catalogSettings?.centerVertical ?? false,
      actualCount: showcaseVolumes.length,
      // Spine mode fills every slot it was sized for, so neither the centring nor the
      // spreading branch can fire; the container only has to be self-consistent.
      innerWidth: BASE_WIDTH,
      innerHeight: uniformHeight ?? BASE_HEIGHT,
      uniformHeight,
      dims: showcaseVolumes.map(dimensionsOf),
      baseWidth: BASE_WIDTH,
      baseHeight: BASE_HEIGHT
    })
  );
  let horizontalStepPx = $derived(cardStepSizes.horizontal * zoom);
  let stepSizes = $derived({
    horizontal: horizontalStepPx,
    vertical: cardStepSizes.vertical * zoom,
    leftOffset: cardStepSizes.leftOffset * zoom,
    topOffset: cardStepSizes.topOffset * zoom
  });
  let scaledVolumeOffsets = $derived(
    new Map(
      [...volumeOffsetsByIndex(showcaseVolumes, volumeOffsetsByUuid)].map(([index, px]) => [
        index,
        px * zoom
      ])
    )
  );
  /**
   * Drawn width per volume, index-aligned with the strip. Each spine owns only the pixels
   * it is actually painted in — hit-testing a 40px spine against a full 250px band would
   * nudge the wrong volume.
   *
   * A volume whose dimensions have not arrived yet has nothing drawn for it, so it falls
   * back to a full spine width: the strip stays wide enough to scroll and to hover while
   * cloud thumbnails load, and each one narrows to its real width as it lands (the strip
   * DOES reflow then — the alternative, a zero-width gap, is worse to aim at).
   */
  let spineWidths = $derived(
    showcaseVolumes.map((vol) => getCanvasDimensions(vol.volume_uuid)?.width ?? spineWidth)
  );
  let layout = $derived(
    computeStackLayout({
      count: showcaseVolumes.length,
      baseWidth: spineWidths[showcaseVolumes.length - 1] ?? spineWidth,
      horizontalStepPx,
      volumeOffsetsByIndex: scaledVolumeOffsets
    })
  );
  /** Right edge of the widest-reaching spine — the strip is exactly as wide as it draws. */
  let canvasWidth = $derived.by(() => {
    const count = showcaseVolumes.length;
    if (count === 0) return spineWidth;
    let right = 0;
    for (let i = 0; i < count; i++) {
      right = Math.max(right, (layout.lefts[i] ?? 0) + spineWidths[i]);
    }
    return right;
  });
  /**
   * CompositeCanvas right-aligns the last spine to `canvasWidth`; mirror that shift here so
   * the hit test agrees with what is actually painted (it is 0 whenever the last spine is
   * the one reaching furthest right, non-zero before its thumbnail has loaded).
   */
  let alignShift = $derived.by(() => {
    const count = showcaseVolumes.length;
    if (count === 0) return 0;
    const lastWidth = getCanvasDimensions(showcaseVolumes[count - 1].volume_uuid)?.width ?? 0;
    return canvasWidth - ((layout.lefts[count - 1] ?? 0) + lastWidth);
  });

  /**
   * Where to mark the spines whose pages are not on this device (metadata-only rows and
   * cloud-only placeholders alike). Read off the SAME numbers the canvas draws with —
   * `layout.lefts`, `alignShift`, `spineWidths`, `stepSizes` — so the marks ride exactly on
   * the painted spines. Nothing here feeds back into the geometry: the badges are absolutely
   * positioned overlays inside the strip, so a marked shelf measures like an unmarked one.
   */
  const SPINE_BADGE_PX = 16; // h-4/w-4, the `sm` badge
  let spineBadges = $derived.by(() => {
    const marks: { uuid: string; left: number; top: number }[] = [];
    for (let i = 0; i < showcaseVolumes.length; i++) {
      const vol = showcaseVolumes[i];
      if (!needsDownload(vol)) continue;
      // CompositeCanvas paints nothing for a volume without pixels, so a mark here would
      // float over blank strip. It appears with the cover, which is when it means something.
      if (!vol.thumbnail) continue;
      const drawn = getCanvasDimensions(vol.volume_uuid);
      const width = drawn?.width ?? spineWidths[i] ?? spineWidth;
      const height = drawn?.height ?? spineHeight;
      marks.push({
        uuid: vol.volume_uuid,
        left: alignShift + (layout.lefts[i] ?? 0) + width - SPINE_BADGE_PX - 2,
        top: stepSizes.topOffset + i * stepSizes.vertical + height - SPINE_BADGE_PX - 2
      });
    }
    return marks;
  });

  // ── Strip: hover, pan, gestures ───────────────────────────────────────────────────────
  let stripEl = $state<HTMLElement | null>(null);
  let hoveredIndex = $state<number | null>(null);
  let dragState: { pointerId: number; startX: number; startScroll: number } | null = null;
  let dragging = $state(false);

  /**
   * Where the cursor last was, in viewport coordinates. Panning moves the shelf UNDER a
   * stationary cursor, so the hit test has to be re-run after a wheel/key pan or the next
   * alt+shift+wheel would nudge whichever spine used to be there.
   */
  let lastPointerX: number | null = null;

  let hoveredVolume = $derived(hoveredIndex === null ? undefined : showcaseVolumes[hoveredIndex]);
  let hoveredOffsetPx = $derived(
    hoveredVolume ? (volumeOffsetsByUuid[hoveredVolume.volume_uuid] ?? 0) : 0
  );

  function formatPercent(value: number): string {
    return `${value > 0 ? '+' : ''}${value}%`;
  }

  function formatPx(value: number): string {
    return `${value > 0 ? '+' : ''}${value} px`;
  }

  function updateHover(clientX: number) {
    const el = stripEl;
    const count = showcaseVolumes.length;
    if (!el || count === 0) {
      hoveredIndex = null;
      return;
    }
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft - alignShift;
    // Past every spine's right edge means the empty tail of the strip: keep the back-most
    // volume targeted, the same fallback the catalog card uses.
    hoveredIndex = hitTestStack(layout, x, spineWidths) ?? count - 1;
  }

  function stripOverflows(): boolean {
    const el = stripEl;
    return !!el && el.scrollWidth > el.clientWidth;
  }

  function handleWheel(e: WheelEvent) {
    // Holding shift makes some browsers (Chrome) report a vertical wheel as deltaX, so the
    // gesture's direction has to come from whichever axis actually carries it.
    const delta = e.deltaY || e.deltaX;

    // Ctrl+wheel (and trackpad pinch, which browsers deliver the same way) is the page's
    // own zoom. The shelf's zoom is a two-state button, so this gesture is not ours: leave
    // it entirely alone rather than swallowing it into the pan below.
    if (e.ctrlKey) return;

    // No delta on either axis is no gesture. Without this, `delta > 0 ? … : …` reads a
    // stationary wheel as "up" and every stray event nudges the offset by a step.
    if (delta === 0) return;

    if (e.shiftKey && e.altKey && hoveredVolume) {
      e.preventDefault();
      const step = delta > 0 ? -VOLUME_ADJUST_STEP : VOLUME_ADJUST_STEP;
      setVolumeOffset(hoveredVolume.volume_uuid, hoveredOffsetPx + step);
      return;
    }
    if (e.shiftKey && !e.altKey) {
      e.preventDefault();
      setSeriesOffset(hOffsetAdjust + (delta > 0 ? -ADJUST_STEP : ADJUST_STEP));
      return;
    }
    // Plain wheel pans the shelf sideways — mouse users have no other way to reach the far
    // end. deltaX is left to the browser here: it already scrolls an overflow-x container
    // natively, and panning it ourselves too would double the movement.
    const el = stripEl;
    if (e.deltaY === 0 || !el || !stripOverflows()) return;
    const before = el.scrollLeft;
    el.scrollLeft += e.deltaY;
    // Clamped at this end already: the wheel did nothing here, so it must fall through to
    // the modal body — otherwise the shelf traps the page scroll for the rest of the page.
    if (el.scrollLeft === before) return;
    e.preventDefault();
    rehoverAfterPan();
  }

  function handleContextMenu(e: MouseEvent) {
    if (e.shiftKey && e.altKey && hoveredVolume) {
      e.preventDefault();
      setVolumeOffset(hoveredVolume.volume_uuid, 0);
    } else if (e.shiftKey && !e.altKey) {
      e.preventDefault();
      setSeriesOffset(0);
    }
  }

  function handlePointerDown(e: PointerEvent) {
    // Touch keeps its native `pan-x pan-y` scrolling (horizontal for the strip, vertical
    // falls through to the dialog); dragging is for mouse/pen.
    if (e.button !== 0 || e.pointerType === 'touch' || !stripEl) return;
    dragState = { pointerId: e.pointerId, startX: e.clientX, startScroll: stripEl.scrollLeft };
    dragging = true;
    try {
      stripEl.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is a nicety (drag continues outside the strip); not worth failing over.
    }
  }

  function handlePointerMove(e: PointerEvent) {
    lastPointerX = e.clientX;
    if (dragState && stripEl) {
      stripEl.scrollLeft = dragState.startScroll - (e.clientX - dragState.startX);
      return;
    }
    updateHover(e.clientX);
  }

  /** The shelf moved under a stationary cursor: whatever is there now is the hovered spine. */
  function rehoverAfterPan() {
    if (lastPointerX !== null) updateHover(lastPointerX);
  }

  function endDrag() {
    if (!dragState) return;
    try {
      stripEl?.releasePointerCapture?.(dragState.pointerId);
    } catch {
      // Already released (pointercancel, unmount): nothing to undo.
    }
    dragState = null;
    dragging = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!stripEl) return;
    // Only the arrows are ours. Escape in particular must reach the modal's guard.
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stripEl.scrollLeft -= KEY_PAN_PX;
      rehoverAfterPan();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      stripEl.scrollLeft += KEY_PAN_PX;
      rehoverAfterPan();
    }
  }

  // Non-passive so shift+wheel (and the pan) can preventDefault; Svelte's `onwheel` would
  // be registered passively for a scrollable element in some browsers.
  $effect(() => {
    const el = stripEl;
    if (!el) return;
    el.addEventListener('wheel', handleWheel as EventListener, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel as EventListener);
  });
</script>

<div class="flex flex-col gap-2">
  <!-- relative z-10: the night-mode filter on <dialog> creates a stacking context, and the
       scrollable strip below would otherwise swallow clicks meant for these controls. -->
  <div class="relative z-10 flex flex-wrap items-center gap-3">
    <span class="text-xs text-gray-500 dark:text-gray-400">Spine spacing</span>
    <Range
      aria-label="Series spine offset"
      min={-SLIDER_LIMIT}
      max={SLIDER_LIMIT}
      step={ADJUST_STEP}
      value={hOffsetAdjust}
      class="max-w-56 min-w-32 flex-1"
      oninput={(e) => setSeriesOffset(parseFloat(e.currentTarget.value))}
    />
    <span class="w-16 text-right font-mono text-xs text-gray-600 dark:text-gray-300">
      {formatPercent(hOffsetAdjust)}
    </span>
    <Button size="xs" color="alternative" onclick={() => setSeriesOffset(0)}>Reset</Button>
    <Button size="xs" color="alternative" onclick={resetAllVolumeOffsets}>
      Reset all volume offsets
    </Button>

    <span class="mx-1 h-4 w-px bg-gray-300 dark:bg-gray-700" aria-hidden="true"></span>

    <span class="text-xs text-gray-500 dark:text-gray-400">Zoom</span>
    <!-- Two states, not a slider: 1× is what the catalog actually draws, 2× is the
         magnifier for judging a few pixels of overlap. -->
    <ButtonGroup size="sm">
      {#each ZOOM_LEVELS as level (level)}
        <Button
          size="xs"
          color={zoom === level ? 'primary' : 'alternative'}
          aria-pressed={zoom === level}
          onclick={() => (zoom = level)}
        >
          {level}×
        </Button>
      {/each}
    </ButtonGroup>
  </div>

  <p class="text-xs text-gray-500 dark:text-gray-400">
    Shift+scroll: series offset · Alt+Shift+scroll over a volume: nudge that volume ·
    Alt+Shift+right-click: reset it
  </p>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={stripEl}
    class="spine-strip overflow-x-auto overflow-y-hidden rounded-lg bg-gray-100 dark:bg-gray-900"
    class:cursor-grabbing={dragging}
    class:cursor-grab={!dragging}
    style="height: {spineHeight + 18}px; touch-action: pan-x pan-y;"
    role="group"
    aria-label="Spine shelf"
    tabindex="0"
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={endDrag}
    onpointercancel={endDrag}
    onpointerleave={() => {
      endDrag();
      hoveredIndex = null;
      lastPointerX = null;
    }}
    oncontextmenu={handleContextMenu}
    onkeydown={handleKeydown}
  >
    <div class="relative" style="width: {canvasWidth}px; height: {spineHeight}px;">
      <CompositeCanvas
        volumes={showcaseVolumes}
        {canvasWidth}
        canvasHeight={spineHeight}
        {getCanvasDimensions}
        {stepSizes}
        volumeOffsets={scaledVolumeOffsets}
        highlightIndex={hoveredIndex}
        dropShadow={false}
        border={true}
      />
      {#each spineBadges as mark (mark.uuid)}
        <DownloadBadge size="sm" class="" style="left: {mark.left}px; top: {mark.top}px;" />
      {/each}
    </div>
  </div>

  <!-- Fixed single line so hovering a spine — or a long volume title — never reflows the
       modal or wraps out of the section. -->
  <p
    class="h-4 truncate overflow-hidden text-xs whitespace-nowrap text-gray-500 dark:text-gray-400"
  >
    {#if hoveredVolume}
      {hoveredVolume.volume_title || `Vol ${(hoveredIndex ?? 0) + 1}`} · {formatPx(hoveredOffsetPx)}
    {:else}
      &nbsp;
    {/if}
  </p>

  {#if showcaseVolumes.length < volumes.length}
    <!-- Only the shelf's own memory cap can trim the series (see MAX_SHOWCASE_VOLUMES). -->
    <p class="text-xs text-gray-500 dark:text-gray-400">
      Showing first {showcaseVolumes.length} of {volumes.length} volumes
    </p>
  {/if}
</div>

<style>
  /* Keep the horizontal scrollbar permanently visible: on overlay-scrollbar platforms an
     `overflow-x: auto` strip gives no hint that there is more shelf off-screen. */
  .spine-strip {
    scrollbar-width: thin;
    scrollbar-color: rgb(107 114 128) transparent;
  }
  .spine-strip::-webkit-scrollbar {
    height: 10px;
    -webkit-appearance: none;
  }
  .spine-strip::-webkit-scrollbar-track {
    background: transparent;
  }
  .spine-strip::-webkit-scrollbar-thumb {
    border-radius: 9999px;
    background: rgb(107 114 128);
  }
</style>
