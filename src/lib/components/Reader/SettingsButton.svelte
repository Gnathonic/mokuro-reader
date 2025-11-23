<script lang="ts">
  import Settings from '$lib/components/Settings/Settings.svelte';
  import { UserSettingsSolid } from 'flowbite-svelte-icons';

  let settingsOpen = $state(false);

  function openSettings() {
    settingsOpen = true;
  }
</script>

<button
  onclick={openSettings}
  class="fixed top-5 right-10 z-10 p-2 opacity-50 mix-blend-difference hover:text-primary-700 hover:opacity-100 hover:mix-blend-normal"
>
  <UserSettingsSolid size="xl" />
</button>

<Settings bind:open={settingsOpen} />
