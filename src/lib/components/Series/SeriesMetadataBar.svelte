<!-- src/lib/components/Series/SeriesMetadataBar.svelte -->
<script lang="ts">
  import { Label, Select } from 'flowbite-svelte';
  import { seriesMetadataMap, updateSeriesMetadata } from '$lib/metadata/store';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import type { VolumeMetadata } from '$lib/types';
  import type { DisplayTitleLanguage } from '$lib/metadata/types';
  import SeriesLinkControls from './SeriesLinkControls.svelte';
  import SeriesTrackingPanel from './SeriesTrackingPanel.svelte';

  let { seriesTitle, volumes }: { seriesTitle: string; volumes: VolumeMetadata[] } = $props();

  const titleLanguageOptions = [
    { value: 'default', name: 'Default (global setting)' },
    { value: 'imported', name: 'As imported (folder name)' },
    { value: 'native', name: 'Native (日本語)' },
    { value: 'romaji', name: 'Romaji' },
    { value: 'english', name: 'English' }
  ];

  let meta = $derived($seriesMetadataMap.get(normalizeSeriesKey(seriesTitle)));
  let titlePreferenceValue = $derived(meta?.title_preference ?? 'default');
  let linked = $derived(!!meta && Object.values(meta.external_ids ?? {}).some((v) => v != null));

  async function onTitlePreferenceChange(e: Event & { currentTarget: HTMLSelectElement }) {
    const value = e.currentTarget.value;
    await updateSeriesMetadata(seriesTitle, {
      title_preference: value === 'default' ? undefined : (value as DisplayTitleLanguage)
    });
  }
</script>

<div class="flex flex-col gap-2 px-2 text-sm">
  <SeriesLinkControls {seriesTitle} {volumes} />

  <!-- Only a linked series has native/romaji/english titles to choose between; on an
       unlinked one every option would resolve back to the folder name. -->
  {#if linked}
    <div class="flex min-w-[14rem] flex-col gap-1">
      <Label class="text-xs text-gray-500 uppercase">Title language</Label>
      <Select
        size="sm"
        items={titleLanguageOptions}
        value={titlePreferenceValue}
        onchange={onTitlePreferenceChange}
      />
    </div>
  {/if}

  <SeriesTrackingPanel {seriesTitle} {volumes} />
</div>
