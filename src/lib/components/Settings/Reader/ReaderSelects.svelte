<script lang="ts">
  import { Label, Select } from 'flowbite-svelte';
  import type { SettingsKey } from '#lib/settings/index.js';
  import { settings, updateSetting } from '#lib/settings/index.js';

  let isContinuous = $derived($settings.continuousScroll);

  let zoomModeValue = $derived($settings.zoomDefault);
  let continuousZoomValue = $derived($settings.continuousZoomDefault);
  let pageTransitionValue = $derived($settings.pageTransition);

  let zoomModes = [
    { value: 'zoomFitToScreen', name: 'Fit to screen' },
    { value: 'zoomFitToWidth', name: 'Fit to width' },
    { value: 'zoomFillScreen', name: 'Fill screen' },
    { value: 'zoomOriginal', name: 'Original size' },
    { value: 'keepZoom', name: 'Keep zoom' }
  ];

  let continuousZoomModes = [
    { value: 'zoomFillScreen', name: 'Fill screen' },
    { value: 'zoomFitToScreen', name: 'Fit to screen' },
    { value: 'zoomOriginal', name: 'Original size (1:1)' }
  ];

  let pageTransitions = [
    { value: 'none', name: 'None' },
    { value: 'crossfade', name: 'Crossfade' },
    { value: 'pageTurn', name: 'Page Turn' },
    { value: 'swipe', name: 'Swipe' }
  ];

  function onSelectChange(event: Event, setting: SettingsKey) {
    updateSetting(setting, (event.target as HTMLInputElement).value);
  }
</script>

<div>
  <Label class="text-gray-900 dark:text-white">
    On page zoom:
    <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(Z)</span>
  </Label>
  {#if isContinuous}
    <Select
      items={continuousZoomModes}
      value={continuousZoomValue}
      onchange={(e) => onSelectChange(e, 'continuousZoomDefault')}
    />
  {:else}
    <Select
      items={zoomModes}
      value={zoomModeValue}
      onchange={(e) => onSelectChange(e, 'zoomDefault')}
    />
  {/if}
</div>
{#if !isContinuous}
  <div>
    <Label class="text-gray-900 dark:text-white">Page transition:</Label>
    <Select
      items={pageTransitions}
      value={pageTransitionValue}
      onchange={(e) => onSelectChange(e, 'pageTransition')}
    />
  </div>
{/if}
