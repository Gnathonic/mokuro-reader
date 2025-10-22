<script lang="ts">
  import { settings, updateSetting } from '$lib/settings';
  import { AccordionItem, Toggle } from 'flowbite-svelte';
  let darkMode = $settings.darkMode;
</script>

<AccordionItem>
  <span slot="header">Appearance</span>
  <div class="flex flex-col gap-5">
    <div>
      <Toggle bind:checked={darkMode} on:change={() => {
        updateSetting('darkMode', darkMode)
      }}>Dark Mode</Toggle>
    </div>
  </div>
</AccordionItem>


