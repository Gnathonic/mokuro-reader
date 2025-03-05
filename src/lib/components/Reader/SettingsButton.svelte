<script lang="ts">
  import Settings from '$lib/components/Settings/Settings.svelte';
  import { UserSettingsSolid } from 'flowbite-svelte-icons';

  let settingsHidden = $state(true);

  function openSettings() {
    settingsHidden = false;
  }
</script>

<button
  onclick={openSettings}
  class="hover:text-primary-700 hover:mix-blend-normal mix-blend-difference z-10 fixed opacity-50 hover:opacity-100 right-10 top-5 p-10 m-[-2.5rem]"
>
  <UserSettingsSolid />
</button>

<Settings bind:hidden={settingsHidden} />
