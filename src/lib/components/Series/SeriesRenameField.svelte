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
    onRenamed,
    canRename = true
  }: {
    seriesTitle: string;
    seriesUuid: string;
    onRenamed: (finalTitle: string) => void;
    /** False when every volume in this series is a cloud-only placeholder: there is no
     * local row for `executeRenameSeries` to touch, so a "rename" would silently do
     * nothing (see the `renamedCount === 0` guard in `saveRename` below). */
    canRename?: boolean;
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
    if (!canRename) return;

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

      // A placeholder-only series has no local row for executeRenameSeries to touch: it
      // returns success-shaped zeros (renamedCount 0, no failures) rather than throwing.
      // Treat that as a no-op, not a success — otherwise the caller re-keys the store at
      // a title nothing was actually renamed to.
      if (result.renamedCount === 0 && result.failures.length === 0) {
        renameSaving = false;
        renameError = 'Nothing to rename';
        return;
      }

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
      // The per-volume reason ("download it first", a provider error) only ever
      // reached the console, so "rename again to retry" was the only advice the
      // user got — for failures retrying cannot fix.
      const reason = result.failures[0]?.reason ?? '';
      renameError =
        `Renamed ${result.renamedCount} volume(s), but ${result.failures.length} failed (${shown}). ` +
        (reason ? `${reason} ` : '') +
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
    } else if (event.key === 'Escape') {
      // Same as SeriesView's inline rename: Escape abandons the edit. Stop it here so it
      // doesn't also close the surrounding modal — one Escape, one undo. But only when
      // there's actually a draft to abandon: on a freshly opened (unedited) field, Escape
      // must fall through to the modal so it closes normally instead of eating the first
      // press for nothing (see `data-escape-reverts` below).
      if (!dirty) return;
      event.preventDefault();
      event.stopPropagation();
      resetRename();
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
      disabled={renameSaving || !canRename}
      aria-label="Folder name"
      data-escape-reverts={dirty ? '' : undefined}
      class="min-w-0 flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-gray-900 focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:focus:border-primary-500 dark:focus:ring-primary-500"
    />
    <!-- relative z-10: night-mode filter on <dialog> creates a stacking context -->
    <div class="relative z-10 flex items-center gap-2">
      <Button
        size="sm"
        color="primary"
        onclick={saveRename}
        disabled={renameSaving || !dirty || !canRename}
      >
        {#if renameSaving}<Spinner size="4" class="me-1" />{/if}
        Save
      </Button>
      <Button
        size="sm"
        color="alternative"
        onclick={resetRename}
        disabled={renameSaving || !dirty || !canRename}
      >
        Cancel
      </Button>
    </div>
  </div>
  {#if canRename}
    <p class="text-xs text-gray-500 dark:text-gray-400">
      This is the folder name in your library and in the cloud — renaming moves the cloud files too.
    </p>
  {:else}
    <p class="text-xs text-amber-600 dark:text-amber-400">Download a volume to rename</p>
  {/if}
  {#if renameError}
    <span class="text-sm text-red-500">{renameError}</span>
  {/if}
</div>
