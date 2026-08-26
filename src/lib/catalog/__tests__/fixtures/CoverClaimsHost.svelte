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
  }

  let { volumes, withTargets = true, attachGate = true }: Props = $props();

  const coverClaims = createCoverClaims({
    claims: () => volumes,
    ...(withTargets ? { targets: () => volumes } : {})
  });
  const { gate } = coverClaims;
</script>

{#if attachGate}
  <div use:gate data-testid="surface">{coverClaims.covers.size}</div>
{:else}
  <div data-testid="surface">{coverClaims.covers.size}</div>
{/if}
