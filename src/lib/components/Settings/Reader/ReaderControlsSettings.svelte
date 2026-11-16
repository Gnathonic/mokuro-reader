<script lang="ts">
  import { AccordionItem, Label, Range } from 'flowbite-svelte';
  import { settings, updateSetting } from '#lib/settings/index.js';
  import SettingToggle from './SettingToggle.svelte';
  import PageTurnSettings from './PageTurnSettings.svelte';

  /**
   * "Controls": every reader-input option in one place — touch layout,
   * panning, tap-to-turn, swipes, wheel and keys. The paged-only ones hide in
   * continuous scroll, which has no edge zones, swipe-to-flip or bounds.
   */
  let isPaged = $derived(!$settings.continuousScroll);

  let swipeDraft = $state<number | null>(null);
  let swipe = $derived(swipeDraft ?? $settings.swipeThreshold);
</script>

<AccordionItem>
  {#snippet header()}Controls{/snippet}
  <div class="flex flex-col gap-5">
    {#if isPaged}
      <SettingToggle
        key="mobile"
        text="Mobile"
        description="Touch layout: swipe to turn pages, and the page stays within its bounds."
      />
      <SettingToggle
        key="bounds"
        text="Bounds"
        description="Panning stops at the page's edges (always on with Mobile)."
      />
      <PageTurnSettings />
      <div>
        <Label for="swipe-threshold" class="text-gray-900 dark:text-white">
          Swipe threshold: {swipe}%
          <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">(Mobile only)</span>
        </Label>
        <Range
          id="swipe-threshold"
          min={20}
          max={90}
          disabled={!$settings.mobile}
          value={swipe}
          oninput={(e) => (swipeDraft = Number((e.target as HTMLInputElement).value))}
          onchange={(e) => {
            updateSetting('swipeThreshold', Number((e.target as HTMLInputElement).value));
            swipeDraft = null;
          }}
        />
      </div>
    {/if}
    <SettingToggle key="swapWheelBehavior" text="Swap mouse wheel scroll/zoom" />
    <SettingToggle key="pageKeysScrollFirst" text="Page Up/Down scroll tall pages before turning" />
  </div>
</AccordionItem>
