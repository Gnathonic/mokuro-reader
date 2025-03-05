<script lang="ts">
  import { page } from '$app/stores';
  import { zoomDefault } from '$lib/panzoom';
  import {
    updateProgress,
    updateVolumeSetting,
    volumes,
    volumeSettings,
    type VolumeSettingsKey
  } from '$lib/settings';
  import { AccordionItem, Helper, Toggle } from 'flowbite-svelte';

  const volumeId = $page.params.volume;

  let settings = $derived($volumeSettings[$page.params.volume]);

  let toggles = $derived([
    { key: 'rightToLeft', text: 'Right to left', value: settings.rightToLeft },
    { key: 'singlePageView', text: 'Single page view', value: settings.singlePageView },
    { key: 'hasCover', text: 'First page is cover', value: settings.hasCover }
  ] as { key: VolumeSettingsKey; text: string; value: any }[]);

  function onChange(key: VolumeSettingsKey, value: any) {
    updateVolumeSetting(volumeId, key, !value);
    if (key === 'hasCover') {
      const pageClamped = Math.max($volumes[volumeId].progress - 1, 1);
      updateProgress(volumeId, pageClamped);
      zoomDefault();
    }
  }
</script>

<AccordionItem open>
  {#snippet header()}
    <span>Volume settings</span>
  {/snippet}
  <div class="flex flex-col gap-5">
    <Helper>These settings only apply to this volume</Helper>
    {#each toggles as { key, text, value }}
      <Toggle size="small" checked={value} on:change={() => onChange(key, value)}>{text}</Toggle>
    {/each}
  </div>
</AccordionItem>
