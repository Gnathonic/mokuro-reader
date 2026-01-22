<script lang="ts">
  import { Modal, Button, AccordionItem, Accordion } from 'flowbite-svelte';
  import { ExclamationCircleSolid } from 'flowbite-svelte-icons';
  import { importMismatchModalStore, type ImportMismatchInfo } from '$lib/util/modals';

  let open = $derived($importMismatchModalStore?.open ?? false);
  let volumes = $derived($importMismatchModalStore?.volumes ?? []);
  let isSingleVolume = $derived(volumes.length === 1);
  let firstVolume = $derived(volumes[0]);

  // For single volume, determine which list to show
  // Show whichever list is shorter (more useful for debugging)
  // If one is empty, show the other
  function shouldShowMissing(vol: ImportMismatchInfo): boolean {
    const missingLen = vol.missingFiles?.length ?? 0;
    const extraLen = vol.extraFiles?.length ?? 0;
    if (missingLen === 0) return false;
    if (extraLen === 0) return true; // Only missing has items, show it
    return missingLen <= extraLen; // Both have items, show shorter (missing if equal)
  }

  function shouldShowExtra(vol: ImportMismatchInfo): boolean {
    const missingLen = vol.missingFiles?.length ?? 0;
    const extraLen = vol.extraFiles?.length ?? 0;
    if (extraLen === 0) return false;
    if (missingLen === 0) return true; // Only extra has items, show it
    return extraLen < missingLen; // Both have items, show shorter
  }

  function handleDismiss() {
    $importMismatchModalStore?.onDismiss?.();
    importMismatchModalStore.set(undefined);
  }
</script>

<Modal bind:open size="xl" outsideclose onclose={handleDismiss}>
  <div class="flex flex-col gap-4">
    <!-- Header -->
    <div class="text-center">
      <ExclamationCircleSolid class="mx-auto mb-4 h-12 w-12 text-red-500" />
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">
        {isSingleVolume ? 'Import Failed' : `${volumes.length} Import(s) Failed`}
      </h3>
    </div>

    <!-- Single volume view -->
    {#if isSingleVolume && firstVolume}
      <div class="text-center text-sm text-gray-600 dark:text-gray-400">
        <p class="font-medium text-gray-900 dark:text-white">{firstVolume.volumeName}</p>
        <p class="mt-2">
          Expected {firstVolume.expectedCount} files, but found {firstVolume.actualCount}.
        </p>
      </div>

      <!-- Missing files list -->
      {#if shouldShowMissing(firstVolume)}
        <div class="rounded-lg border border-red-200 dark:border-red-800">
          <div class="bg-red-50 px-4 py-2 dark:bg-red-900/30">
            <h4 class="text-sm font-medium text-red-800 dark:text-red-200">
              Files expected but not found ({firstVolume.missingFiles?.length ?? 0})
            </h4>
          </div>
          <div class="max-h-[60vh] overflow-y-auto p-2">
            <ul class="space-y-1 font-mono text-xs text-gray-700 dark:text-gray-300">
              {#each firstVolume.missingFiles ?? [] as file}
                <li class="truncate px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-700" title={file}>
                  {file}
                </li>
              {/each}
            </ul>
          </div>
        </div>
      {/if}

      <!-- Extra files list -->
      {#if shouldShowExtra(firstVolume)}
        <div class="rounded-lg border border-yellow-200 dark:border-yellow-800">
          <div class="bg-yellow-50 px-4 py-2 dark:bg-yellow-900/30">
            <h4 class="text-sm font-medium text-yellow-800 dark:text-yellow-200">
              Files downloaded but not in mokuro ({firstVolume.extraFiles?.length ?? 0})
            </h4>
          </div>
          <div class="max-h-[60vh] overflow-y-auto p-2">
            <ul class="space-y-1 font-mono text-xs text-gray-700 dark:text-gray-300">
              {#each firstVolume.extraFiles ?? [] as file}
                <li class="truncate px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-700" title={file}>
                  {file}
                </li>
              {/each}
            </ul>
          </div>
        </div>
      {/if}

      <!-- Multiple volumes view -->
    {:else}
      <p class="text-center text-sm text-gray-600 dark:text-gray-400">
        The following volumes could not be imported due to file mismatches.
      </p>

      <div class="max-h-[60vh] overflow-y-auto">
        <Accordion>
          {#each volumes as vol}
            <AccordionItem>
              {#snippet header()}
                <span class="flex items-center gap-2">
                  <span class="font-medium">{vol.volumeName}</span>
                  <span class="text-xs text-gray-500">
                    (expected {vol.expectedCount}, got {vol.actualCount})
                  </span>
                </span>
              {/snippet}
              <div class="space-y-2 text-sm">
                {#if (vol.missingFiles?.length ?? 0) > 0}
                  <div>
                    <p class="font-medium text-red-600 dark:text-red-400">
                      Missing ({vol.missingFiles.length}):
                    </p>
                    <ul class="ml-4 max-h-32 overflow-y-auto font-mono text-xs">
                      {#each vol.missingFiles as file}
                        <li class="truncate" title={file}>{file}</li>
                      {/each}
                    </ul>
                  </div>
                {/if}
                {#if (vol.extraFiles?.length ?? 0) > 0}
                  <div>
                    <p class="font-medium text-yellow-600 dark:text-yellow-400">
                      Extra ({vol.extraFiles.length}):
                    </p>
                    <ul class="ml-4 max-h-32 overflow-y-auto font-mono text-xs">
                      {#each vol.extraFiles as file}
                        <li class="truncate" title={file}>{file}</li>
                      {/each}
                    </ul>
                  </div>
                {/if}
              </div>
            </AccordionItem>
          {/each}
        </Accordion>
      </div>
    {/if}

    <!-- Actions -->
    <div class="flex justify-center pt-2">
      <Button color="blue" onclick={handleDismiss}>OK</Button>
    </div>
  </div>
</Modal>
