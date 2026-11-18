<script lang="ts">
  import { AccordionItem } from 'flowbite-svelte';
  import { nightModeActive, invertColorsActive, grayscaleActive } from '#lib/settings/index.js';
  import ScheduledFilterCard from './ScheduledFilterCard.svelte';
  import PageAdjustCard from './PageAdjustCard.svelte';

  /** "Page filters": colour filters (manual or scheduled) and the page image adjustments. */
</script>

<AccordionItem>
  {#snippet header()}Page filters{/snippet}
  <div class="flex flex-col gap-5">
    <ScheduledFilterCard
      title="Night mode"
      enableLabel="Enable night mode"
      hotkeyHint="N"
      settingKey="nightMode"
      scheduleKey="nightModeSchedule"
      active={$nightModeActive}
    />
    <ScheduledFilterCard
      title="Invert colors"
      enableLabel="Enable invert colors"
      hotkeyHint="I"
      settingKey="invertColors"
      scheduleKey="invertColorsSchedule"
      active={$invertColorsActive}
    />
    <ScheduledFilterCard
      title="Black & white"
      enableLabel="Enable black & white"
      hotkeyHint="G"
      settingKey="grayscale"
      scheduleKey="grayscaleSchedule"
      active={$grayscaleActive}
    />
    <!-- Page brightness / contrast — the images only, never the OCR text -->
    <PageAdjustCard />
  </div>
</AccordionItem>
