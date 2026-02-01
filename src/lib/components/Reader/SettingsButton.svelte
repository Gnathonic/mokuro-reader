<script lang="ts">
  import Settings from '$lib/components/Settings/Settings.svelte';
  import { UserSettingsSolid } from 'flowbite-svelte-icons';
  import { onMount } from 'svelte';

  interface Props {
    visible?: boolean;
  }

  let { visible = true }: Props = $props();

  let settingsOpen = $state(false);

  function openSettings() {
    console.log('[SettingsButton] Opening settings');
    settingsOpen = true;
  }

  // Close settings drawer when fullscreen changes to prevent invisible blocking overlay
  onMount(() => {
    const handleFullscreenChange = () => {
      console.log(
        '[SettingsButton] Fullscreen change detected, closing settings. Was open:',
        settingsOpen
      );
      settingsOpen = false;
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    // Custom event for iOS Safari which doesn't fire native fullscreen events
    document.addEventListener('fullscreentoggle', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('fullscreentoggle', handleFullscreenChange);
    };
  });

  // Debug: log when settingsOpen changes
  $effect(() => {
    console.log('[SettingsButton] settingsOpen changed to:', settingsOpen);
  });
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
