<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { get } from 'svelte/store';
  import { volumes } from '$lib/settings';
  import { personalizedReadingSpeed } from '$lib/settings/reading-speed';
  import { currentVolume, currentVolumeCharacterCount } from '$lib/catalog';
  import { calculateVolumeTimeToFinish } from '$lib/util/reading-speed';
  import { figuresFor, readingStats } from '$lib/reading-history/stats-store';
  import { seriesSpeeds } from '$lib/reading-history/series-speeds';
  import {
    endedView,
    liveMinutes,
    liveView,
    readingPaused,
    type EndedView
  } from '$lib/reading-history/live-view';
  import { viewCap } from '$lib/reading-history/stats-engine';

  /**
   * Time read in this volume, live (phase 3a, one clock): the counted reading
   * history plus the view on screen now, its dwell up to the idle cap, plus
   * views that just ended (`endedView`). Past the cap the timer stops and
   * shows "Idle"; "Still reading" splits the view, so the timer runs again.
   * Clicking pauses: the view ends and nothing counts until the next page or
   * a second click.
   */
  interface Props {
    volumeId: string;
    visible?: boolean;
  }

  let { volumeId, visible = true }: Props = $props();

  const TICK_MS = 15_000;
  let now = $state(Date.now());
  onMount(() => {
    const id = setInterval(() => (now = Date.now()), TICK_MS);
    return () => clearInterval(id);
  });

  let open = $derived($liveView?.view.volume === volumeId ? $liveView : null);
  let chars = $derived(open ? open.view.page_chars.reduce((sum, c) => sum + c, 0) : 0);
  let cap = $derived(open ? viewCap(chars, $readingStats.pace, $readingStats.idle) : 0);
  let counted = $derived(figuresFor($readingStats, volumeId, $volumes[volumeId]).timeMs);

  // Views that just ended are on their way into the stats (recorded, then
  // counted on the next pass): add what the stats WILL count for them until
  // the counted figure moves. Exact both ways — a page turn never dips, and an
  // answer that counts less than the time on screen shows at once.
  //
  // Only views that end AFTER this Timer mounts are pending here. Within one
  // volume the Timer is mounted whenever a view ends, so whatever the store
  // holds at mount is a previous visit's last view (leaving the reader closes
  // it), already counted or on its way — adding it again showed it twice.
  let seen: EndedView | null = get(endedView);
  let pending = $state<{ ms: number; base: number } | null>(null);
  $effect(() => {
    const ended = $endedView;
    if (ended === seen) return;
    seen = ended;
    if (!ended || ended.volume !== volumeId) return;
    untrack(() => {
      const base = counted;
      pending = { ms: (pending?.base === base ? pending.ms : 0) + ended.ms, base };
    });
  });
  let pendingMs = $derived(pending && pending.base === counted ? pending.ms : 0);
  let shown = $derived(liveMinutes(counted + pendingMs, open, now, cap));

  let status = $derived(
    $readingPaused || !open ? 'Paused' : now - open.since > cap ? 'Idle' : 'Active'
  );

  let timeEstimate = $derived.by(() => {
    const charsRead = $volumes[volumeId]?.chars || 0;
    const speed =
      ($currentVolume && $seriesSpeeds.get($currentVolume.series_uuid)) ||
      $personalizedReadingSpeed;
    return calculateVolumeTimeToFinish($currentVolumeCharacterCount, charsRead, speed);
  });

  function onClick() {
    now = Date.now();
    readingPaused.update((paused) => !paused);
  }
</script>

{#if visible}
  <button
    class:text-primary-700={status !== 'Active'}
    class="reader-hud fixed top-5 right-14 z-10 opacity-80"
    onclick={onClick}
  >
    {#key `${status}-${shown}`}
      <div class="text-right">
        <p>
          {status} | Minutes read: {shown}
        </p>
        {#if timeEstimate}
          <p class="text-sm">
            {timeEstimate.displayText}
          </p>
        {/if}
      </div>
    {/key}
  </button>
{/if}
