<script lang="ts">
  import { Button, Drawer } from 'flowbite-svelte';
  import { BookOpenSolid } from 'flowbite-svelte-icons';
  import { sineIn } from 'svelte/easing';
  import type { TermDictionaryEntry } from 'yomitan-core';
  import type { VolumeMetadata } from '$lib/anki-connect';
  import {
    buildEnabledDictionaryMap,
    getInstalledDictionaries,
    lookupTerm,
    tokenizeText,
    type YomitanDictionarySummary,
    type YomitanToken
  } from '$lib/yomitan/core';
  import type { YomitanAnkiButtonUiState } from '$lib/yomitan/anki-button-ui';
  import {
    buildYomitanDebugSnapshot,
    copyTextToClipboard,
    getCodePointPreview,
    isYomitanDebugEnabled,
    logYomitanDebug
  } from '$lib/yomitan/debug';
  import {
    loadDictionaryPreferences,
    normalizeDictionaryPreferences,
    saveDictionaryPreferences
  } from '$lib/yomitan/preferences';
  import { addPopupAnkiNote, getPopupAnkiButtonStates } from '$lib/yomitan/anki-note';
  import { showSnackbar } from '$lib/util/snackbar';
  import YomitanResults from './YomitanResults.svelte';

  interface Props {
    open?: boolean;
    sourceText?: string;
    ankiEnabled?: boolean;
    volumeMetadata?: VolumeMetadata;
    onClose?: () => void;
    outsideClose?: boolean;
    allowSwipeClose?: boolean;
  }

  let {
    open = $bindable(false),
    sourceText = '',
    ankiEnabled = false,
    volumeMetadata,
    onClose,
    outsideClose = true,
    allowSwipeClose: _allowSwipeClose = true
  }: Props = $props();

  let dictionaries = $state<YomitanDictionarySummary[]>([]);
  let tokens = $state<YomitanToken[]>([]);
  let selectedTokenIndex = $state<number | null>(null);
  let loading = $state(false);
  let lookupLoading = $state(false);
  let errorMessage = $state('');
  let noEntries = $state(false);
  let selectionMessage = $state('');
  let lookupEntries = $state<TermDictionaryEntry[]>([]);
  let selectedTokenText = $state('');
  let ankiButtonStates = $state<YomitanAnkiButtonUiState[]>([]);
  let ankiButtonChecked = $state<boolean[]>([]);
  let ankiButtonFadeIn = $state<boolean[]>([]);
  let lookupRequestId = $state(0);
  let ankiPrecheckWarningShown = $state(false);
  let drawerPanel: HTMLElement | null = $state(null);
  let debugEnabled = $state(false);
  let addingToAnki = $derived(ankiButtonStates.some((state) => state.state === 'adding'));

  const transitionParams = {
    y: 320,
    duration: 200,
    easing: sineIn
  };

  function debugYomitan(message: string, details?: Record<string, unknown>) {
    logYomitanDebug('drawer', message, details);
  }

  async function copyDebugSnapshot() {
    try {
      const snapshot = buildYomitanDebugSnapshot({
        drawer: {
          open,
          loading,
          lookupLoading,
          tokenCount: tokens.length,
          selectableCount: tokens.filter((token) => token.selectable).length,
          selectedTokenIndex,
          lookupEntryCount: lookupEntries.length,
          noEntries,
          errorMessage,
          sourceTextLength: sourceText.length,
          sourceTextPreview: sourceText.slice(0, 120),
          sourceTextCodePoints: getCodePointPreview(sourceText),
          dictionaryCount: dictionaries.length,
          dictionaryTitles: dictionaries.map((item) => item.title)
        }
      });

      await copyTextToClipboard(snapshot);
      showSnackbar('Copied Yomitan debug snapshot.');
    } catch (error) {
      console.error('Failed to copy Yomitan debug snapshot:', error);
      showSnackbar('Failed to copy Yomitan debug snapshot.');
    }
  }

  function closeDrawer() {
    open = false;
  }

  function handleBackdropMousedown(event: MouseEvent & { currentTarget: HTMLDialogElement }) {
    if (!outsideClose) return;
    if (event.target !== event.currentTarget) return;
    if (!drawerPanel) return;

    const rect = drawerPanel.getBoundingClientRect();
    const clickedInContent =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;

    if (!clickedInContent) {
      closeDrawer();
    }
  }

  function resetDrawerState() {
    dictionaries = [];
    tokens = [];
    selectedTokenIndex = null;
    errorMessage = '';
    noEntries = false;
    selectionMessage = '';
    loading = false;
    lookupLoading = false;
    lookupEntries = [];
    selectedTokenText = '';
    ankiButtonStates = [];
    ankiButtonChecked = [];
    ankiButtonFadeIn = [];
    lookupRequestId = 0;
    ankiPrecheckWarningShown = false;
  }

  async function handleAddToAnki(entryIndex: number) {
    if (!ankiEnabled) {
      showSnackbar('Enable Anki integration in settings first.');
      return;
    }

    const entry = lookupEntries[entryIndex];
    if (!entry) return;

    await updateAnkiButtonState(entryIndex, { state: 'adding' });
    try {
      const source = selectedTokenText || sourceText;
      const result = await addPopupAnkiNote(entry, source, volumeMetadata);
      if (result.noteId) {
        await updateAnkiButtonState(entryIndex, { state: 'added' });
        showSnackbar('Added note to Anki.');
      } else {
        await updateAnkiButtonState(entryIndex, { state: 'error' });
        showSnackbar('Failed to add note to Anki.');
      }
    } catch (error) {
      console.error('Failed to add Yomitan note to Anki:', error);
      await updateAnkiButtonState(entryIndex, { state: 'error' });
      const message = error instanceof Error ? error.message : String(error);
      showSnackbar(`Failed to add note: ${message}`);
    }
  }

  function showAnkiButtonsAfterPrecheck(requestId: number, states: YomitanAnkiButtonUiState[]) {
    if (requestId !== lookupRequestId) return;
    const visible = states.map(() => true);
    ankiButtonStates = states;
    ankiButtonChecked = visible;
    ankiButtonFadeIn = visible;
    requestAnimationFrame(() => {
      if (requestId !== lookupRequestId) return;
      ankiButtonFadeIn = states.map(() => false);
    });
  }

  async function loadAndTokenizeText() {
    const text = sourceText.trim();
    debugYomitan('load:start', {
      sourceTextLength: sourceText.length,
      sourceTextPreview: sourceText.slice(0, 120),
      sourceTextCodePoints: getCodePointPreview(sourceText),
      trimmedLength: text.length,
      trimmedPreview: text.slice(0, 120),
      trimmedCodePoints: getCodePointPreview(text)
    });

    if (!text) {
      errorMessage = 'No text found for this box.';
      debugYomitan('load:empty-text', { sourceText });
      return;
    }

    loading = true;
    errorMessage = '';

    try {
      dictionaries = await getInstalledDictionaries();
      debugYomitan('load:dictionaries', {
        dictionaryCount: dictionaries.length,
        dictionaryTitles: dictionaries.map((item) => item.title)
      });
      if (dictionaries.length === 0) {
        errorMessage = 'No Yomitan dictionaries installed. Add dictionaries in Settings > Yomitan.';
        return;
      }

      const normalizedPreferences = normalizeDictionaryPreferences(
        dictionaries.map((item) => item.title),
        loadDictionaryPreferences()
      );
      saveDictionaryPreferences(normalizedPreferences);

      const enabledMap = buildEnabledDictionaryMap(normalizedPreferences);
      debugYomitan('load:dictionary-preferences', {
        normalizedPreferences,
        enabledDictionaryCount: enabledMap.size
      });
      if (enabledMap.size === 0) {
        errorMessage = 'All dictionaries are disabled. Enable at least one in Settings > Yomitan.';
        return;
      }

      tokens = await tokenizeText(text, enabledMap);
      debugYomitan('load:tokenize-complete', {
        tokenCount: tokens.length,
        selectableCount: tokens.filter((token) => token.selectable).length,
        tokenPreview: tokens.slice(0, 10).map((token) => ({
          text: token.text,
          selectable: token.selectable,
          reading: token.reading
        }))
      });
      if (tokens.length === 0) {
        errorMessage = 'No tokens found for this text.';
        debugYomitan('load:no-tokens', {
          textLength: text.length,
          textPreview: text.slice(0, 120),
          textCodePoints: getCodePointPreview(text)
        });
        return;
      }

      const firstSelectableTokenIndex = tokens.findIndex((token) => token.selectable);
      if (firstSelectableTokenIndex >= 0) {
        await handleTokenClick(tokens[firstSelectableTokenIndex], firstSelectableTokenIndex);
      } else {
        selectionMessage = 'No selectable words found for this text.';
      }
    } catch (error) {
      console.error('Yomitan tokenization failed:', error);
      debugYomitan('load:tokenization-failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      errorMessage = 'Failed to initialize Yomitan.';
    } finally {
      loading = false;
    }
  }

  async function handleTokenClick(token: YomitanToken, index: number) {
    if (!token.selectable) return;
    if (selectedTokenIndex === index && (lookupEntries.length > 0 || noEntries || lookupLoading)) {
      return;
    }

    selectedTokenIndex = index;
    lookupLoading = true;
    noEntries = false;
    selectionMessage = '';
    ankiPrecheckWarningShown = false;
    const currentLookupRequestId = lookupRequestId + 1;
    lookupRequestId = currentLookupRequestId;

    try {
      const normalizedPreferences = normalizeDictionaryPreferences(
        dictionaries.map((item) => item.title),
        loadDictionaryPreferences()
      );
      const enabledMap = buildEnabledDictionaryMap(normalizedPreferences);
      debugYomitan('lookup:start', {
        tokenText: token.text,
        tokenIndex: index,
        enabledDictionaryCount: enabledMap.size
      });

      const lookup = await lookupTerm(token.text, enabledMap);
      if (currentLookupRequestId !== lookupRequestId) {
        return;
      }

      selectedTokenText = token.text;
      lookupEntries = lookup.entries;
      debugYomitan('lookup:complete', {
        tokenText: token.text,
        entryCount: lookup.entries.length,
        originalTextLength: lookup.originalTextLength
      });

      if (!lookup.entries.length) {
        ankiButtonStates = [];
        ankiButtonChecked = [];
        ankiButtonFadeIn = [];
        noEntries = true;
        return;
      }

      if (ankiEnabled) {
        ankiButtonStates = lookup.entries.map(() => ({ state: 'ready' }));
        ankiButtonChecked = lookup.entries.map(() => false);
        ankiButtonFadeIn = lookup.entries.map(() => false);
      } else {
        ankiButtonStates = [];
        ankiButtonChecked = [];
        ankiButtonFadeIn = [];
      }

      if (ankiEnabled) {
        void precheckAnkiButtonStates(currentLookupRequestId, lookup.entries, token.text);
      }
    } catch (error) {
      console.error('Yomitan lookup failed:', error);
      debugYomitan('lookup:failed', {
        tokenText: token.text,
        error: error instanceof Error ? error.message : String(error)
      });
      showSnackbar('Failed to look up token in Yomitan.');
      noEntries = true;
    } finally {
      lookupLoading = false;
    }
  }

  async function precheckAnkiButtonStates(
    requestId: number,
    entries: TermDictionaryEntry[],
    tokenText: string
  ) {
    try {
      const source = tokenText || sourceText;
      const result = await getPopupAnkiButtonStates(entries, source, volumeMetadata);
      if (requestId !== lookupRequestId) return;

      showAnkiButtonsAfterPrecheck(requestId, result.buttonStates);

      if (result.hadConnectionError && !ankiPrecheckWarningShown) {
        ankiPrecheckWarningShown = true;
        showSnackbar('Could not verify duplicates in Anki. You can still add cards.');
      }
    } catch (error) {
      if (requestId !== lookupRequestId) return;
      console.error('Failed to precheck Yomitan entries in Anki:', error);
      showAnkiButtonsAfterPrecheck(
        requestId,
        entries.map(() => ({
          state: 'ready',
          title: 'Could not verify duplicates; add may create a duplicate.'
        }))
      );
      if (!ankiPrecheckWarningShown) {
        ankiPrecheckWarningShown = true;
        showSnackbar('Could not verify duplicates in Anki. You can still add cards.');
      }
    }
  }

  async function updateAnkiButtonState(entryIndex: number, nextState: YomitanAnkiButtonUiState) {
    if (entryIndex < 0 || entryIndex >= ankiButtonStates.length) return;
    ankiButtonStates = ankiButtonStates.map((state, index) =>
      index === entryIndex ? nextState : state
    );
    ankiButtonChecked = ankiButtonChecked.map((checked, index) =>
      index === entryIndex ? true : checked
    );
    ankiButtonFadeIn = ankiButtonFadeIn.map((fadeIn, index) =>
      index === entryIndex ? false : fadeIn
    );
  }

  $effect(() => {
    if (!open) {
      resetDrawerState();
      return;
    }

    debugEnabled = isYomitanDebugEnabled();
    loadAndTokenizeText();
  });

  let wasOpen = $state(open);
  $effect(() => {
    if (wasOpen && !open) {
      onClose?.();
    }
    wasOpen = open;
  });
</script>

<svelte:window
  ondragstart={(event) => {
    if (open) {
      event.preventDefault();
    }
  }}
  onkeydown={(event) => {
    if (open && event.key === 'Escape') {
      closeDrawer();
    }
  }}
/>

<Drawer
  bind:open
  placement="bottom"
  modal={true}
  dismissable={true}
  {transitionParams}
  outsideclose={outsideClose}
  onmousedown={handleBackdropMousedown}
  class="z-[12000] h-dvh w-full max-w-none rounded-none border border-gray-700/80 bg-gray-900 p-0 text-white shadow-2xl md:!mr-auto md:!ml-0 md:!h-[80vh] md:!w-1/2 md:!max-w-[50vw] md:rounded-t-2xl [&::backdrop]:bg-gray-950/35"
>
  <div
    bind:this={drawerPanel}
    data-yomitan-drawer
    class="relative flex h-full min-h-0 w-full flex-col"
  >
    <div
      data-testid="yomitan-top-bar"
      role="group"
      aria-label="Yomitan token bar"
      class="shrink-0 border-b border-gray-800 px-4 pt-4 pb-5"
    >
      <div class="mb-4 flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <h2
            class="inline-flex items-center text-base font-semibold text-gray-900 dark:text-white"
          >
            <BookOpenSolid class="mr-2.5 h-4 w-4" />Dictionary
          </h2>
        </div>
      </div>
      {#if debugEnabled}
        <div class="mb-4 flex justify-end">
          <Button
            outline
            color="light"
            class="pointer-events-auto !bg-gray-900/80 !text-gray-100 backdrop-blur-sm"
            onclick={copyDebugSnapshot}>Copy debug snapshot</Button
          >
        </div>
      {/if}
      {#if !loading}
        <section class="fade-in">
          {#if errorMessage}
            <p class="text-sm text-red-300">{errorMessage}</p>
          {:else}
            <div class="flex flex-wrap items-end text-gray-100 select-text">
              {#each tokens as token, index (`token-${index}-${token.text}`)}
                {#if token.selectable}
                  <button
                    type="button"
                    class={`inline appearance-none rounded-sm border-0 bg-transparent px-0.5 py-0 text-[1.05rem] leading-8 text-gray-100 underline underline-offset-3 transition-colors select-text hover:text-white hover:decoration-gray-300 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary-500 ${selectedTokenIndex === index ? 'bg-gray-700/70 decoration-primary-400' : 'decoration-gray-500/70'}`}
                    onclick={() => handleTokenClick(token, index)}
                  >
                    {token.text}
                  </button>
                {:else}
                  <span class="px-0.5 py-0 text-[1.05rem] leading-8 text-gray-200"
                    >{token.text}</span
                  >
                {/if}
              {/each}
            </div>
          {/if}
        </section>
      {/if}
    </div>

    <div class="flex min-h-0 flex-1 flex-col bg-gray-900">
      <section class="relative min-h-0 flex-1 overflow-hidden bg-[#1e1e1e]">
        {#if selectionMessage}
          <div
            class="flex h-full items-center justify-center px-5 text-center text-sm text-gray-600"
          >
            {selectionMessage}
          </div>
        {:else if noEntries}
          <div class="flex h-full items-center justify-center text-sm text-gray-600">
            No dictionary entries found for this token.
          </div>
        {:else if lookupEntries.length > 0}
          <div class="fade-in h-full overflow-x-hidden overflow-y-auto">
            <YomitanResults
              entries={lookupEntries}
              dictionaryInfo={dictionaries}
              theme="dark"
              {ankiEnabled}
              {ankiButtonStates}
              {ankiButtonChecked}
              {ankiButtonFadeIn}
              onAddToAnki={(entryIndex) => {
                void handleAddToAnki(entryIndex);
              }}
            />
          </div>
        {/if}

        {#if lookupLoading}
          <div class="absolute inset-0 bg-[#1e1e1e]"></div>
        {/if}
      </section>
    </div>
  </div>
</Drawer>

<style>
  .fade-in {
    animation: yomitan-fade-in 240ms ease-out;
  }

  @keyframes yomitan-fade-in {
    from {
      opacity: 0;
    }

    to {
      opacity: 1;
    }
  }
</style>
