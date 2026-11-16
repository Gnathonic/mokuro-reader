<script lang="ts">
  import { AccordionItem } from 'flowbite-svelte';
  import SettingToggle from './SettingToggle.svelte';
  import ReadingTimerSetting from './ReadingTimerSetting.svelte';

  /** "Overlays & timer": what the reader shows over the page, and the reading timer. */
</script>

<AccordionItem>
  {#snippet header()}Overlays & timer{/snippet}
  <div class="flex flex-col gap-5">
    <SettingToggle key="pageNum" text="Show page number" />
    <SettingToggle key="charCount" text="Show character count" />
    <SettingToggle key="quickActions" text="Show quick actions" />
    <SettingToggle key="showTimer" text="Show timer" />
    <ReadingTimerSetting />
  </div>
</AccordionItem>
