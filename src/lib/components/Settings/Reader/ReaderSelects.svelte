<script lang="ts">
  import { Label, Select } from 'flowbite-svelte';
  import type { SettingsKey } from '$lib/settings';
  import { settings, updateSetting } from '$lib/settings';
  import { listOptions } from '$lib/settings/setting-defs';
  import KeyHint from '../Keys/KeyHint.svelte';

  let isContinuous = $derived($settings.continuousScroll);

  let zoomModeValue = $derived($settings.zoomDefault);
  let continuousZoomValue = $derived($settings.continuousZoomDefault);
  let fontSizeValue = $derived($settings.fontSize);
  let pageTransitionValue = $derived($settings.pageTransition);

  // The option lists are the setting definitions' (#55): one list, used by
  // these selects and by the key actions generated from it.
  const zoomModes = listOptions('zoom-paged');
  const continuousZoomModes = listOptions('zoom-continuous');
  const pageTransitions = listOptions('page-transition');
  const fontSizes = listOptions('font-size');

  function onSelectChange(event: Event, setting: SettingsKey) {
    updateSetting(setting, (event.target as HTMLInputElement).value);
  }
</script>

<div>
  <Label class="text-gray-900 dark:text-white">
    On page zoom:
    <KeyHint id="reader.zoom-mode" />
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
<div>
  <Label class="text-gray-900 dark:text-white">Fontsize:</Label>
  <Select items={fontSizes} value={fontSizeValue} onchange={(e) => onSelectChange(e, 'fontSize')} />
</div>
