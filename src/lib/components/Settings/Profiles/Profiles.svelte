<script lang="ts">
  import { changeProfile, currentProfile, profiles, migrateProfiles } from '$lib/settings';
  import { AccordionItem, Button, Select } from 'flowbite-svelte';
  import ManageProfilesModal from './ManageProfilesModal.svelte';
  import { showSnackbar } from '$lib/util';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let items = $derived(
    Object.keys($profiles).map((id) => {
      return { value: id, name: id };
    })
  );

  let profile = $state($currentProfile);

  function onChange() {
    changeProfile(profile);
    onClose();
  }

  function exportProfiles() {
    const link = document.createElement('a');
    const json = localStorage.getItem('profiles') || '';
    link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    link.download = 'profiles.json';
    link.click();
    showSnackbar('Profiles exported');
  }

  let files: FileList = $state();
  function importProfile() {
    const [file] = files;
    const reader = new FileReader();

    reader.onloadend = () => {
      const imported = JSON.parse(reader.result?.toString() || '');
      // Migrate imported profiles to ensure all fields exist with defaults
      const migrated = migrateProfiles(imported);
      profiles.update((prev) => {
        return {
          ...prev,
          ...migrated
        };
      });
      onClose();
      showSnackbar('Profiles imported');
    };

    if (file) {
      reader.readAsText(file);
    }
  }

  let manageModalOpen = $state(false);
</script>

<ManageProfilesModal bind:open={manageModalOpen} />

<AccordionItem>
  {#snippet header()}
    <span>Profile</span>
  {/snippet}
  <div class="flex flex-col gap-5">
    <div class="flex flex-col gap-2">
      <Select {items} bind:value={profile} on:change={onChange} placeholder="Select profile ..." />
      <Button size="sm" outline color="dark" on:click={() => (manageModalOpen = true)}
        >Manage profiles</Button
      >
    </div>
    <hr class="border-gray-100 opacity-10" />
    <div class="flex flex-col gap-2">
      <input class="border border-slate-700 rounded-lg" type="file" accept=".json" bind:files />
      <Button on:click={importProfile} disabled={!files} size="sm" outline color="blue"
        >Import profiles</Button
      >
      <Button on:click={exportProfiles} size="sm" color="light">Export profiles</Button>
    </div>
  </div>
</AccordionItem>
