<script lang="ts">
  import { Label, Range } from 'flowbite-svelte';
  import { EDGE_STRIP_MAX, settings, updateSetting } from '#lib/settings/index.js';
  import SettingToggle from './SettingToggle.svelte';

  /**
   * Tap-to-turn (#54) as ONE group: two controls, one region each, never
   * overlapping (`PageTurnZones.svelte`).
   *
   * - "Tap beside or below the page" (`tapOutsideImageToTurn`): the
   *   background outside the page image.
   * - "Page edge zone" (`edgeButtonWidth`, 0 = off): a strip on the page
   *   image's own left / right edge — on desktop also down the screen's edge,
   *   wherever the page is under it.
   *
   * The slider shows its value while dragging and writes once on release.
   */
  let draft = $state<number | null>(null);
  let width = $derived(draft ?? $settings.edgeButtonWidth ?? 0);
</script>

<div class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
  <h3 class="mb-2 text-sm font-medium text-gray-900 dark:text-white">Tap to turn pages</h3>
  <div class="space-y-3">
    <SettingToggle
      key="tapOutsideImageToTurn"
      text="Tap beside or below the page"
      description="Taps on the empty background turn the page. Turn off to tap there safely, e.g. to close a dictionary popup."
    />
    <div>
      <Label for="page-edge-zone" class="mb-1 text-gray-900 dark:text-white">
        Page edge zone: {width > 0 ? `${width}px` : 'off'}
      </Label>
      <Range
        id="page-edge-zone"
        min={0}
        max={EDGE_STRIP_MAX}
        value={width}
        oninput={(e) => (draft = Number((e.target as HTMLInputElement).value))}
        onchange={(e) => {
          updateSetting('edgeButtonWidth', Number((e.target as HTMLInputElement).value));
          draft = null;
        }}
      />
      <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Taps this close to the page's left or right edge turn it{$settings.mobile
          ? ''
          : ', and so do taps at the screen edge over a zoomed-in page'}. 0 turns it off.
      </p>
    </div>
    <p class="text-xs text-gray-500 dark:text-gray-400">
      Keys and quick actions always turn pages; swipes do with Mobile on.
    </p>
  </div>
</div>
