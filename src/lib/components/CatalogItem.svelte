<script module lang="ts">
  // Cooldown so a wheel/right-click burst against a blocked series doesn't spam the
  // snackbar with a toast per tick — shared across every mounted card, not scoped to one
  // instance, so gesturing across several cards in quick succession still only shows one.
  const METADATA_GATE_SNACKBAR_COOLDOWN_MS = 4000;
  let lastMetadataGateSnackbarAt = 0;

  /**
   * Shared "nothing resolved" identity. A fresh empty Map per assignment would
   * invalidate `thumbnailDimensions` (and so the whole canvas) on every card that has no
   * cloud covers to resolve, every time its claim set is recomputed.
   */
  const NO_COVER_FILES: Map<string, File> = new Map();
</script>

<script lang="ts">
  import type { VolumeMetadata } from '$lib/types';
  // `volumes` is the READING RECORD store (page + `completed` per uuid), aliased because
  // this component's own `volumes` prop is the series' catalog rows.
  import { volumes as readStates, catalogSettings } from '$lib/settings';
  import { downloadQueue } from '$lib/util/download-queue';
  import { nav } from '$lib/util/hash-router';
  import { promptSeriesEditor } from '$lib/util/modals';
  import { shouldOpenSeriesEditor } from '$lib/util/series-editor-shortcut';
  import { anyModalOpen, shouldTriggerDelete } from '$lib/util/delete-shortcut';
  import { promptSeriesRemoval } from '$lib/catalog/series-delete';
  import { seriesMetadataMap } from '$lib/metadata/store';
  import { seriesIndexMap } from '$lib/metadata/series-index';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import { canEditSeriesMetadata } from '$lib/util/sync/metadata-permissions';
  import { showSnackbar } from '$lib/util';
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
  import { isSeriesFinished, isVolumeFinished } from '$lib/util/volume-helpers';
  import { createCoverClaims } from '$lib/catalog/cover-claims.svelte';
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

  /** Not read through, by the app's one volume-completion rule. */
  function isUnread(vol: VolumeMetadata): boolean {
    return !isVolumeFinished(vol, $readStates?.[vol.volume_uuid]);
  }

  // Unread among the volumes that are HERE — only for picking which cover faces out.
  let unreadLocalVolumes = $derived(localVolumes.filter(isUnread));

  // Display volume: first unread, or first local, or first placeholder
  let volume = $derived(unreadLocalVolumes[0] ?? localVolumes[0] ?? seriesVolumes[0]);

  // UI state flag — the app's ONE series-completion rule, over the WHOLE series.
  //
  // This used to be `unreadLocalVolumes.length === 0 && hasLocalVolumes`, on the theory
  // that read history is something only a series with rows can have. It is not: history is
  // keyed by uuid in localStorage and needs no row, so requiring one made "finished" false
  // by construction for a cloud-only series — which then sorted to the bottom of the smart
  // catalog (that predicate counted every volume) while staying uncoloured here, and went
  // green only once opening it materialised rows.
  let isComplete = $derived(isSeriesFinished(seriesVolumes, $readStates));

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

  // Delivery of a fetched cover is now the DB write itself (`cover-service.ts`): once a
  // cover lands, `db.volumes.update(...)` fires the `volumes` liveQuery → `volumesWith-
  // Placeholders` → the catalog re-derives → this card's OWN `volumes` prop arrives with
  // `thumbnail`/`thumbnail_width`/`thumbnail_height` already on it, from the parent. There
  // is no per-card enrichment step any more — `localVolumes`/`cloudStackVolumes` (the raw
  // props, already filtered above) are exactly what the stack draws.
  //
  // Unread across the WHOLE series — what "hide read" hides. Spans both absent states: a
  // finished cloud volume hides like any other. Filtered off `seriesVolumes` rather than
  // off `localVolumes + cloudStackVolumes`, which double-counts every metadata-only row of
  // a series that is entirely absent (`cloudStackVolumes` is then the whole series).
  let unreadVolumes = $derived(seriesVolumes.filter(isUnread));

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
  //
  // `unreadVolumes` is handed over WHICHEVER path is taken. Zeroing it alongside
  // `localVolumes` is what made "hide completed volumes" a local-only setting: the cloud
  // path had no unread set to work from, so a cloud series stacked its finished volumes
  // like any other. The set is computed either way; it was only ever thrown away.
  let stackedVolumes = $derived(
    selectCardStackVolumes({
      localVolumes: seriesNeedsDownload ? [] : localVolumes,
      unreadVolumes,
      placeholders: cloudStackVolumes,
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
  //
  // The record holds only THIS user's edits; an alignment another device published
  // reaches the card by joining the cached `series.json` here at read time, so it stays
  // theirs to correct or retract.
  let seriesKey = $derived(normalizeSeriesKey(volume?.series_title ?? ''));
  let storedRecord = $derived($seriesMetadataMap.get(seriesKey));
  let publishedIndex = $derived($seriesIndexMap.get(seriesKey)?.file);
  let storedOffsets = $derived(getSpineOffsets(storedRecord, publishedIndex));

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
    // (a tag edit, a tracking push, a sync) and `seriesIndexMap` on any cloud listing
    // refresh — both rebuild their whole Map, so `stored` is a fresh object every time.
    // A fresh-but-equal assignment here would invalidate containerDimensions → stepSizes
    // → the canvas draw on every mounted card.
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
          // Joined the same way `storedOffsets` is, so the echo comparison is
          // like for like — a write that stores nothing still displays the
          // published value.
          awaitingEcho = {
            offsets: getSpineOffsets(written, publishedIndex),
            updatedAt: written.updated_at
          };
        }
      })
      .finally(() => {
        pendingOffsetWrites--;
      });
  }

  /**
   * Gate for the wheel/right-click spine-offset gestures below. Unlike SeriesSpineShowcase
   * (inside the series editor modal, which has a persistent label to disable + explain), a
   * catalog card has no such surface — a shift+wheel gesture is not discoverable UI to begin
   * with, so "disable + label" here means: block the write, change NOTHING locally (an
   * offset applied only on this device, that can never publish, would silently diverge from
   * the server), and surface the reason once via a snackbar rather than every wheel tick.
   * See $lib/util/sync/metadata-permissions.ts.
   */
  function checkSpineOffsetEditAllowed(): boolean {
    const seriesTitle = volume?.series_title;
    // No resolvable series title: `writeSpineOffsets` itself is a no-op in that case, so
    // there's nothing to gate — let the existing dead-end behavior stand.
    if (!seriesTitle) return true;
    const gate = canEditSeriesMetadata(seriesTitle);
    if (gate.allowed) return true;
    const now = Date.now();
    if (now - lastMetadataGateSnackbarAt > METADATA_GATE_SNACKBAR_COOLDOWN_MS) {
      lastMetadataGateSnackbarAt = now;
      showSnackbar(gate.reason ?? "This account can't edit series details on this server");
    }
    return false;
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
      setSeriesOffset(hOffsetAdjust + delta);
    }
  }

  function setSeriesOffset(value: number) {
    if (!checkSpineOffsetEditAllowed()) return;
    // Clamped with the same rule the writer applies, so the stack never shows a value
    // that storage would refuse.
    hOffsetAdjust = clampSpineOffset(value);
    writeSpineOffsets({ spineOffset: hOffsetAdjust });
  }

  function setVolumeOffset(volumeUuid: string, value: number) {
    if (!checkSpineOffsetEditAllowed()) return;
    const px = clampVolumeOffset(value);
    const next = { ...volumeOffsetsByUuid };
    if (px === 0) delete next[volumeUuid];
    else next[volumeUuid] = px;
    volumeOffsetsByUuid = next;
    // 0 is stored, not deleted: it is what outranks an alignment published by
    // another device (see spine-offsets.ts).
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
      setSeriesOffset(0);
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
    // pointer is over. The hit test runs in stack-local coordinates, so the pointer has to
    // be shifted by whatever moved the stack — and the two branches move it differently:
    // CompositeCanvas pins the stack's RIGHT edge to the container (`alignShift`, mirrored
    // from the shelf and from `spineBadgePlacements`), while the placeholder boxes are
    // drawn at the centering inset. Using `leftOffset` for both put the pointer up to a
    // spine's width away from what was painted, so a nudge landed on the neighbour.
    // Past every spine's right edge falls back to the back-most volume (nothing is drawn
    // there, but the nudge gesture still needs a target).
    const layout = computeStackLayout({
      count,
      baseWidth: BASE_WIDTH,
      horizontalStepPx: sizes.horizontal,
      volumeOffsetsByIndex: volumeOffsets
    });
    let shift = sizes.leftOffset;
    if (hasRenderableThumbnails) {
      // `?? 0` exactly like the canvas: a last spine with no pixels contributes no width.
      const lastWidth = getCanvasDimensions(stackedVolumes[count - 1].volume_uuid)?.width ?? 0;
      shift = containerDimensions.innerWidth - ((layout.lefts[count - 1] ?? 0) + lastWidth);
    }
    hoveredVolumeIndex = hitTestStack(layout, mouseX - shift, BASE_WIDTH) ?? count - 1;
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
      // A volume with no pixels is not painted, so it has no corner to mark — from its
      // own row or from the resolver, the same rule CompositeCanvas draws by.
      isMarked: (vol) => needsDownload(vol) && hasCoverPixels(vol),
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

  /**
   * THIS CARD RESOLVES ITS OWN CLOUD COVERS.
   *
   * Covers used to reach a card by riding the catalog derivation: one cover landing
   * re-materialised every `cloud_covers` row, re-walked the whole listing, minted fresh
   * placeholder objects and re-rendered every mounted card — measured at a 1,784 ms long
   * task on a 1,027-series library, ~15x the next contributor. A card that can fetch its
   * own cover by path is what lets that dependency be cut (see the design doc).
   *
   * Only for volumes with NO cover of their own. A row that carries `thumbnail` — an
   * installed volume, or a metadata-only row whose cover was persisted — draws from it
   * exactly as before; the resolver is the CLOUD path and nothing else.
   */
  const coverClaims = createCoverClaims({
    // Claimed and asked-for are the SAME set here: everything `stackedVolumes` draws, and
    // only once this card is near the viewport. They used to be sliced independently,
    // which is what left a 42-volume series with one local volume showing spines 1-25 and
    // 42: the rest were in the stack with no cover ever requested, and CompositeCanvas
    // paints nothing for a volume without pixels.
    claims: () => stackedVolumes,
    targets: () => stackedVolumes
  });
  const { gate } = coverClaims;

  let resolvedCovers = $derived(coverClaims.covers);

  /** The cover bytes CompositeCanvas should draw, keyed the way `thumbnailCache` decodes. */
  let coverFiles = $derived.by(() => {
    if (resolvedCovers.size === 0) return NO_COVER_FILES;
    const files = new Map<string, File>();
    for (const [uuid, cover] of resolvedCovers) files.set(uuid, cover.file);
    return files;
  });

  /** Does this volume have pixels to paint at all — from its row, or from the resolver? */
  function hasCoverPixels(vol: VolumeMetadata): boolean {
    return !!vol.thumbnail || resolvedCovers.has(vol.volume_uuid);
  }

  // Base thumbnail dimensions (shared with the series editor's spine shelf)
  const BASE_WIDTH = CARD_BASE_WIDTH;
  const BASE_HEIGHT = CARD_BASE_HEIGHT;
  const OUTER_PADDING = 25; // pt-4 pb-6 ≈ 25px

  // Get dimensions from volume metadata, with fallback to defaults.
  //
  // PIXELS FIRST: a volume earns an entry here only once it has a thumbnail to draw.
  // Stored dimensions alone are not enough — CompositeCanvas skips a volume without a
  // thumbnail (it has nothing to paint), so a stack whose only "dimensions" came from
  // rows with no cover would render the canvas branch as a correctly-sized, permanently
  // empty box instead of the honest placeholder below it.
  let thumbnailDimensions = $derived.by(() => {
    const dims = new Map<string, { width: number; height: number }>();
    for (const vol of stackedVolumes) {
      if (vol.thumbnail) {
        if (vol.thumbnail_width && vol.thumbnail_height) {
          dims.set(vol.volume_uuid, {
            width: vol.thumbnail_width,
            height: vol.thumbnail_height
          });
        } else {
          // Fallback to default aspect ratio for volumes without stored dimensions
          dims.set(vol.volume_uuid, {
            width: BASE_WIDTH,
            height: BASE_HEIGHT
          });
        }
        continue;
      }
      // No cover on the row: the cloud cover this card resolved for itself, whose
      // dimensions travel with the blob in `cloud_covers` rather than on a row.
      const resolved = resolvedCovers.get(vol.volume_uuid);
      if (!resolved) continue;
      dims.set(vol.volume_uuid, {
        width: resolved.width || BASE_WIDTH,
        height: resolved.height || BASE_HEIGHT
      });
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

<!-- Nothing of this series is here. The mark is the cloud card's own, unchanged since
     before the not-on-device work: a download glyph in the corner of the cover stack, the
     design language people already read as "this one is in the cloud". Both absent kinds
     get it — a series whose files were removed IS a cloud series (see `seriesNeedsDownload`).
     Named for screen readers, since on a card it is the only cue. -->
{#snippet absentMark()}
  {#if seriesNeedsDownload}
    <div
      data-testid="cloud-card-mark"
      class="pointer-events-none absolute right-2 bottom-8 z-10 rounded-full bg-black/60 p-1.5"
    >
      {#if isDownloading}
        <Spinner size="4" color="blue" />
      {:else}
        <DownloadSolid class="h-4 w-4 text-blue-400" />
      {/if}
      <span class="sr-only">Not on this device</span>
    </div>
  {/if}
{/snippet}

{#if volume}
  <a href="#/series/{encodeURIComponent(navId)}" onclick={handleClick}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={outerEl}
      use:gate
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
                covers={coverFiles}
                {volumeOffsets}
                highlightIndex={showVolumeIndicator ? hoveredVolumeIndex : null}
              />
            {/key}
            {#each stackBadges as mark (stackedVolumes[mark.index].volume_uuid)}
              <!-- Named: on a card that is otherwise a normal library card, this badge is
                   the only thing that says the volume under it is not here. -->
              <DownloadBadge
                size="spine"
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
