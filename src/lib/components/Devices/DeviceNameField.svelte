<script lang="ts">
  /**
   * The one editor for a device's name (phase 4). The Devices block on the
   * cloud screen, the per-device stats card and the second-device banner all
   * use it. Enter or Save stores the trimmed name through `renameDevice`
   * (synced in `volume-data.json → tracking.devices`). An empty name goes back
   * to the generated label, which is the placeholder. Escape abandons a draft,
   * and only then stops the key; on a clean field it still reaches whatever
   * is around (`data-escape-reverts`, as in `SeriesRenameField`).
   *
   * The Save button is always there, so nothing appears or moves as you type.
   * With no change it only ends the edit (`onDone`).
   */
  import { Button } from 'flowbite-svelte';
  import type { DeviceView } from '$lib/reading-history/devices';
  import { DEVICE_NAME_MAX, renameDevice } from '$lib/settings/tracking-data';

  let {
    device,
    onDone,
    autofocus = false
  }: {
    device: DeviceView;
    /** After Save/Enter, and on Escape over a clean field: an inline editor closes. */
    onDone?: () => void;
    autofocus?: boolean;
  } = $props();

  /** The stored name; '' while the device goes by its generated label. */
  let saved = $derived(device.named ? device.label : '');
  // Writable derived: typing overrides it; a new stored name (a save, or a
  // rename from another device arriving by sync) re-seeds it.
  let draft = $derived(saved);
  let dirty = $derived(draft.trim() !== saved);

  function save() {
    if (dirty) renameDevice(device.id, draft.trim());
    onDone?.();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      if (!dirty) {
        onDone?.();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      draft = saved;
    }
  }

  function focusOnMount(node: HTMLInputElement) {
    if (autofocus) node.focus();
  }
</script>

<div class="flex items-center gap-2" data-testid="device-name-field">
  <input
    type="text"
    value={draft}
    oninput={(e) => (draft = e.currentTarget.value)}
    {onkeydown}
    maxlength={DEVICE_NAME_MAX}
    placeholder={device.generated}
    aria-label="Device name"
    data-escape-reverts={dirty ? '' : undefined}
    {@attach focusOnMount}
    class="min-w-0 flex-1 rounded-lg border border-gray-300 bg-gray-50 px-2 py-1 text-sm text-gray-900 focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-400"
  />
  <!-- relative z-10: night mode's dialog filter resets stacking (see CLAUDE.md) -->
  <div class="relative z-10">
    <Button size="xs" color="primary" onclick={save}>Save</Button>
  </div>
</div>
