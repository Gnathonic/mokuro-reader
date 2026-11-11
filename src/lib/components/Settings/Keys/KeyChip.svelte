<script lang="ts">
  import { CloseOutline, LockSolid } from 'flowbite-svelte-icons';

  interface Props {
    label: string;
    /** Locked chords (Escape on Back) show a lock and cannot be removed. */
    locked?: boolean;
    /** Accessible name of the action, for the remove button. */
    actionLabel: string;
    onRemove?: () => void;
  }

  let { label, locked = false, actionLabel, onRemove }: Props = $props();
</script>

<span
  class="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-gray-50 py-0.5 pr-1 pl-2 font-mono text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
  data-key-chip={label}
>
  {label}
  {#if locked}
    <span class="inline-flex text-gray-400" title="Always on" aria-label="Always on">
      <LockSolid class="h-3 w-3" />
    </span>
  {:else}
    <button
      type="button"
      class="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-white"
      aria-label={`Remove ${label} from ${actionLabel}`}
      onclick={onRemove}
    >
      <CloseOutline class="h-3 w-3" />
    </button>
  {/if}
</span>
