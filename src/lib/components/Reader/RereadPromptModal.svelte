<script lang="ts">
  import { Button, Modal } from 'flowbite-svelte';
  import type { VolumeMetadata } from '$lib/types';
  import {
    dismissRereadForSession,
    restartSeries,
    suppressRereadPrompt
  } from '$lib/metadata/reread';
  import { showSnackbar } from '$lib/util';

  interface Props {
    open: boolean;
    seriesTitle: string;
    seriesKey: string;
    seriesVolumes: VolumeMetadata[];
    displayTitle: string;
  }

  let {
    open = $bindable(false),
    seriesTitle,
    seriesKey,
    seriesVolumes,
    displayTitle
  }: Props = $props();

  let busy = $state(false);

  // Guards against the underlying Flowbite dialog's native `close` event, which
  // also fires when its teardown runs `dialog.close()` right after `open` flips
  // to false. Only `restart()` needs this: a redundant `handleClose()` after a
  // successful restart would re-dismiss the session right after `restartSeries`
  // deliberately cleared it, silently re-suppressing a future prompt for the
  // rest of the browser tab's session. `notNow`/`dontAsk` are idempotent, so a
  // redundant re-firing after them is harmless.
  let suppressCloseDismiss = false;

  function dismissForSession() {
    dismissRereadForSession(seriesKey);
    open = false;
  }

  async function restart() {
    busy = true;
    suppressCloseDismiss = true;
    try {
      await restartSeries(seriesTitle, seriesVolumes);
      showSnackbar('Series restarted — your previous read is kept in your stats');
      open = false;
    } catch (error) {
      console.error('[reread] restart failed:', error);
      showSnackbar('Could not restart the series');
      suppressCloseDismiss = false;
    } finally {
      busy = false;
    }
  }

  function notNow() {
    dismissForSession();
  }

  function dontAsk() {
    dismissForSession();
    try {
      suppressRereadPrompt(seriesTitle);
    } catch (error) {
      console.warn('[reread] could not persist suppression:', error);
    }
  }

  // Fires on a native dialog close we didn't already handle ourselves: a
  // backdrop click (`outsideclose`), or the dialog's own teardown re-firing
  // `close` right after one of the actions above already flipped `open`.
  function handleClose() {
    if (suppressCloseDismiss) {
      suppressCloseDismiss = false;
      return;
    }
    dismissForSession();
  }

  // Reader shortcut keys that must not reach the reader/continuous-scroll
  // readers while this modal is open. Paged-mode paging/zoom-scroll AND (in
  // continuous-scroll mode) VerticalScrollReader/HorizontalScrollReader's own
  // `<svelte:window onkeydown>` listeners all live at the bubble phase, so
  // stopping propagation here (at capture) keeps every one of them from ever
  // seeing these keys. Not `preventDefault`: a focused button (e.g. one of
  // ours, which Flowbite auto-focuses) must still activate on Space.
  const BLOCKED_NAV_KEYS = new Set([
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'PageUp',
    'PageDown',
    ' ',
    'Home',
    'End'
  ]);

  // Capture Escape before it bubbles to the reader's own page-turn/back
  // shortcuts (Reader.svelte's handleShortcuts) AND the app-wide "Escape =
  // navigateBack" handler in +layout.svelte — both are bubble-phase
  // `<svelte:window onkeydown>` listeners the reader mounts underneath this
  // modal. `preventDefault` also suppresses the native <dialog>
  // close-on-Escape default action, so we fully own the close here instead of
  // going through `handleClose`. Gated on `!busy`, mirroring SeriesLinkModal's
  // Escape guard, so Escape can't interrupt an in-flight restart.
  $effect(() => {
    if (!open) return;

    // The same modal instance can reopen for a later volume/series. Reset
    // here (start of a fresh open, not on close) so a stale `true` left over
    // from a previous cycle can never swallow a later legitimate close —
    // resetting on close instead would race the dialog's own native `close`
    // event (fired by its teardown right after this same `open = false`),
    // which needs to see the flag `restart()` just set.
    suppressCloseDismiss = false;

    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (!busy) dismissForSession();
        return;
      }
      if (BLOCKED_NAV_KEYS.has(e.key)) {
        e.stopPropagation();
      }
    }

    window.addEventListener('keydown', handleKeydown, true);
    return () => window.removeEventListener('keydown', handleKeydown, true);
  });
</script>

<Modal bind:open size="sm" outsideclose onclose={handleClose}>
  <div class="flex flex-col gap-4">
    <h3 class="text-lg font-semibold text-gray-900 dark:text-white">Start a re-read?</h3>
    <p class="text-sm text-gray-600 dark:text-gray-400">
      You've finished <span class="font-medium">{displayTitle}</span>. Restarting resets every
      volume to the start and counts another read — your reading time and stats are kept.
    </p>
    <div class="relative z-10 flex flex-wrap justify-end gap-2">
      <Button color="alternative" size="sm" onclick={dontAsk} disabled={busy}>
        Don't ask for this series
      </Button>
      <Button color="alternative" size="sm" onclick={notNow} disabled={busy} data-autofocus>
        Not now
      </Button>
      <Button color="primary" size="sm" onclick={restart} disabled={busy}>Restart series</Button>
    </div>
  </div>
</Modal>
