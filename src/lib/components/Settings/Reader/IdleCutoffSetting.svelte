<script lang="ts">
  import { Label, Range, Toggle } from 'flowbite-svelte';
  import { setIdleOverride, trackingState } from '$lib/settings/tracking-data';

  /**
   * The idle cutoff: how long one page may stay on screen before the time
   * stops counting as reading. Automatic adapts to the characters on screen
   * and the user's own pace; manual is one fixed value. Either way it is one
   * setting for every device (synced in `volume-data.json`), never a profile.
   */
  const DEFAULT_MANUAL_MINUTES = 5;

  let override = $derived($trackingState.idle?.override_minutes ?? null);
  let automatic = $derived(override === null);
</script>

<div class="mt-4">
  <Toggle
    checked={automatic}
    aria-label="Automatic idle cutoff"
    onchange={() => setIdleOverride(automatic ? DEFAULT_MANUAL_MINUTES : null)}
  >
    Automatic idle cutoff
  </Toggle>
  <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
    {#if automatic}
      Time on a page stops counting after a while, based on how much text is on screen and your
      reading speed.
    {:else}
      Time on a page stops counting after a fixed time.
    {/if}
  </p>
  {#if !automatic && override !== null}
    <Label class="mt-2 mb-2 text-gray-900 dark:text-white">
      Idle cutoff: {override} minutes
    </Label>
    <Range
      min="1"
      max="30"
      value={override}
      onchange={(e) => setIdleOverride(Number((e.target as HTMLInputElement).value))}
    />
  {/if}
</div>
