<script lang="ts">
  import { confirmationPopupStore } from '$lib/util';
  import { Button, Modal } from 'flowbite-svelte';
  import { ExclamationCircleOutline } from 'flowbite-svelte-icons';
  import { onMount } from 'svelte';

  let open = $state(false);

  onMount(() => {
    confirmationPopupStore.subscribe((value) => {
      if (value) {
        open = value.open;
      }
    });
  });
</script>

<Modal bind:open size="xs" autoclose outsideclose>
  <div class="text-center">
    <ExclamationCircleOutline class="mx-auto mb-4 text-gray-400 w-12 h-12 dark:text-gray-200" />
    <h3 class="mb-5 text-lg font-normal text-gray-500 dark:text-gray-400">
      {$confirmationPopupStore?.message}
    </h3>
    <Button color="red" class="mr-2" on:click={$confirmationPopupStore?.onConfirm}>Yes</Button>
    <Button color="alternative" on:click={$confirmationPopupStore?.onCancel}>No</Button>
  </div>
</Modal>
