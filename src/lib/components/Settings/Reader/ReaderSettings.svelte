<script lang="ts">
  import { AccordionItem, Label, Range } from 'flowbite-svelte';
  import ReaderSelects from './ReaderSelects.svelte';
  import ReaderToggles from './ReaderToggles.svelte';
  import { settings, updateSetting } from '$lib/settings';

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
    <ReaderSelects />
    <hr class="border-gray-100 opacity-10" />
    <ReaderToggles />
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
  </div>
</AccordionItem>
