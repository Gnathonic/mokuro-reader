<!-- src/lib/components/Series/SeriesRenameField.svelte -->
<script lang="ts">
  /**
   * The folder-name (`series_title`) editor, lifted out of SeriesView's inline rename.
   *
   * The folder name is the cloud folder / route key / grouping key, so it changes ONLY
   * through `executeRenameSeries`, which renames each volume in the cloud first and
   * commits that volume locally only when its cloud rename succeeded — hence the
   * partial-failure branch below (some volumes keep the old name, everywhere).
   *
   * The draft is seeded from the `seriesTitle` prop at mount; the caller re-keys this
   * component when it switches to another series.
   */
  import { Button, Label, Spinner } from 'flowbite-svelte';
  import { executeRenameSeries } from '$lib/util/series-rename';

  let {
    seriesTitle,
    seriesUuid,
    onRenamed
  }: {
    seriesTitle: string;
    seriesUuid: string;
    onRenamed: (finalTitle: string) => void;
  } = $props();

  let renameValue = $state(seriesTitle);
  let renameError = $state('');
  let renameSaving = $state(false);

  let dirty = $derived(renameValue.trim() !== seriesTitle);

  function resetRename() {
    renameValue = seriesTitle;
    renameError = '';
  }

  async function saveRename() {
    const oldTitle = seriesTitle;
    const newTitle = renameValue.trim();

    if (!newTitle) {
      renameError = 'Name cannot be empty';
      return;
    }

    if (newTitle === oldTitle) {
      renameError = '';
      return;
    }

    try {
      renameSaving = true;
      renameError = '';

      // Execute the rename for this series UUID — one volume at a time; each
      // volume commits locally only after its cloud rename succeeds.
      const result = await executeRenameSeries(oldTitle, newTitle, seriesUuid);

      if (result.failures.length === 0) {
        renameSaving = false;
        onRenamed(result.finalTitle);
        return;
      }

      // Partial: the failed volumes keep the old title everywhere (cloud and
      // local stay consistent per volume). Retrying the same rename finishes
      // just the stragglers.
      const failedNames = result.failures.map((f) => f.volumeTitle);
      const shown = failedNames.slice(0, 3).join(', ') + (failedNames.length > 3 ? ', …' : '');
      renameError =
        `Renamed ${result.renamedCount} volume(s), but ${result.failures.length} failed (${shown}). ` +
        `Failed volumes keep the old name in both your library and the cloud — ` +
        `rename again to retry just those.`;
    } catch (err) {
      renameError = err instanceof Error ? err.message : 'Failed to rename';
      console.error('Error renaming series:', err);
    } finally {
      renameSaving = false;
    }
  }

  function handleRenameKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveRename();
    }
  }
</script>

<div class="flex flex-col gap-1">
  <Label class="text-xs text-gray-500 uppercase">Folder name</Label>
  <div class="flex items-center gap-2">
    <input
      type="text"
      bind:value={renameValue}
      onkeydown={handleRenameKeydown}
      disabled={renameSaving}
      aria-label="Folder name"
      class="min-w-0 flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-gray-900 focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:border-primary-500 dark:focus:ring-primary-500"
    />
    <!-- relative z-10: night-mode filter on <dialog> creates a stacking context -->
    <div class="relative z-10 flex items-center gap-2">
      <Button size="sm" color="primary" onclick={saveRename} disabled={renameSaving || !dirty}>
        {#if renameSaving}<Spinner size="4" class="me-1" />{/if}
        Save
      </Button>
      <Button size="sm" color="alternative" onclick={resetRename} disabled={renameSaving || !dirty}>
        Cancel
      </Button>
    </div>
  </div>
  <p class="text-xs text-gray-500 dark:text-gray-400">
    This is the folder name in your library and in the cloud — renaming moves the cloud files too.
  </p>
  {#if renameError}
    <span class="text-sm text-red-500">{renameError}</span>
  {/if}
</div>
