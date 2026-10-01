<script lang="ts">
  import { AccordionItem, Label, Range, Toggle, Select, Helper, Button } from 'flowbite-svelte';
  import ReaderSelects from './ReaderSelects.svelte';
  import ReaderToggles from './ReaderToggles.svelte';
  import {
    settings,
    updateSetting,
    effectiveVolumeSettings,
    updateProgress,
    updateVolumeSetting,
    volumes,
    type ScrollMode,
    type PageViewMode,
    type VolumeSettingsKey
  } from '$lib/settings';
  import { isReader } from '$lib/util';
  import { routeParams } from '$lib/util/hash-router';
  import { MAX_PAGE_GAP } from '$lib/reader/zoom-math';
  import { layerSummaries, primaryLayerName, type LayerSummary } from '$lib/reader/edit/layer-list';
  import { LAYER_KIND_LABEL, loadLayerPages } from '$lib/reader/edit/layers';
  import { ORIGINAL_LAYER_ID } from '$lib/reader/edit/edit-persist';
  import { TRANSLATION_PROMOTE_BLOCKED, isTranslationLayer } from '$lib/reader/edit/layer-kind';
  import { runLayerAction, type LayerAction } from '$lib/components/Reader/Layers/layer-actions';
  import { beforeLayerMutation } from '$lib/reader/edit/reader-edit-rules';
  import { db } from '$lib/catalog/db';
  import type { Page } from '$lib/types';

  // Derived visibility flags
  let isContinuous = $derived($settings.continuousScroll);
  let isVertical = $derived(isContinuous && $settings.scrollMode === 'vertical');
  let isHorizontal = $derived(isContinuous && $settings.scrollMode === 'horizontal');
  let isAutoScroll = $derived(isContinuous && $settings.scrollMode === 'auto');
  let isPaged = $derived(!isContinuous);
  let isDualOrAuto = $derived($settings.singlePageView !== 'single');
  let showRtl = $derived(isPaged || isHorizontal || isAutoScroll);
  let showCover = $derived(isPaged && isDualOrAuto);
  let showOffset = $derived(isPaged && isDualOrAuto);
  let showPagedOnly = $derived(isPaged);

  // Volume-specific settings (only available in reader view)
  let inReader = $derived(isReader());
  let volumeId = $derived($routeParams.volume);
  let volSettings = $derived(volumeId ? $effectiveVolumeSettings[volumeId] : undefined);

  const scrollModes: { value: ScrollMode; name: string }[] = [
    { value: 'auto', name: 'Match orientation' },
    { value: 'vertical', name: 'Vertical scroll' },
    { value: 'horizontal', name: 'Horizontal scroll' }
  ];

  const pageViewModes: { value: PageViewMode; name: string }[] = [
    { value: 'single', name: 'Single page' },
    { value: 'dual', name: 'Dual page' },
    { value: 'auto', name: 'Auto (detect orientation & spreads)' }
  ];

  let swipeThresholdValue = $state($settings.swipeThreshold);
  let edgeButtonWidthValue = $state($settings.edgeButtonWidth);

  function onSwipeChange() {
    updateSetting('swipeThreshold', swipeThresholdValue);
  }

  function onWidthChange() {
    updateSetting('edgeButtonWidth', edgeButtonWidthValue);
  }

  function onPageViewModeChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    updateSetting('singlePageView', target.value as PageViewMode);
  }

  // ---- OCR layers (the reader renders whichever the volume setting names) ----
  let layersStore = $derived(inReader && volumeId ? layerSummaries(volumeId) : null);
  let layers = $state<LayerSummary[]>([]);
  $effect(() => {
    const s = layersStore;
    if (!s) {
      layers = [];
      return;
    }
    return s.subscribe((v) => (layers = v));
  });
  let currentLayer = $derived((volumeId && $volumes[volumeId]?.settings?.ocrLayer) || '');
  let currentLayerSummary = $derived(layers.find((l) => l.layer_id === currentLayer));
  let currentLayerName = $derived(currentLayerSummary?.name);
  // A translation can never become the primary (it would zero the volume's
  // character stats); weighed by id too, since a kind does not travel.
  let promoteBlocked = $derived(
    !!currentLayer &&
      isTranslationLayer({ layer_id: currentLayer, kind: currentLayerSummary?.kind })
  );
  // The primary row is named after the mokuro version on the volume's DB row.
  let primaryName = $state('mokuro');
  $effect(() => {
    const id = inReader ? volumeId : '';
    if (!id) return;
    let cancelled = false;
    db.volumes
      .get(id)
      .then((row) => {
        if (!cancelled) primaryName = primaryLayerName(row?.mokuro_version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });

  function onLayerChange(e: Event) {
    if (!volumeId) return;
    const value = (e.target as HTMLSelectElement).value;
    // The reader announces the switch itself (it watches the setting).
    updateVolumeSetting(volumeId, 'ocrLayer', value || undefined);
  }

  async function layerAction(action: LayerAction) {
    if (!volumeId) return;
    // `disabled` alone is the browser's promise, not ours.
    if (action === 'promote' && promoteBlocked) return;
    const uuid = volumeId;
    const layerId = currentLayer || null;
    let displayedPages: Page[] = [];
    if (action === 'new') {
      // This panel has no live pages, so the copy source comes from the DB —
      // which lags the editor by its debounced autosave. Settle the reader's
      // session first, or the new layer is copied without the last edits.
      await beforeLayerMutation('new');
      displayedPages =
        (layerId ? await loadLayerPages(uuid, layerId) : (await db.volume_ocr.get(uuid))?.pages) ??
        [];
    }
    await runLayerAction(action, {
      volumeUuid: uuid,
      layerId,
      layerName: currentLayerName,
      layerKind: currentLayerSummary?.kind,
      displayedPages,
      onSelectLayer: (id) => updateVolumeSetting(uuid, 'ocrLayer', id ?? undefined),
      // Same settle the reader's own layer menu passes: without it a promote or
      // delete from here races the editor's pending autosave.
      onBeforeMutate: () => beforeLayerMutation(action)
    });
  }

  function onVolumeToggle(key: VolumeSettingsKey, value: any) {
    if (!volumeId) return;
    if (key === 'hasCover') {
      updateVolumeSetting(volumeId, key, !value);
      const pageClamped = Math.max($volumes[volumeId].progress - 1, 1);
      updateProgress(volumeId, pageClamped);
    } else {
      updateVolumeSetting(volumeId, key, !value);
    }
  }
</script>

<AccordionItem open={inReader}>
  {#snippet header()}Reader{/snippet}
  <div class="flex flex-col gap-5">
    <!-- 1. Continuous scroll toggle - always visible -->
    <Toggle
      size="small"
      checked={isContinuous}
      onchange={() => updateSetting('continuousScroll', !isContinuous)}
    >
      Continuous scroll
      <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(V)</span>
    </Toggle>

    <!-- 2. If paged: Page view mode dropdown -->
    {#if isPaged}
      <div>
        <Label for="page-view-mode" class="mb-2 text-gray-900 dark:text-white">
          Page view mode
          <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(P)</span>
        </Label>
        <Select
          id="page-view-mode"
          size="sm"
          items={pageViewModes}
          value={$settings.singlePageView}
          onchange={onPageViewModeChange}
        />
      </div>
      {#if isDualOrAuto}
        <div>
          <Label class="text-gray-900 dark:text-white">
            Page gap: {$settings.pagedGap}px
            <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(Ctrl+Shift+Scroll)</span>
          </Label>
          <Range
            min={0}
            max={MAX_PAGE_GAP}
            value={$settings.pagedGap}
            onchange={(e) =>
              updateSetting('pagedGap', Number((e.target as HTMLInputElement).value))}
          />
        </div>
      {/if}
    {/if}

    <!-- 3. If continuous: Scroll mode dropdown + gap slider -->
    {#if isContinuous}
      <div>
        <Label class="text-gray-900 dark:text-white">Scroll mode:</Label>
        <Select
          size="sm"
          items={scrollModes}
          value={$settings.scrollMode}
          onchange={(e) => updateSetting('scrollMode', (e.target as HTMLSelectElement).value)}
        />
      </div>
      <Toggle
        size="small"
        checked={$settings.pageDividers}
        onchange={() => updateSetting('pageDividers', !$settings.pageDividers)}
      >
        Page dividers
        <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(M)</span>
      </Toggle>
      {#if $settings.pageDividers}
        <div>
          <Label class="text-gray-900 dark:text-white">
            Divider size: {$settings.scrollGap}px
            <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(Ctrl+Shift+Scroll)</span>
          </Label>
          <Range
            min={0}
            max={MAX_PAGE_GAP}
            value={$settings.scrollGap}
            onchange={(e) =>
              updateSetting('scrollGap', Number((e.target as HTMLInputElement).value))}
          />
        </div>
      {/if}
    {/if}

    <!-- 4. Zoom dropdown (handles continuous vs paged internally) -->
    <!-- 5. If paged: Page transition dropdown -->
    <ReaderSelects />

    <hr class="border-gray-100 opacity-10" />

    <!-- 6. Volume settings section -->
    {#if inReader && volSettings && volumeId}
      <Helper>Per-volume settings</Helper>

      <!-- 7. Right to left toggle -->
      {#if showRtl}
        <Toggle
          size="small"
          checked={volSettings.rightToLeft}
          onchange={() => onVolumeToggle('rightToLeft', volSettings?.rightToLeft)}
        >
          Right to left
        </Toggle>
      {/if}

      <!-- 8. First page is cover -->
      {#if showCover}
        <Toggle
          size="small"
          checked={volSettings.hasCover}
          onchange={() => onVolumeToggle('hasCover', volSettings?.hasCover)}
        >
          First page is cover
          <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(C)</span>
        </Toggle>
      {/if}

      <!-- 8b. OCR layers -->
      <div class="flex flex-col gap-2">
        <Label>
          OCR layer
          <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(L cycles)</span>
          <!-- Native select: its value must follow the volume setting exactly,
               and flowbite's Select re-selects its own placeholder on mount. -->
          <select
            aria-label="OCR layer"
            class="mt-1 block w-full rounded-lg border border-gray-300 bg-gray-50 p-2 text-sm text-gray-900 focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            value={currentLayer}
            onchange={onLayerChange}
          >
            <option value="" selected={currentLayer === ''}>{primaryName}</option>
            {#each layers as layer (layer.layer_id)}
              <option value={layer.layer_id} selected={currentLayer === layer.layer_id}
                >{layer.name} ({LAYER_KIND_LABEL[layer.kind]})</option
              >
            {/each}
          </select>
        </Label>
        <div class="flex flex-wrap gap-1">
          <Button
            size="xs"
            color="alternative"
            aria-label="New layer"
            onclick={() => layerAction('new')}>New layer…</Button
          >
          {#if currentLayer}
            {#if currentLayer !== ORIGINAL_LAYER_ID}
              <Button
                size="xs"
                color="alternative"
                aria-label="Rename layer"
                onclick={() => layerAction('rename')}>Rename</Button
              >
              <Button
                size="xs"
                color="alternative"
                aria-label="Promote layer"
                disabled={promoteBlocked}
                title={promoteBlocked ? TRANSLATION_PROMOTE_BLOCKED : undefined}
                onclick={() => layerAction('promote')}>Promote to primary</Button
              >
            {/if}
            <Button
              size="xs"
              color="alternative"
              aria-label="Export layer"
              onclick={() => layerAction('export')}>Export</Button
            >
            {#if currentLayer !== ORIGINAL_LAYER_ID}
              <Button
                size="xs"
                color="red"
                outline
                aria-label="Delete layer"
                onclick={() => layerAction('delete')}>Delete</Button
              >
            {/if}
          {/if}
        </div>
      </div>

      <!-- 9. Offset spreads button -->
      {#if showOffset}
        <Button
          size="xs"
          color="alternative"
          onclick={() => window.dispatchEvent(new CustomEvent('offset-spreads'))}
        >
          Offset spreads
          <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(O)</span>
        </Button>
      {/if}

      <hr class="border-gray-100 opacity-10" />
    {/if}

    <!-- 10. Display toggles (already handles hiding bounds/mobile in continuous) -->
    <ReaderToggles />

    <!-- 13. If paged: Swipe threshold, Edge button width -->
    {#if showPagedOnly}
      <div>
        <Label>
          Swipe threshold
          <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(Mobile only)</span>
        </Label>
        <Range
          onchange={onSwipeChange}
          min={20}
          max={90}
          disabled={!$settings.mobile}
          bind:value={swipeThresholdValue}
        />
      </div>
      <div>
        <Label>Edge button width</Label>
        <Range onchange={onWidthChange} min={1} max={100} bind:value={edgeButtonWidthValue} />
      </div>
    {/if}
  </div>
</AccordionItem>
