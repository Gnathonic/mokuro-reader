<script lang="ts">
  import { AccordionItem, Label, Range, Select } from 'flowbite-svelte';
  import ReaderSelects from './ReaderSelects.svelte';
  import ReaderToggles from './ReaderToggles.svelte';
  import { settings, updateSetting, type SwipeSensitivity } from '$lib/settings';

  let swipeSensitivityValue = $state($settings.swipeSensitivity);
  let edgeButtonWidthValue = $state($settings.edgeButtonWidth);

  const sensitivityOptions: { value: SwipeSensitivity; name: string }[] = [
    { value: 'low', name: 'Low - Requires faster swipes' },
    { value: 'medium', name: 'Medium - Balanced' },
    { value: 'high', name: 'High - Responds to light swipes' }
  ];

  function onSwipeChange() {
    updateSetting('swipeSensitivity', swipeSensitivityValue);
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
        Swipe sensitivity
        <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(Mobile only)</span>
      </Label>
      <Select
        items={sensitivityOptions}
        bind:value={swipeSensitivityValue}
        onchange={onSwipeChange}
        disabled={!$settings.mobile}
      />
    </div>
    <div>
      <Label>Edge button width</Label>
      <Range onchange={onWidthChange} min={1} max={100} bind:value={edgeButtonWidthValue} />
    </div>
  </div>
</AccordionItem>
