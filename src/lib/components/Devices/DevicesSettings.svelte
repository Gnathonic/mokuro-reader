<script lang="ts">
  /**
   * The Devices block of the sync screen (spec "Settings → Sync → Devices";
   * it lives on `#/cloud`, the only sync UI). It lists every device this
   * library has been read on, grouped by `merged_into`. "This device" comes
   * first, then the others in the order they were first seen. Rows never sort
   * by name, so a rename never moves one. Each group has its name, its type
   * ("Automatic" = what the device detected about itself) and "Merge into…".
   * Merged devices sit under their target with "Unmerge". Every edit is a
   * label in `volume-data.json → tracking.devices`, so it syncs.
   *
   * The block appears once two raw device ids are known (`knownDevices`), not
   * two groups, so an unmerge stays reachable after everything has been merged
   * into one. Not `$devices.size`: that map also holds a view synthesized for a
   * merge target nobody here knows, which is not a second device.
   * Merging does not carry the source's name: the group shows the target's.
   */
  import { Badge, Button, Label, Modal, Select } from 'flowbite-svelte';
  import DeviceNameField from './DeviceNameField.svelte';
  import { CLASS_NAMES, type DeviceView } from '$lib/reading-history/devices';
  import { knownDevices, devices } from '$lib/reading-history/device-stats';
  import type { DeviceClass } from '$lib/reading-history/types';
  import {
    deviceLabels,
    mergeDevice,
    setDeviceClass,
    unmergeDevice
  } from '$lib/settings/tracking-data';

  const AUTO = 'auto';
  const CHOOSABLE: DeviceClass[] = ['phone', 'tablet', 'laptop', 'desktop'];

  let groups = $derived(
    [...$devices.values()]
      .filter((d) => d.id === d.canonical)
      .sort(
        (a, b) =>
          Number(b.isThisDevice) - Number(a.isThisDevice) ||
          a.firstSeen.localeCompare(b.firstSeen) ||
          a.id.localeCompare(b.id)
      )
  );

  function membersOf(group: DeviceView): DeviceView[] {
    return group.mergedFrom.flatMap((id) => $devices.get(id) ?? []);
  }

  function typeOptions(d: DeviceView) {
    const automatic =
      d.detectedClass === 'unknown'
        ? 'Automatic'
        : `Automatic (detected: ${CLASS_NAMES[d.detectedClass]})`;
    return [
      { value: AUTO, name: automatic },
      ...CHOOSABLE.map((c) => ({ value: c, name: CLASS_NAMES[c] }))
    ];
  }

  function typeValue(d: DeviceView): string {
    return $deviceLabels[d.id]?.class ?? AUTO;
  }

  function onTypeChange(d: DeviceView, event: Event) {
    const next = (event.target as HTMLSelectElement).value;
    setDeviceClass(d.id, next === AUTO ? null : (next as DeviceClass));
  }

  let mergeOpen = $state(false);
  let mergeSource = $state<DeviceView | null>(null);
  let mergeTarget = $state('');
  let mergeError = $state('');

  let mergeTargets = $derived.by(() => {
    const source = mergeSource;
    if (!source) return [];
    return groups
      .filter((g) => g.id !== source.id)
      .map((g) => ({ value: g.id, name: g.isThisDevice ? `${g.label} (this device)` : g.label }));
  });

  function openMerge(source: DeviceView) {
    mergeSource = source;
    mergeTarget = groups.find((g) => g.id !== source.id)?.id ?? '';
    mergeError = '';
    mergeOpen = true;
  }

  /** The dialog closes itself on Escape; the app-wide Escape would also leave this screen. */
  function keepEscapeInDialog(node: HTMLElement) {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') event.stopPropagation();
    };
    node.addEventListener('keydown', onKey);
    return () => node.removeEventListener('keydown', onKey);
  }

  function confirmMerge() {
    if (!mergeSource || !mergeTarget) return;
    if (!mergeDevice(mergeSource.id, mergeTarget)) {
      mergeError = "These two can't be merged.";
      return;
    }
    mergeOpen = false;
  }
</script>

{#if $knownDevices.length >= 2}
  <div class="mt-4 rounded-lg bg-gray-800 p-4" data-testid="devices-settings">
    <h3 class="mb-1 font-semibold">Devices</h3>
    <p class="mb-3 text-xs text-gray-400">
      The devices you read on. Names show in your reading stats on all of them.
    </p>
    <ul class="flex flex-col gap-3">
      {#each groups as group (group.id)}
        <li class="rounded-lg bg-gray-900/40 p-3" data-testid="device-row">
          <div class="flex flex-wrap items-center gap-2">
            <div class="min-w-48 flex-1">
              <DeviceNameField device={group} />
            </div>
            {#if group.isThisDevice}
              <Badge color="green">This device</Badge>
            {/if}
            <Select
              size="sm"
              class="w-48"
              aria-label="Device type"
              placeholder=""
              items={typeOptions(group)}
              value={typeValue(group)}
              onchange={(e: Event) => onTypeChange(group, e)}
            />
            {#if !group.isThisDevice}
              <Button size="xs" color="alternative" onclick={() => openMerge(group)}>
                Merge into…
              </Button>
            {/if}
          </div>
          {#if group.mergedFrom.length > 0}
            <ul class="mt-2 flex flex-col gap-1 border-l border-gray-700 pl-3">
              {#each membersOf(group) as member (member.id)}
                <li
                  class="flex items-center justify-between gap-2 text-sm text-gray-300"
                  data-testid="device-member"
                >
                  <span class="min-w-0 truncate">{member.label}</span>
                  <Button size="xs" color="alternative" onclick={() => unmergeDevice(member.id)}>
                    Unmerge
                  </Button>
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}

<Modal bind:open={mergeOpen} size="xs" autoclose={false}>
  {#if mergeSource}
    <div class="flex flex-col gap-4" {@attach keepEscapeInDialog}>
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">
        Merge {mergeSource.label}
      </h3>
      <p class="text-sm text-gray-500 dark:text-gray-400">
        Its reading will be listed under the device you pick, with that device's name. You can
        unmerge it later.
      </p>
      <div>
        <Label for="device-merge-target" class="mb-2">Merge into</Label>
        <Select
          id="device-merge-target"
          size="sm"
          placeholder=""
          items={mergeTargets}
          bind:value={mergeTarget}
        />
      </div>
      {#if mergeError}
        <p class="text-sm text-red-500">{mergeError}</p>
      {/if}
      <!-- relative z-10: night mode's dialog filter resets stacking (see CLAUDE.md) -->
      <div class="relative z-10 flex justify-end gap-2">
        <Button color="alternative" onclick={() => (mergeOpen = false)}>Cancel</Button>
        <Button color="primary" onclick={confirmMerge}>Merge</Button>
      </div>
    </div>
  {/if}
</Modal>
