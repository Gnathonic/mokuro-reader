<script lang="ts">
  import SettingsDrawerHost from '$lib/components/Settings/SettingsDrawerHost.svelte';
  import { openSettings } from '$lib/settings/settings-open';
  import { UserSettingsSolid } from 'flowbite-svelte-icons';

  interface Props {
    visible?: boolean;
  }

  let { visible = true }: Props = $props();
</script>

{#if visible}
  <button
    onclick={openSettings}
    class="reader-hud fixed top-3 right-3 z-10 p-2 opacity-80 hover:text-primary-600 hover:opacity-100"
  >
    <UserSettingsSolid size="xl" />
  </button>
{/if}

<SettingsDrawerHost context="reader" />
