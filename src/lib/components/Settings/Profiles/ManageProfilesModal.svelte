<script lang="ts">
  import { preventDefault } from 'svelte/legacy';

  import {
    copyProfile,
    createProfile,
    deleteProfile,
    profiles,
    renameProfile
  } from '$lib/settings';
  import { promptConfirmation, showSnackbar } from '$lib/util';
  import { Input, Listgroup, ListgroupItem, Modal } from 'flowbite-svelte';
  import {
    CirclePlusSolid,
    EditOutline,
    FileCopySolid,
    TrashBinSolid,
    UserEditSolid
  } from 'flowbite-svelte-icons';
  import type { ListGroupItemType } from 'flowbite-svelte/dist/types';

  interface Props {
    open?: boolean;
  }

  let { open = $bindable(false) }: Props = $props();

  let items = $derived(Object.keys($profiles));

  let newProfile: string = $state();

  function onSubmit() {
    if (!newProfile) {
      showSnackbar('Profile name cannot be empty');
      return;
    }

    if (items.includes(newProfile)) {
      showSnackbar('Profile already exists');
      return;
    }

    createProfile(newProfile);
    newProfile = '';
  }

  function onCopy(item: string | ListGroupItemType) {
    let newCopy = `${item} copy`;

    while (items.includes(newCopy)) {
      newCopy += ` copy`;
    }

    copyProfile(item as string, newCopy);
  }

  function onDelete(item: string | ListGroupItemType) {
    promptConfirmation(`Are you sure you would like to delete the [${item}] profile?`, () => {
      deleteProfile(item as string);
    });
  }

  let profileToEdit: string | ListGroupItemType = $state();
  let newName: string | ListGroupItemType = $state();

  function onEditClicked(item: string | ListGroupItemType) {
    if (profileToEdit) {
      profileToEdit = '';
    } else {
      newName = item;
      profileToEdit = item;
    }
  }

  function onEdit() {
    if (items.includes(newName as string)) {
      showSnackbar('Profile already exists');
      return;
    }

    renameProfile(profileToEdit as string, newName as string);
  }

  function onInputClick(this: any) {
    this.select();
  }
</script>

<Modal size="xs" bind:open outsideclose>
  <Listgroup {items}>
    {#snippet children({ item })}
      <ListgroupItem class="flex flex-row justify-between gap-6">
        <div class="flex-1">
          {#if profileToEdit === item}
            <form onsubmit={preventDefault(onEdit)}>
              <Input size="sm" bind:value={newName} autofocus on:click={onInputClick}>
                {#snippet right()}
                  <EditOutline size="sm" on:click={onEdit} class="hover:text-primary-700" />
                {/snippet}
              </Input>
            </form>
          {:else}
            <p class="line-clamp-1">{item}</p>
          {/if}
        </div>
        <div class="flex flex-row gap-2 items-center">
          <FileCopySolid size="sm" class="hover:text-primary-700" on:click={() => onCopy(item)} />
          {#if item !== 'Default'}
            <UserEditSolid
              size="sm"
              class="hover:text-primary-700"
              on:click={() => onEditClicked(item)}
            />
            <TrashBinSolid
              size="sm"
              class="hover:text-primary-700"
              on:click={() => onDelete(item)}
            />
          {/if}
        </div>
      </ListgroupItem>
    {/snippet}
  </Listgroup>
  <form onsubmit={preventDefault(onSubmit)}>
    <Input type="text" placeholder="New profile..." bind:value={newProfile}>
      {#snippet right()}
        <CirclePlusSolid class="hover:text-primary-700" on:click={onSubmit} />
      {/snippet}
    </Input>
  </form>
</Modal>
