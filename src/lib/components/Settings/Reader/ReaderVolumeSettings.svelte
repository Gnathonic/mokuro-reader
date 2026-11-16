<script lang="ts">
  import { AccordionItem, Label, Toggle, Helper, Button } from 'flowbite-svelte';
  import {
    settings,
    effectiveVolumeSettings,
    updateProgress,
    updateVolumeSetting,
    volumes,
    type VolumeSettingsKey
  } from '#lib/settings/index.js';
  import { isReader } from '#lib/util/index.js';
  import { routeParams } from '#lib/util/hash-router.js';
  import {
    layerSummaries,
    primaryLayerName,
    type LayerSummary
  } from '#lib/reader/edit/layer-list.js';
  import { LAYER_KIND_LABEL, loadLayerPages } from '#lib/reader/edit/layers.js';
  import { ORIGINAL_LAYER_ID } from '#lib/reader/edit/edit-persist.js';
  import { TRANSLATION_PROMOTE_BLOCKED, isTranslationLayer } from '#lib/reader/edit/layer-kind.js';
  import { runLayerAction, type LayerAction } from '#lib/components/Reader/Layers/layer-actions.js';
  import { isCuratedLayerId } from '#lib/reader/edit/layer-names.js';
  import { beforeLayerMutation } from '#lib/reader/edit/reader-edit-rules.js';
  import { db } from '#lib/catalog/db.js';
  import type { Page } from '#lib/types/index.js';

  /**
   * "This volume": the open volume's own settings (reading direction, cover,
   * spread offset) and its OCR layer. Reader only — outside it the drawer
   * shows "Volume defaults" in this place.
   */
  let isContinuous = $derived($settings.continuousScroll);
  let isHorizontal = $derived(isContinuous && $settings.scrollMode === 'horizontal');
  let isAutoScroll = $derived(isContinuous && $settings.scrollMode === 'auto');
  let isPaged = $derived(!isContinuous);
  let isDualOrAuto = $derived($settings.singlePageView !== 'single');
  let showRtl = $derived(isPaged || isHorizontal || isAutoScroll);
  let showCover = $derived(isPaged && isDualOrAuto);
  let showOffset = $derived(isPaged && isDualOrAuto);

  let inReader = $derived(isReader());
  let volumeId = $derived($routeParams.volume);
  let volSettings = $derived(volumeId ? $effectiveVolumeSettings[volumeId] : undefined);

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
  // The primary row is named after what made it, from the volume's DB row (`ocr-label.ts`).
  let primaryName = $state('mokuro');
  $effect(() => {
    const id = inReader ? volumeId : '';
    if (!id) return;
    let cancelled = false;
    db.volumes
      .get(id)
      .then((row) => {
        if (!cancelled) primaryName = primaryLayerName(row);
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

  function onVolumeToggle(key: VolumeSettingsKey, value: boolean | undefined) {
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

{#if inReader && volSettings && volumeId}
  <AccordionItem>
    {#snippet header()}This volume{/snippet}
    <div class="flex flex-col gap-5">
      <Helper>Saved for this volume only</Helper>

      {#if showRtl}
        <Toggle
          size="small"
          checked={volSettings.rightToLeft}
          onchange={() => onVolumeToggle('rightToLeft', volSettings?.rightToLeft)}
        >
          Right to left
        </Toggle>
      {/if}

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
            <!-- Never on the shared layer: Unpublish (the layer menu) removes it. -->
            {#if currentLayer !== ORIGINAL_LAYER_ID && !isCuratedLayerId(currentLayer)}
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
    </div>
  </AccordionItem>
{/if}
