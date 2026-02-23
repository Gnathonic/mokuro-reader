<script lang="ts">
  import type { Summary, TermDictionaryEntry } from 'yomitan-core';
  import {
    createTermEntryRenderer,
    type YomitanRenderedTermEntry,
    type YomitanRenderHostOptions,
    type YomitanPopupTheme,
    type YomitanTermEntryRenderer
  } from '$lib/yomitan/core';
  import {
    resolveAnkiButtonUiState,
    type YomitanAnkiButtonUiState
  } from '$lib/yomitan/anki-button-ui';
  import YomitanAnkiActionButton from './YomitanAnkiActionButton.svelte';

  interface Props {
    entries: TermDictionaryEntry[];
    dictionaryInfo: Summary[];
    theme?: YomitanPopupTheme;
    language?: string;
    glossaryLayoutMode?: string;
    resultOutputMode?: string;
    ankiEnabled?: boolean;
    ankiButtonStates?: YomitanAnkiButtonUiState[];
    ankiButtonChecked?: boolean[];
    ankiButtonFadeIn?: boolean[];
    onAddToAnki?: (entryIndex: number) => void;
  }

  let {
    entries,
    dictionaryInfo,
    theme = 'dark',
    language,
    glossaryLayoutMode,
    resultOutputMode,
    ankiEnabled = false,
    ankiButtonStates = [],
    ankiButtonChecked = [],
    ankiButtonFadeIn = [],
    onAddToAnki
  }: Props = $props();

  let mountNode: HTMLDivElement | null = $state(null);
  let termEntryRenderer: YomitanTermEntryRenderer | null = $state(null);
  let renderedEntries = $state<YomitanRenderedTermEntry[]>([]);

  function buildRenderOptions(): YomitanRenderHostOptions {
    return {
      theme,
      language,
      glossaryLayoutMode,
      resultOutputMode
    };
  }

  function mountEntryNode(node: HTMLElement, entryNode: HTMLElement) {
    node.replaceChildren(entryNode);

    return {
      update(nextEntryNode: HTMLElement) {
        if (nextEntryNode === entryNode) return;
        entryNode = nextEntryNode;
        node.replaceChildren(nextEntryNode);
      },
      destroy() {
        node.replaceChildren();
      }
    };
  }

  $effect(() => {
    if (!mountNode) return;

    const renderer = createTermEntryRenderer();
    termEntryRenderer = renderer;
    renderer.prepareHost(mountNode, buildRenderOptions());

    return () => {
      renderedEntries = [];
      renderer.destroy();
      termEntryRenderer = null;
    };
  });

  $effect(() => {
    if (!mountNode || !termEntryRenderer) return;

    const options = buildRenderOptions();
    termEntryRenderer.updateHost(mountNode, options);
    renderedEntries = termEntryRenderer.renderTermEntries(entries, dictionaryInfo, options);
  });
</script>

<div
  bind:this={mountNode}
  class="h-full min-h-0 overflow-x-hidden overflow-y-auto"
  data-testid="yomitan-results"
>
  <div class="flex flex-col gap-2.5 p-2.5">
    {#each renderedEntries as renderedEntry (renderedEntry.index)}
      {@const entryIndex = renderedEntry.index}
      {@const state = ankiButtonStates[entryIndex]?.state ?? 'ready'}
      {@const ui = resolveAnkiButtonUiState(state)}
      <div class="relative pt-8">
        {#if ankiEnabled && ankiButtonChecked[entryIndex]}
          <div class="absolute top-1.5 right-1.5 z-[8]">
            <YomitanAnkiActionButton
              label={ankiButtonStates[entryIndex]?.label ?? ui.label}
              title={ankiButtonStates[entryIndex]?.title ?? ui.title}
              disabled={ankiButtonStates[entryIndex]?.disabled ?? ui.disabled}
              variant={ui.variant}
              fadeIn={Boolean(ankiButtonFadeIn[entryIndex])}
              onSelect={() => {
                onAddToAnki?.(entryIndex);
              }}
            />
          </div>
        {/if}

        <div use:mountEntryNode={renderedEntry.entryNode}></div>
      </div>
    {/each}
  </div>
</div>
