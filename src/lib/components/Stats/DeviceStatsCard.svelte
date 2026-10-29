<script lang="ts">
  import { Badge, Card } from 'flowbite-svelte';
  import DeviceNameField from '$lib/components/Devices/DeviceNameField.svelte';
  import { deviceStats, devices, type DeviceStatsRow } from '$lib/reading-history/device-stats';
  import { UNKNOWN_DEVICE_LABEL, type DeviceView } from '$lib/reading-history/devices';
  import { formatDuration, formatRelativeDate } from '$lib/util/reading-speed-history';

  /**
   * Per-device stats (phase 4; spec: "Labels", entry point 2): one row per
   * device group — merged devices count as the device they were merged into —
   * then "Before history" and "Edits" (each hidden when empty). Click a
   * device's name to rename it in place.
   *
   * Shown only when two or more groups have reading of their own: a
   * single-device user never sees a device anywhere.
   *
   * No layout motion: the order is fixed (this device, then by first seen),
   * never by the figures, and each figure sits in a fixed-width slot, so a
   * recount never moves or re-flows a row.
   */

  /** The group whose name field is open. One at a time. */
  let editing = $state<string | null>(null);

  let groups = $derived($deviceStats.nativeGroups);
  let rows = $derived(ordered($deviceStats.rows, $devices));

  function ordered(all: DeviceStatsRow[], views: Map<string, DeviceView>): DeviceStatsRow[] {
    const firstSeen = (key: string) => views.get(key)?.firstSeen ?? '￿';
    const own = (key: string) => (views.get(key)?.isThisDevice ? 0 : 1);
    const devs = all
      .filter((r) => r.kind === 'device')
      .sort(
        (a, b) =>
          own(a.key) - own(b.key) ||
          firstSeen(a.key).localeCompare(firstSeen(b.key)) ||
          a.key.localeCompare(b.key)
      );
    const extra = (kind: DeviceStatsRow['kind']) =>
      all.filter((r) => r.kind === kind && (r.timeMs !== 0 || r.readChars !== 0));
    return [...devs, ...extra('before-history'), ...extra('edits')];
  }

  function nameOf(row: DeviceStatsRow, view: DeviceView | undefined): string {
    if (row.kind === 'before-history') return 'Before history';
    if (row.kind === 'edits') return 'Edits';
    return view?.label ?? UNKNOWN_DEVICE_LABEL;
  }

  function subline(row: DeviceStatsRow, view: DeviceView | undefined): string {
    if (row.kind === 'before-history') return 'Reading from before devices were tracked';
    if (row.kind === 'edits') return 'Changes made in the volume editor';
    const parts: string[] = [];
    if (row.lastReadAt !== null) {
      parts.push(`Last read ${formatRelativeDate(new Date(row.lastReadAt)).toLowerCase()}`);
    }
    const merged = view?.mergedFrom.length ?? 0;
    if (merged > 0) parts.push(`includes ${merged} merged device${merged === 1 ? '' : 's'}`);
    return parts.join(' · ');
  }

  /** Edits can be negative: an editor change can take time away. */
  const time = (ms: number) => (ms < 0 ? '−' : '') + formatDuration(Math.abs(ms) / 60_000);
  const count = (n: number) => Math.round(n).toLocaleString('en-US');
  const speed = (cpm: number | null) => (cpm === null ? '—' : `${Math.round(cpm)} chars/min`);

  function share(row: DeviceStatsRow): string {
    if (row.timeMs <= 0 || row.share <= 0) return '—';
    if (row.share < 0.01) return '<1% of time';
    return `${Math.round(row.share * 100)}% of time`;
  }

  /** The swapped-in field takes the keyboard at once. */
  function focusInput(node: HTMLElement): void {
    node.querySelector('input')?.focus();
  }
</script>

{#if groups >= 2}
  <Card class="mb-6 w-full max-w-none p-6" data-testid="device-stats">
    <h2 class="mb-1 text-xl font-semibold">Devices</h2>
    <p class="mb-4 text-sm text-gray-400">
      Where your reading happened. Click a name to change it.
    </p>
    <ul class="divide-y divide-gray-200 dark:divide-gray-700">
      {#each rows as row (`${row.kind}:${row.key}`)}
        {@const view = row.kind === 'device' ? $devices.get(row.key) : undefined}
        <li class="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="device-row">
          <div class="min-w-0 flex-1">
            {#if view && editing === row.key}
              <div use:focusInput>
                <DeviceNameField device={view} onDone={() => (editing = null)} />
              </div>
            {:else}
              <div class="flex min-w-0 items-center gap-2">
                {#if view}
                  <button
                    type="button"
                    class="truncate text-left font-medium hover:underline"
                    title="Rename"
                    data-testid="device-name"
                    onclick={() => (editing = row.key)}>{view.label}</button
                  >
                  {#if view.isThisDevice}
                    <Badge color="blue">This device</Badge>
                  {/if}
                {:else}
                  <p class="truncate font-medium" data-testid="device-name">{nameOf(row, view)}</p>
                {/if}
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400">{subline(row, view)}</p>
            {/if}
          </div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
            <span class="w-20 text-right" title="Time read">{time(row.timeMs)}</span>
            <span class="w-32 text-right" title="Characters read">{count(row.readChars)} chars</span
            >
            <span class="w-28 text-right" title="Share of reading time">{share(row)}</span>
            <span class="w-28 text-right" title="Average speed">{speed(row.charsPerMinute)}</span>
          </div>
        </li>
      {/each}
    </ul>
  </Card>
{/if}
