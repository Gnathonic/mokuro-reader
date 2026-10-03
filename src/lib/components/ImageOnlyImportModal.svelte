<script lang="ts">
  import { Modal, Button } from 'flowbite-svelte';
  import { InfoCircleSolid } from 'flowbite-svelte-icons';
  import { imageOnlyImportModalStore } from '$lib/util/modals';
  import { miscSettings, updateMiscSetting } from '$lib/settings/misc';

  /** Volume names shown per series before "and N more". */
  const PREVIEW_VOLUMES = 4;

  let open = $derived($imageOnlyImportModalStore?.open ?? false);
  let naming = $derived($imageOnlyImportModalStore?.naming);

  // The naming mode being previewed (#285). Starts from the saved choice each
  // time the prompt opens; saved again only when the user imports with it.
  let keepFolderNames = $state(false);
  $effect(() => {
    if (open) keepFolderNames = $miscSettings.keepFolderNamesAsTitles === true;
  });

  let seriesList = $derived(
    naming
      ? keepFolderNames
        ? naming.folder
        : naming.cleaned
      : ($imageOnlyImportModalStore?.seriesList ?? [])
  );

  function handleConfirm() {
    if (naming) updateMiscSetting('keepFolderNamesAsTitles', keepFolderNames);
    $imageOnlyImportModalStore?.onConfirm?.();
    imageOnlyImportModalStore.set(undefined);
  }

  function handleCancel() {
    $imageOnlyImportModalStore?.onCancel?.();
    imageOnlyImportModalStore.set(undefined);
  }
</script>

<Modal bind:open size="md" outsideclose onclose={handleCancel}>
  <div class="flex flex-col gap-4">
    <!-- Header -->
    <div class="text-center">
      <InfoCircleSolid class="mx-auto mb-4 h-12 w-12 text-blue-500" />
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">Image-Only Import</h3>
    </div>

    <!-- Description -->
    <p class="text-center text-sm text-gray-600 dark:text-gray-400">
      Found {$imageOnlyImportModalStore?.totalVolumes ?? 0} volume(s) in {seriesList.length} series without
      .mokuro files. These will be imported as image-only volumes (no OCR text).
    </p>

    {#if naming}
      <!-- Naming mode -->
      <div class="flex flex-col items-center gap-1">
        <div
          class="inline-flex rounded-lg border border-gray-200 p-0.5 dark:border-gray-600"
          role="radiogroup"
          aria-label="Volume names"
        >
          <button
            type="button"
            role="radio"
            aria-checked={!keepFolderNames}
            class="rounded-md px-3 py-1 text-sm {!keepFolderNames
              ? 'bg-blue-600 text-white'
              : 'text-gray-700 dark:text-gray-300'}"
            onclick={() => (keepFolderNames = false)}
          >
            Cleaned up
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={keepFolderNames}
            class="rounded-md px-3 py-1 text-sm {keepFolderNames
              ? 'bg-blue-600 text-white'
              : 'text-gray-700 dark:text-gray-300'}"
            onclick={() => (keepFolderNames = true)}
          >
            Folder names
          </button>
        </div>
        <p class="text-center text-xs text-gray-500 dark:text-gray-400">
          {#if keepFolderNames}
            Names as written, with the series folder in front of each volume.
          {:else}
            Tidied names, guessed from the folder and file names.
          {/if}
        </p>
      </div>
    {/if}

    <!-- Series List -->
    <div class="max-h-72 overflow-y-auto rounded-lg border dark:border-gray-600">
      <table class="w-full text-sm">
        <thead class="sticky top-0 bg-gray-50 dark:bg-gray-700">
          <tr>
            <th class="px-4 py-2 text-left font-medium text-gray-700 dark:text-gray-300">Series</th>
            <th class="px-4 py-2 text-right font-medium text-gray-700 dark:text-gray-300"
              >Volumes</th
            >
          </tr>
        </thead>
        <tbody class="divide-y dark:divide-gray-600">
          {#each seriesList as series (series.seriesName)}
            <tr class="hover:bg-gray-50 dark:hover:bg-gray-700">
              <td class="px-4 py-2 text-gray-900 dark:text-gray-100">
                <div>{series.seriesName}</div>
                {#if series.volumeNames?.length}
                  <ul class="mt-1 text-xs text-gray-500 dark:text-gray-400" data-volume-names>
                    {#each series.volumeNames.slice(0, PREVIEW_VOLUMES) as volumeName, i (i)}
                      <li class="break-all">{volumeName}</li>
                    {/each}
                    {#if series.volumeNames.length > PREVIEW_VOLUMES}
                      <li>and {series.volumeNames.length - PREVIEW_VOLUMES} more</li>
                    {/if}
                  </ul>
                {/if}
              </td>
              <td class="px-4 py-2 text-right align-top text-gray-600 dark:text-gray-400"
                >{series.volumeCount}</td
              >
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Actions -->
    <div class="relative z-10 flex justify-center gap-3 pt-2">
      <Button color="blue" onclick={handleConfirm}>Import</Button>
      <Button color="alternative" onclick={handleCancel}>Skip</Button>
    </div>
  </div>
</Modal>
