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

  async function dontAsk() {
    dismissForSession();
    try {
      await suppressRereadPrompt(seriesTitle);
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

  // Capture Escape before it bubbles to the reader's own page-turn/back
  // shortcuts (Reader.svelte's handleShortcuts) AND the app-wide "Escape =
  // navigateBack" handler in +layout.svelte — both are bubble-phase
  // `<svelte:window onkeydown>` listeners the reader mounts underneath this
  // modal. `preventDefault` also suppresses the native <dialog>
  // close-on-Escape default action, so we fully own the close here instead of
  // going through `handleClose`.
  $effect(() => {
    if (!open) return;

    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        dismissForSession();
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
      <Button color="alternative" size="sm" onclick={notNow} disabled={busy}>Not now</Button>
      <Button color="primary" size="sm" onclick={restart} disabled={busy}>Restart series</Button>
    </div>
  </div>
</Modal>
