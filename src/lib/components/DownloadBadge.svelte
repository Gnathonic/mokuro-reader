<script lang="ts">
  /**
   * The "this volume's pages are not on the device" mark.
   *
   * One badge for BOTH absent states (metadata-only rows and cloud-only
   * placeholders — see `$lib/catalog/volume-state`), so the two read
   * identically wherever a volume is drawn: the volume list, the volume grid,
   * a spine on the shelf, a catalog card whose whole series is absent.
   *
   * A pure overlay: absolutely positioned in its nearest positioned ancestor
   * and `pointer-events-none`, so it can never take a click from the card it
   * sits on and can never move the geometry it sits over (the spine shelf and
   * the catalog stack are measured, not laid out).
   */
  import { DownloadSolid } from 'flowbite-svelte-icons';

  interface Props {
    /** Corner placement (and any other positioning utilities). */
    class?: string;
    /** Absolute placement in px, for canvas-drawn surfaces like the spine shelf. */
    style?: string;
    /** `sm` for 50×70 covers, `spine` for a spine in a stack, `md` for full-size covers. */
    size?: 'sm' | 'spine' | 'md';
    /**
     * Screen-reader name for the mark. Pass it ONLY where the badge is the sole cue —
     * a catalog card. A volume row already spells "Not on this device" out in a text
     * badge beside it, and a second announcement of the same fact is noise.
     */
    label?: string;
  }

  let {
    class: className = 'right-1 bottom-1',
    style = undefined,
    size = 'md',
    label = undefined
  }: Props = $props();
</script>

<div
  data-testid="download-badge"
  aria-hidden={label ? undefined : 'true'}
  {style}
  class="pointer-events-none absolute z-10 flex items-center justify-center rounded-full bg-gray-900/80 ring-1 ring-white/80 {size ===
  'sm'
    ? 'h-4 w-4'
    : size === 'spine'
      ? 'h-5 w-5'
      : 'h-6 w-6'} {className}"
>
  <DownloadSolid
    class="{size === 'sm'
      ? 'h-2.5 w-2.5'
      : size === 'spine'
        ? 'h-3 w-3'
        : 'h-3.5 w-3.5'} text-blue-300"
  />
  {#if label}<span class="sr-only">{label}</span>{/if}
</div>
