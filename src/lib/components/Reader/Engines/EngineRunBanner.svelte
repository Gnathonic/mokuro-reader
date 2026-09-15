<script lang="ts">
  /** The in-flight engine run: progress plus the Cancel button (the progress
   * tracker store has no cancel affordance of its own). */
  import { activeEngineRun } from '$lib/engines/engine-runs';
  import { CloseOutline } from 'flowbite-svelte-icons';

  const label = { ocr: 'OCR', translate: 'Translating' } as const;
</script>

{#if $activeEngineRun}
  <div
    role="status"
    class="fixed bottom-3 left-3 z-50 flex items-center gap-3 rounded-full bg-gray-900/90 px-4 py-2 text-sm text-gray-100 shadow-lg"
  >
    <span>{label[$activeEngineRun.kind]} {$activeEngineRun.done} / {$activeEngineRun.total}</span>
    <button
      class="rounded-full p-1 hover:bg-gray-700"
      aria-label="Cancel engine run"
      title="Cancel"
      onclick={() => $activeEngineRun?.cancel()}><CloseOutline size="sm" /></button
    >
  </div>
{/if}
