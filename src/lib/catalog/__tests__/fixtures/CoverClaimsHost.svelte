<script lang="ts">
  /**
   * A minimal cover-drawing surface, so `cover-claims.svelte.ts` can be exercised
   * without a real card, shelf or row in the way.
   *
   * Its whole point is {@link Props.attachGate}: every REAL surface in the app
   * remembers `use:gate`, so the mistake the dev warning exists to catch — passing
   * `targets` and forgetting the action — cannot be rendered by any of them. This
   * host can render it on purpose.
   */
  import type { VolumeMetadata } from '$lib/types';
  import { createCoverClaims } from '$lib/catalog/cover-claims.svelte';

  interface Props {
    /** Claimed and (unless {@link withTargets} is false) asked for. */
    volumes: VolumeMetadata[];
    /** False = the paint-only surface shape, `targets` omitted entirely. */
    withTargets?: boolean;
    /** False = the defect: a fetching surface whose gate is never armed. */
    attachGate?: boolean;
    /**
     * Which of two structurally distinct gated elements is rendered.
     * Flipping this between `'a'` and `'b'` (while {@link attachGate} stays
     * true) makes Svelte tear down one `use:gate` element and mount the
     * other in the same update — the `PlaceholderThumbnail` boxes-to-`<img>`
     * shape — so a test can assert the probe ends up following the new one.
     */
    gateVariant?: 'a' | 'b';
  }

  let { volumes, withTargets = true, attachGate = true, gateVariant = 'a' }: Props = $props();

  const coverClaims = createCoverClaims({
    claims: () => volumes,
    ...(withTargets ? { targets: () => volumes } : {})
  });
  const { gate } = coverClaims;
</script>

{#if attachGate}
  {#if gateVariant === 'a'}
    <div use:gate data-testid="surface" data-variant="a">{coverClaims.covers.size}</div>
  {:else}
    <div use:gate data-testid="surface" data-variant="b">{coverClaims.covers.size}</div>
  {/if}
{:else}
  <div data-testid="surface">{coverClaims.covers.size}</div>
{/if}
