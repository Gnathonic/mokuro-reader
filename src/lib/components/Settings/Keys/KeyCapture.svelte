<script lang="ts">
  import { startCapture } from '$lib/keys/capture-session';

  interface Props {
    capturing: boolean;
    actionLabel: string;
    onStart: () => void;
    onCancel: () => void;
    onChord: (chord: string) => void;
  }

  let { capturing, actionLabel, onStart, onCancel, onChord }: Props = $props();

  let button: HTMLButtonElement | undefined = $state();

  // The window listener lives exactly as long as `capturing` is true here —
  // the parent ends it (another row starting, a save) by flipping the prop.
  $effect(() => {
    if (!capturing) return;
    // Callbacks read at call time, so a new closure never restarts recording.
    return startCapture(button ?? null, {
      onChord: (chord) => onChord(chord),
      onCancel: () => onCancel()
    });
  });
</script>

<button
  bind:this={button}
  type="button"
  class="rounded-md border px-2 py-0.5 text-xs {capturing
    ? 'border-primary-600 bg-primary-50 text-primary-700 dark:bg-gray-900 dark:text-primary-400'
    : 'border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'}"
  aria-label={capturing ? `Recording a key for ${actionLabel}` : `Add a key to ${actionLabel}`}
  aria-pressed={capturing}
  data-key-capture
  onclick={() => (capturing ? onCancel() : onStart())}
>
  {capturing ? 'Press a key… (Esc cancels)' : '+ Add'}
</button>
