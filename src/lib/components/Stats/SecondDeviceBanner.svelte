<script lang="ts" module>
  /** Per browser, not synced: it asks to name THIS device. */
  export const DEVICE_BANNER_DISMISSED_KEY = 'device-banner:dismissed';
</script>

<script lang="ts">
  import { Button } from 'flowbite-svelte';
  import DeviceNameField from '$lib/components/Devices/DeviceNameField.svelte';
  import { deviceStats, devices } from '$lib/reading-history/device-stats';

  /**
   * "You read on 2 devices — name this one?" (phase 4; spec: "Labels",
   * entry point 3). Inline under the page heading, never a modal. Asks while
   * two or more device groups have reading and this device's group has no
   * name; "Not now" ends it in this browser, and naming the device ends it
   * everywhere this device is the one asked about.
   *
   * No layout motion: naming here does not make the banner vanish under the
   * pointer. It stays, same box, same field, with a confirmation, until the
   * user closes it.
   */

  function readDismissed(): boolean {
    try {
      return window.localStorage.getItem(DEVICE_BANNER_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  let dismissed = $state(readDismissed());
  /** Asked on this visit: a name given since then is confirmed in place. */
  let asked = $state(false);

  let groups = $derived($deviceStats.nativeGroups);
  /** This device's group: its own entry, or the device it was merged into. */
  let own = $derived([...$devices.values()].find((v) => v.isThisDevice && v.id === v.canonical));
  let asking = $derived(groups >= 2 && own !== undefined && !own.named);

  $effect(() => {
    if (asking) asked = true;
  });

  function dismiss(): void {
    dismissed = true;
    try {
      window.localStorage.setItem(DEVICE_BANNER_DISMISSED_KEY, '1');
    } catch {
      // Storage blocked: it may ask again next visit. Harmless.
    }
  }
</script>

{#if !dismissed && own && (asking || (asked && own.named))}
  <div
    role="status"
    data-testid="device-banner"
    class="mb-6 flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800"
  >
    <p class="font-medium">
      {#if own.named}
        Saved. You can change it in the Devices list below.
      {:else}
        You read on {groups} devices — name this one?
      {/if}
    </p>
    <div class="flex flex-wrap items-end gap-2">
      <div class="min-w-0 flex-1">
        <DeviceNameField device={own} />
      </div>
      <Button size="sm" color="alternative" onclick={dismiss}>
        {own.named ? 'Close' : 'Not now'}
      </Button>
    </div>
  </div>
{/if}
