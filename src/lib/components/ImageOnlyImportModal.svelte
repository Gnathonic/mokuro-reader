<script lang="ts">
  import { Modal, Button } from 'flowbite-svelte';
  import { InfoCircleSolid } from 'flowbite-svelte-icons';
  import { imageOnlyImportModalStore } from '$lib/util/modals';

  let open = $derived($imageOnlyImportModalStore?.open ?? false);

  function handleConfirm() {
    $imageOnlyImportModalStore?.onConfirm?.();
    imageOnlyImportModalStore.set(undefined);
  }

  function handleCancel() {
    $imageOnlyImportModalStore?.onCancel?.();
    imageOnlyImportModalStore.set(undefined);
  }
</script>

<Modal bind:open size="md" outsideclose on:close={handleCancel}>
  <div class="flex flex-col gap-4">
    <!-- Header -->
    <div class="text-center">
      <InfoCircleSolid class="mx-auto mb-4 text-blue-500 w-12 h-12" />
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">Image-Only Import</h3>
    </div>

    <!-- Description -->
    <p class="text-sm text-gray-600 dark:text-gray-400 text-center">
      Found {$imageOnlyImportModalStore?.totalVolumes ?? 0} volume(s) in {$imageOnlyImportModalStore
        ?.seriesList?.length ?? 0} series without .mokuro files. These will be imported as image-only
      volumes (no OCR text).
    </p>

    <!-- Series List -->
    <div class="border rounded-lg dark:border-gray-600 max-h-64 overflow-y-auto">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-700 sticky top-0">
          <tr>
            <th class="px-4 py-2 text-left font-medium text-gray-700 dark:text-gray-300">Series</th>
            <th class="px-4 py-2 text-right font-medium text-gray-700 dark:text-gray-300"
              >Volumes</th
            >
          </tr>
        </thead>
        <tbody class="divide-y dark:divide-gray-600">
          {#each $imageOnlyImportModalStore?.seriesList ?? [] as series}
            <tr class="hover:bg-gray-50 dark:hover:bg-gray-700">
              <td class="px-4 py-2 text-gray-900 dark:text-gray-100">{series.seriesName}</td>
              <td class="px-4 py-2 text-right text-gray-600 dark:text-gray-400"
                >{series.volumeCount}</td
              >
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Actions -->
    <div class="flex justify-center gap-3 pt-2">
      <Button color="blue" on:click={handleConfirm}>Import</Button>
      <Button color="alternative" on:click={handleCancel}>Cancel</Button>
    </div>
  </div>
</Modal>
