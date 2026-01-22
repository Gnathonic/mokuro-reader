<script lang="ts">
  import Settings from '$lib/components/Settings/Settings.svelte';
  import { UserSettingsSolid } from 'flowbite-svelte-icons';

  interface Props {
    visible?: boolean;
  }

  let { visible = true }: Props = $props();

  let settingsOpen = $state(false);

  function openSettings() {
    settingsOpen = true;
  }
</script>

{#if visible}
  <button
    onclick={openSettings}
    class="fixed top-3 right-3 z-10 p-2 opacity-50 mix-blend-difference hover:text-primary-700 hover:opacity-100 hover:mix-blend-normal"
  >
    <UserSettingsSolid size="xl" />
  </button>
{/if}

<Settings bind:open={settingsOpen} />
