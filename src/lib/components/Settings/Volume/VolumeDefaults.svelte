<script lang="ts">
  import { settings, updateVolumeDefaults, type VolumeDefaultsKey } from '$lib/settings';
  import { AccordionItem, Helper, Toggle } from 'flowbite-svelte';

  let toggles = $derived([
    { key: 'rightToLeft', text: 'Right to left', value: $settings.volumeDefaults?.rightToLeft },
    {
      key: 'singlePageView',
      text: 'Single page view',
      value: $settings.volumeDefaults?.singlePageView
    },
    { key: 'hasCover', text: 'First page is cover', value: $settings.volumeDefaults?.hasCover }
  ] as { key: VolumeDefaultsKey; text: string; value: any }[]);
</script>

<AccordionItem open>
  {#snippet header()}
    <span>Volume defaults</span>
  {/snippet}
  <div class="flex flex-col gap-5">
    <Helper>The default settings that are applied when you start a new volume</Helper>
    {#each toggles as { key, text, value }}
      <Toggle size="small" checked={value} on:change={() => updateVolumeDefaults(key, !value)}
        >{text}</Toggle
      >
    {/each}
  </div>
</AccordionItem>
