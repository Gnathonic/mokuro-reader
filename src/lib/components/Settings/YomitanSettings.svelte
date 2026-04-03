<script lang="ts">
  import { onMount } from 'svelte';
  import { AccordionItem, Button, Toggle } from 'flowbite-svelte';
  import { updateSetting, settings } from '$lib/settings';
  import { showSnackbar } from '$lib/util/snackbar';
  import { progressTrackerStore } from '$lib/util/progress-tracker';
  import { promptConfirmation } from '$lib/util';
  import {
    deleteDictionary,
    getInstalledDictionaries,
    importDictionaryZip,
    type YomitanDictionarySummary
  } from '$lib/yomitan/core';
  import {
    loadDictionaryPreferences,
    moveDictionaryPreference,
    normalizeDictionaryPreferences,
    saveDictionaryPreferences,
    type DictionaryPreference
  } from '$lib/yomitan/preferences';
  import {
    ALLOWED_RECOMMENDED_DICTIONARY_URLS,
    buildRecommendedDictionaryProxyUrl,
    RECOMMENDED_DICTIONARIES
  } from '$lib/yomitan/recommended-dictionaries';

  let installed = $state<YomitanDictionarySummary[]>([]);
  let preferences = $state<DictionaryPreference[]>([]);
  let isRefreshing = $state(false);
  let isInstallingRecommended = $state(false);

  async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(url, {
          cache: 'no-store',
          redirect: 'follow'
        });
        if (response.ok) {
          return response;
        }

        if (response.status >= 500 && attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          continue;
        }

        throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          continue;
        }
      }
    }

    throw lastError ?? new Error('Failed to fetch dictionary URL');
  }

  async function refreshDictionaries() {
    isRefreshing = true;
    try {
      installed = await getInstalledDictionaries();
      preferences = normalizeDictionaryPreferences(
        installed.map((item) => item.title),
        loadDictionaryPreferences()
      );
      saveDictionaryPreferences(preferences);
    } catch (error) {
      console.error('Failed to refresh dictionaries:', error);
      showSnackbar('Failed to load Yomitan dictionaries.');
    } finally {
      isRefreshing = false;
    }
  }

  onMount(() => {
    refreshDictionaries();
  });

  function updatePopupSetting(enabled: boolean) {
    updateSetting('yomitanPopupOnTextBoxTap', enabled);
  }

  function updatePreference(title: string, enabled: boolean) {
    preferences = preferences.map((item) => (item.title === title ? { ...item, enabled } : item));
    saveDictionaryPreferences(preferences);
  }

  function movePreference(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    preferences = moveDictionaryPreference(preferences, index, targetIndex);
    saveDictionaryPreferences(preferences);
  }

  async function importDictionaryBuffer(
    arrayBuffer: ArrayBuffer,
    processId: string,
    label: string,
    position: number,
    total: number
  ) {
    progressTrackerStore.addProcess({
      id: processId,
      description: 'Importing Yomitan dictionary',
      status: `${label} (${position}/${total})`,
      progress: 0
    });

    await importDictionaryZip(arrayBuffer, (progress) => {
      const percentage = progress.count > 0 ? (progress.index / progress.count) * 100 : 0;
      progressTrackerStore.updateProcess(processId, {
        status: `${label} (${position}/${total})`,
        progress: Math.max(0, Math.min(100, percentage))
      });
    });

    progressTrackerStore.updateProcess(processId, {
      status: `${label} imported`,
      progress: 100
    });
  }

  async function handleFileSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    if (files.length === 0) return;

    const processId = `yomitan-upload-${Date.now()}`;
    let imported = 0;
    let failed = 0;

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const arrayBuffer = await file.arrayBuffer();
          await importDictionaryBuffer(arrayBuffer, processId, file.name, i + 1, files.length);
          imported++;
        } catch (error) {
          failed++;
          console.error(`Failed importing dictionary ${file.name}:`, error);
        }
      }
    } finally {
      progressTrackerStore.removeProcess(processId);
      await refreshDictionaries();

      if (failed === 0) {
        showSnackbar(`Imported ${imported} dictionary${imported === 1 ? '' : 'ies'}.`);
      } else {
        showSnackbar(`Imported ${imported}, failed ${failed}.`);
      }
      input.value = '';
    }
  }

  async function handleDeleteDictionary(title: string) {
    promptConfirmation(`Delete dictionary "${title}"?`, async () => {
      try {
        await deleteDictionary(title);
        await refreshDictionaries();
        showSnackbar(`Deleted ${title}.`);
      } catch (error) {
        console.error(`Failed to delete dictionary ${title}:`, error);
        showSnackbar(`Failed to delete ${title}.`);
      }
    });
  }

  async function installRecommendedDictionaries() {
    isInstallingRecommended = true;
    const processId = `yomitan-recommended-${Date.now()}`;
    let imported = 0;
    let failed = 0;

    progressTrackerStore.addProcess({
      id: processId,
      description: 'Installing recommended dictionaries',
      status: `0 / ${RECOMMENDED_DICTIONARIES.length}`,
      progress: 0
    });

    try {
      for (let i = 0; i < RECOMMENDED_DICTIONARIES.length; i++) {
        const url = RECOMMENDED_DICTIONARIES[i];
        const label = url.split('/').pop() || `Dictionary ${i + 1}`;

        try {
          if (!ALLOWED_RECOMMENDED_DICTIONARY_URLS.has(url)) {
            throw new Error(`Blocked unapproved recommended dictionary URL: ${url}`);
          }

          progressTrackerStore.updateProcess(processId, {
            status: `Downloading ${label} (${i + 1}/${RECOMMENDED_DICTIONARIES.length})`
          });

          const response = await fetchWithRetry(buildRecommendedDictionaryProxyUrl(url), 3);
          const arrayBuffer = await response.arrayBuffer();

          await importDictionaryBuffer(
            arrayBuffer,
            processId,
            label,
            i + 1,
            RECOMMENDED_DICTIONARIES.length
          );

          imported++;
        } catch (error) {
          failed++;
          console.error(`Failed installing recommended dictionary ${url}:`, error);
        }

        progressTrackerStore.updateProcess(processId, {
          progress: ((i + 1) / RECOMMENDED_DICTIONARIES.length) * 100,
          status: `${i + 1} / ${RECOMMENDED_DICTIONARIES.length}`
        });
      }
    } finally {
      isInstallingRecommended = false;
      progressTrackerStore.removeProcess(processId);
      await refreshDictionaries();

      if (failed === 0) {
        showSnackbar(`Installed ${imported} recommended dictionaries.`);
      } else {
        showSnackbar(`Installed ${imported}, failed ${failed}.`);
      }
    }
  }
</script>

<AccordionItem open>
  {#snippet header()}Yomitan{/snippet}
  <div class="flex flex-col gap-4">
    <Toggle
      checked={$settings.yomitanPopupOnTextBoxTap}
      onchange={(event) => updatePopupSetting((event.currentTarget as HTMLInputElement).checked)}
    >
      Enable textbox tap/click Yomitan popup
    </Toggle>

    <div class="flex flex-col gap-2">
      <label class="text-sm text-gray-300" for="yomitan-dictionary-upload"
        >Upload dictionaries (.zip)</label
      >
      <input
        id="yomitan-dictionary-upload"
        type="file"
        accept=".zip"
        multiple
        onchange={handleFileSelection}
        class="block w-full cursor-pointer rounded border border-gray-600 bg-gray-800 p-2 text-sm text-gray-100"
      />
      <Button
        onclick={installRecommendedDictionaries}
        disabled={isInstallingRecommended}
        color="alternative"
      >
        {isInstallingRecommended ? 'Installing...' : 'Install recommended dictionaries'}
      </Button>
    </div>

    <div class="rounded border border-gray-700 p-3">
      <div class="mb-2 flex items-center justify-between">
        <h4 class="text-sm font-semibold text-gray-900 dark:text-white">Installed dictionaries</h4>
        <Button size="xs" color="alternative" onclick={refreshDictionaries} disabled={isRefreshing}
          >Refresh</Button
        >
      </div>

      {#if isRefreshing}
        <p class="text-xs text-gray-400">Loading dictionaries...</p>
      {:else if preferences.length === 0}
        <p class="text-xs text-gray-400">No dictionaries installed.</p>
      {:else}
        <div class="flex flex-col gap-2">
          {#each preferences as preference, index (preference.title)}
            <div class="rounded border border-gray-700 p-2">
              <div class="mb-2 text-sm font-medium text-gray-900 dark:text-white">
                {preference.title}
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Toggle
                  checked={preference.enabled}
                  onchange={(event) =>
                    updatePreference(
                      preference.title,
                      (event.currentTarget as HTMLInputElement).checked
                    )}>Enabled</Toggle
                >
                <Button
                  size="xs"
                  color="alternative"
                  disabled={index === 0}
                  onclick={() => movePreference(index, -1)}>Up</Button
                >
                <Button
                  size="xs"
                  color="alternative"
                  disabled={index === preferences.length - 1}
                  onclick={() => movePreference(index, 1)}>Down</Button
                >
                <Button
                  size="xs"
                  color="red"
                  outline
                  onclick={() => handleDeleteDictionary(preference.title)}>Delete</Button
                >
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</AccordionItem>
