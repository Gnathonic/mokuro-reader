<script lang="ts">
  import { fade } from 'svelte/transition';
  import type { YomitanAnkiButtonVariant } from '$lib/yomitan/anki-button-ui';

  interface Props {
    label: string;
    title: string;
    disabled: boolean;
    variant: YomitanAnkiButtonVariant;
    fadeIn?: boolean;
    onSelect?: () => void;
  }

  let { label, title, disabled, variant, fadeIn = false, onSelect }: Props = $props();

  function resolveVariantClass(nextVariant: YomitanAnkiButtonVariant) {
    switch (nextVariant) {
      case 'warning':
        return 'border-orange-600 bg-orange-600 text-white enabled:hover:bg-orange-700';
      case 'success':
        return 'border-green-600 bg-green-600 text-white enabled:hover:bg-green-600';
      case 'danger':
        return 'border-red-600 bg-red-600 text-white enabled:hover:bg-red-700';
      case 'muted':
        return 'border-gray-600 bg-gray-700 text-gray-300 enabled:hover:bg-gray-700';
      default:
        return 'border-blue-600 bg-blue-600 text-white enabled:hover:bg-blue-700';
    }
  }

  function resolveButtonClass(nextVariant: YomitanAnkiButtonVariant) {
    return `inline-flex min-w-[120px] items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold leading-[1.2] transition-colors disabled:cursor-wait disabled:opacity-95 ${resolveVariantClass(nextVariant)}`;
  }
</script>

{#if fadeIn}
  <button
    type="button"
    class={resolveButtonClass(variant)}
    {title}
    {disabled}
    onclick={() => onSelect?.()}
    in:fade={{ duration: 180 }}
  >
    <img
      class="yomitan-anki-action__icon h-3.5 w-3.5 shrink-0"
      src="/brands/anki.svg"
      alt=""
      aria-hidden="true"
    />
    <span>{label}</span>
  </button>
{:else}
  <button
    type="button"
    class={resolveButtonClass(variant)}
    {title}
    {disabled}
    onclick={() => onSelect?.()}
  >
    <img
      class="yomitan-anki-action__icon h-3.5 w-3.5 shrink-0"
      src="/brands/anki.svg"
      alt=""
      aria-hidden="true"
    />
    <span>{label}</span>
  </button>
{/if}
