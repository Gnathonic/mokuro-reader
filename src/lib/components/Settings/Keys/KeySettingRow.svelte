<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ChevronDownOutline, ChevronRightOutline } from 'flowbite-svelte-icons';
  import { ExclamationCircleSolid } from 'flowbite-svelte-icons';
  import type { IconName } from '$lib/keys/icon-names';
  import { actionIcon } from '$lib/keys/icons';

  /**
   * One LIST or SLIDER setting in the shortcuts section (#55, spec 17.9): a
   * single row that opens to its actions (Next, Previous and each "Set to";
   * or Step up, Step down, Reset). Closed, it says what is inside, so a key
   * bound three levels down is never invisible. It derives nothing: the
   * section hands it its line, its marks and whether it is open, and its
   * action rows mount only while it is.
   */
  interface Props {
    /** `setting:<def>` — the target's key. */
    id: string;
    label: string;
    icon: IconName;
    /** "7 actions · 2 keys · 1 on the quick menu". */
    summary: string;
    open: boolean;
    /** One of its actions has a changed key or quick-menu choice. */
    changed?: boolean;
    /** One of its actions shares a key with another action. */
    conflict?: boolean;
    onToggle: () => void;
    children: Snippet;
  }

  let {
    id,
    label,
    icon,
    summary,
    open,
    changed = false,
    conflict = false,
    onToggle,
    children
  }: Props = $props();

  let Icon = $derived(actionIcon(icon));
</script>

<div
  class="border-l-[3px] {changed ? 'border-l-primary-600' : 'border-l-transparent'}"
  data-key-setting={id}
>
  <button
    type="button"
    class="flex w-full items-center gap-2 py-2 pr-1 pl-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700/50"
    aria-expanded={open}
    onclick={onToggle}
  >
    <Icon class="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden="true" />
    <span class="flex min-w-0 flex-col">
      <span class="flex items-center gap-2 font-medium text-gray-900 dark:text-white">
        {label}
        {#if conflict}
          <span
            class="inline-flex text-amber-500"
            role="img"
            aria-label="Holds a key shared with another action"
            title="One of these shares a key with another action"
          >
            <ExclamationCircleSolid class="h-4 w-4" />
          </span>
        {/if}
      </span>
      <span class="text-xs text-gray-500 dark:text-gray-400" data-key-setting-summary
        >{summary}</span
      >
    </span>
    <span class="flex-1"></span>
    {#if open}
      <ChevronDownOutline class="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
    {:else}
      <ChevronRightOutline class="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
    {/if}
  </button>
  {#if open}
    <div
      class="mb-1 ml-4 divide-y divide-gray-200 border-l border-gray-200 dark:divide-gray-700/60 dark:border-gray-700"
    >
      {@render children()}
    </div>
  {/if}
</div>
