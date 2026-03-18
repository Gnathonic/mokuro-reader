<script lang="ts">
  import { AccordionItem, Label, Range, Toggle, Select } from 'flowbite-svelte';
  import ReaderSelects from './ReaderSelects.svelte';
  import ReaderToggles from './ReaderToggles.svelte';
  import { settings, updateSetting, type ScrollMode } from '$lib/settings';

  let isContinuous = $derived($settings.continuousScroll);
  let scrollMode = $derived($settings.scrollMode);

  const scrollModes: { value: ScrollMode; name: string }[] = [
    { value: 'vertical', name: 'Vertical scroll' },
    { value: 'horizontal', name: 'Horizontal scroll' }
  ];

  let swipeThresholdValue = $state($settings.swipeThreshold);
  let edgeButtonWidthValue = $state($settings.edgeButtonWidth);
  function onSwipeChange() {
    updateSetting('swipeThreshold', swipeThresholdValue);
  }

  function onWidthChange() {
    updateSetting('edgeButtonWidth', edgeButtonWidthValue);
  }
</script>

<AccordionItem>
  {#snippet header()}Reader{/snippet}
  <div class="flex flex-col gap-5">
    <Toggle
      size="small"
      checked={isContinuous}
      onchange={() => updateSetting('continuousScroll', !isContinuous)}
    >
      Continuous scroll
      <span class="ml-1 text-xs font-medium text-amber-600 dark:text-amber-400">Beta</span>
      <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(V)</span>
    </Toggle>
    {#if isContinuous}
      <div>
        <Label class="text-gray-900 dark:text-white">Scroll mode:</Label>
        <Select
          size="sm"
          items={scrollModes}
          value={scrollMode}
          onchange={(e) => updateSetting('scrollMode', (e.target as HTMLSelectElement).value)}
        />
      </div>
    {/if}
    <hr class="border-gray-100 opacity-10" />
    <ReaderSelects />
    <hr class="border-gray-100 opacity-10" />
    <ReaderToggles />
    {#if !isContinuous}
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
