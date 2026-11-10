<script lang="ts" module>
  import type { AnnounceAction } from '$lib/keys/announce';

  /** One message on screen. `seq` changes on every show, so a repeat restarts the timer. */
  export interface ReaderNotice {
    message: string;
    key: string;
    seq: number;
    action?: AnnounceAction;
  }

  /** How long a plain message stays. */
  export const NOTICE_MS = 2000;
  /** How long a message with a button stays: long enough to reach it. */
  export const NOTICE_WITH_ACTION_MS = 5000;
</script>

<script lang="ts">
  import { untrack } from 'svelte';

  /**
   * The reader's in-overlay notification: what every hotkey announces
   * through (#55, spec 17.5).
   *
   * A notice may carry ONE button ("Set to manual" while a filter is on its
   * schedule). Such a notice stays 5 s instead of 2, and for as long as the
   * pointer or keyboard focus is on it. It never TAKES focus — the reader's
   * keys keep working under it — and a press on the button does not move
   * focus either. The button is a real `<button>`: the gesture layer
   * classifies it as interactive, so a tap on it neither turns the page nor
   * toggles the controls.
   */
  interface Props {
    notice: ReaderNotice | null;
    /** The notice ran out, or its button was pressed. */
    onDone: () => void;
  }

  let { notice, onDone }: Props = $props();

  // The KEY of the notice the pointer or focus is on. By key, not a flag: a
  // different notice replaces the element under the pointer without a
  // pointerleave, and must not inherit the hold.
  let heldKey = $state<string | null>(null);

  // A hold ends with the element it was on. `{#key}` swaps that element (and
  // a cleared notice removes it) without a pointerleave or focusout, so the
  // key would otherwise outlive its notice and the NEXT notice with the same
  // key would get no timer at all. Declared before the timer's effect, so
  // that one already sees the hold gone.
  $effect(() => {
    const key = notice?.key ?? null;
    untrack(() => {
      if (heldKey !== null && heldKey !== key) heldKey = null;
    });
  });

  $effect(() => {
    const current = notice;
    if (!current || heldKey === current.key) return;
    // A new object per show (`seq`), so a repeat of the same message restarts the timer.
    const timer = window.setTimeout(onDone, current.action ? NOTICE_WITH_ACTION_MS : NOTICE_MS);
    return () => clearTimeout(timer);
  });

  function hold(on: boolean) {
    // Only a notice with a button is worth holding; a plain one keeps its 2 s.
    heldKey = on && notice?.action ? notice.key : null;
  }

  function run(action: AnnounceAction) {
    heldKey = null;
    onDone();
    action.run();
  }
</script>

{#if notice}
  <!-- Keyed: extensions that rewrite text must not carry one message into the next. -->
  {#key notice.key}
    <!-- `w-max` up to the screen less a margin: one line while it fits (a box
         at `left: 50%` would otherwise shrink to half the screen), wrapping the
         message, never the button, on a phone. -->
    <div
      class="fixed top-5 left-1/2 z-20 flex w-max max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-3 rounded-lg bg-gray-900 px-4 py-2 text-white shadow-lg transition-opacity"
      style="backdrop-filter: blur(8px); background-color: rgba(17, 24, 39, 0.9);"
      role="status"
      data-reader-notification={notice.key}
      onpointerenter={() => hold(true)}
      onpointerleave={() => hold(false)}
      onfocusin={() => hold(true)}
      onfocusout={() => hold(false)}
    >
      <p class="text-sm font-medium">{notice.message}</p>
      {#if notice.action}
        {@const action = notice.action}
        <button
          type="button"
          class="shrink-0 rounded-md bg-white/15 px-2 py-0.5 text-sm font-medium whitespace-nowrap hover:bg-white/25"
          data-reader-notification-action
          onmousedown={(e) => e.preventDefault()}
          onclick={() => run(action)}>{action.label}</button
        >
      {/if}
    </div>
  {/key}
{/if}
