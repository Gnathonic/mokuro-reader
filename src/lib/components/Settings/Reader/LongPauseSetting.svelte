<script lang="ts">
  import { Button, Label, Select } from 'flowbite-svelte';
  import { DEFAULT_K } from '$lib/reading-history/stats-engine';
  import type { PauseCount } from '$lib/reading-history/types';
  import {
    idleSettings,
    pauseDefault,
    resetIdleK,
    setPauseDefault
  } from '$lib/settings/tracking-data';

  /**
   * What a page left open past the idle cutoff counts (phase 3b). The choices
   * are to ask each time, or a standing answer that stops the prompt. The
   * standing answer is written for views that reach the cutoff from now on,
   * never for pauses already recorded, which are answered in the review list
   * on the stats page. Synced in `volume-data.json` like the cutoff itself.
   *
   * "Still reading" answers widen the automatic cutoff (`k`); Reset puts it
   * back.
   */
  const ASK = 'ask';
  const options = [
    { value: ASK, name: 'Ask me' },
    { value: 'full', name: 'Count all' },
    { value: 'typical', name: 'Count typical' },
    { value: 'none', name: "Don't count" }
  ];

  let value = $derived($pauseDefault ?? ASK);
  let k = $derived($idleSettings.k);

  function onchange(e: Event) {
    const next = (e.target as HTMLSelectElement).value;
    setPauseDefault(next === ASK ? null : (next as PauseCount));
  }
</script>

<div class="mt-4">
  <Label for="long-pause-default" class="mb-2 text-gray-900 dark:text-white">
    When a page stays open past the cutoff
  </Label>
  <Select id="long-pause-default" size="sm" placeholder="" items={options} {value} {onchange} />
  <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
    {#if value === ASK}
      The reader asks whether you were still reading. Pauses you leave unanswered count a typical
      time until you answer them on the stats page.
    {:else}
      No prompt: long pauses from now on are counted this way.
    {/if}
  </p>
  {#if k > DEFAULT_K}
    <div
      class="mt-2 flex items-center justify-between gap-2 text-sm text-gray-700 dark:text-gray-300"
    >
      <span>Cutoff widened ×{Math.round(k * 10) / 10}</span>
      <Button size="xs" color="alternative" onclick={resetIdleK}>Reset</Button>
    </div>
  {/if}
</div>
