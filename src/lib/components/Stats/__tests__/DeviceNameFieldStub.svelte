<script lang="ts">
  /**
   * Test double for `DeviceNameField` (Task 4): these suites test where the
   * field is mounted and for which device, not how it saves.
   */
  import type { DeviceView } from '$lib/reading-history/devices';

  let { device, onDone }: { device: DeviceView; onDone?: () => void } = $props();
</script>

<input type="text" aria-label="Device name" data-device={device.id} value={device.label} />
<button type="button" onclick={() => onDone?.()}>Done</button>
