<script lang="ts">
  import { Modal, Button } from 'flowbite-svelte';
  import { ExclamationCircleSolid } from 'flowbite-svelte-icons';
  import { missingFilesModalStore } from '$lib/util/modals';

  let open = $derived($missingFilesModalStore?.open ?? false);

  function handleImportAnyway() {
    $missingFilesModalStore?.onImportAnyway?.();
    missingFilesModalStore.set(undefined);
  }

  function handleCancel() {
    $missingFilesModalStore?.onCancel?.();
    missingFilesModalStore.set(undefined);
  }
</script>

<Modal bind:open size="md" outsideclose onclose={handleCancel}>
  <div class="flex flex-col gap-4">
    <!-- Header -->
    <div class="text-center">
      <ExclamationCircleSolid class="mx-auto mb-4 h-12 w-12 text-yellow-500" />
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">Missing Image Files</h3>
    </div>

    <!-- Description -->
    <p class="text-center text-sm text-gray-600 dark:text-gray-400">
      "{$missingFilesModalStore?.info?.volumeName}" is missing {$missingFilesModalStore?.info
        ?.missingFiles?.length ?? 0} of {$missingFilesModalStore?.info?.totalPages ?? 0} images referenced
      in the mokuro file. Missing pages will show a placeholder.
    </p>

    <!-- Missing Files List -->
    <div class="max-h-48 overflow-y-auto rounded-lg border dark:border-gray-600">
      <div class="p-2 font-mono text-xs text-gray-700 dark:text-gray-300">
        {#each $missingFilesModalStore?.info?.missingFiles ?? [] as file}
          <div class="truncate py-0.5">{file}</div>
        {/each}
      </div>
    </div>

    <!-- Actions -->
    <div class="flex justify-center gap-3 pt-2">
      <Button color="yellow" onclick={handleImportAnyway}>Import Anyway</Button>
      <Button color="alternative" onclick={handleCancel}>Skip</Button>
    </div>
  </div>
</Modal>
