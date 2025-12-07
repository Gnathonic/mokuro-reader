<script lang="ts">
  import { settings, updateSetting } from '$lib/settings';
  import { AccordionItem, Toggle } from 'flowbite-svelte';
</script>

<AccordionItem>
  {#snippet header()}Appearance{/snippet}
  <div class="flex flex-col gap-3">
    <Toggle
      size="small"
      checked={$settings.darkMode}
      onchange={() => updateSetting('darkMode', !$settings.darkMode)}
    >
      Dark Mode
    </Toggle>
    <p class="text-xs text-gray-500 dark:text-gray-400">
      Light mode is useful for e-readers with poor contrast.
    </p>
  </div>
</AccordionItem>
