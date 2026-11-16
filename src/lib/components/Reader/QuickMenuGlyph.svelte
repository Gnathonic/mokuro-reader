<script lang="ts">
  import type { IconName } from '#lib/keys/icon-names.js';
  import { actionIcon } from '#lib/keys/icons.js';

  /**
   * A quick-menu entry's glyph: its icon and its badge (#55). The ONE
   * component that draws it — the quick menu's buttons and the settings
   * section's rows both render this, from `menuGlyph` (`quick-menu.ts`), so
   * the section can never show another icon than the menu gives.
   *
   * It draws no face of its own: the badge sits on the corner of the nearest
   * positioned ancestor, the round button on the menu and its miniature in
   * the section, so both carry it in the same place.
   */
  interface Props {
    icon: IconName;
    badge?: string;
    /** `menu`: the reader's 48 px button. `row`: the settings section's miniature. */
    size?: 'menu' | 'row';
  }

  let { icon, badge, size = 'menu' }: Props = $props();

  let Icon = $derived(actionIcon(icon));
</script>

<span class="contents" data-menu-glyph={icon} data-menu-glyph-badge={badge}>
  {#if size === 'menu'}
    <Icon size="xl" aria-hidden="true" />
  {:else}
    <Icon class="h-4 w-4 shrink-0" aria-hidden="true" />
  {/if}
  {#if badge}
    <span
      class="absolute flex items-center justify-center rounded-full bg-primary-600 leading-none text-white {size ===
      'menu'
        ? '-top-1 -right-1 h-5 min-w-5 px-1 text-xs'
        : '-top-1 -right-1.5 h-3.5 min-w-3.5 px-0.5 text-[9px]'}"
      data-quick-action-badge>{badge}</span
    >
  {/if}
</span>
