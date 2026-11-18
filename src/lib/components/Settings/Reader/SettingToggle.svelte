<script lang="ts">
  import { Toggle } from 'flowbite-svelte';
  import { settings, updateSetting, type SettingsKey } from '#lib/settings/index.js';

  /**
   * One boolean profile setting as a toggle, with an optional hotkey hint and
   * a one-line description under it — the row every reader section uses.
   */
  interface Props {
    key: SettingsKey;
    text: string;
    shortcut?: string;
    description?: string;
  }

  let { key, text, shortcut, description }: Props = $props();

  let value = $derived(!!$settings[key]);
</script>

<div>
  <Toggle size="small" checked={value} onchange={() => updateSetting(key, !value)}>
    {text}
    {#if shortcut}
      <span class="ml-2 text-xs text-gray-500 dark:text-gray-400">({shortcut})</span>
    {/if}
  </Toggle>
  {#if description}
    <p class="mt-0.5 ml-11 text-xs text-gray-500 dark:text-gray-400">{description}</p>
  {/if}
</div>
