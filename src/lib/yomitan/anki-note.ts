import { get } from 'svelte/store';
import {
  ankiConnect,
  resolveDynamicTags,
  syncAnkiWeb,
  type VolumeMetadata
} from '$lib/anki-connect';
import type { TermDictionaryEntry } from 'yomitan-core';
import { settings } from '$lib/settings';
import type { YomitanAnkiButtonUiState } from '$lib/yomitan/anki-button-ui';
import { getInstalledDictionaries } from '$lib/yomitan/core';
import { importCoreAnkiModule } from '$lib/yomitan/anki-core';

const PRECHECK_WARNING_TITLE = 'Could not verify duplicates; add may create a duplicate.';

export async function getPopupFieldMarkers(): Promise<string[]> {
  const ankiModule = await importCoreAnkiModule();
  const standard =
    typeof ankiModule.getStandardFieldMarkers === 'function'
      ? ankiModule.getStandardFieldMarkers('term', 'ja')
      : [];

  const installed = await getInstalledDictionaries();
  const dynamic =
    typeof ankiModule.getDynamicFieldMarkers === 'function'
      ? ankiModule.getDynamicFieldMarkers(
          installed.map((item) => ({ name: item.title, enabled: true })),
          installed
        )
      : [];

  return [...new Set([...standard, ...dynamic])].sort((a, b) => a.localeCompare(b));
}

export async function buildPopupAnkiNote(
  dictionaryEntry: TermDictionaryEntry,
  sourceText: string,
  metadata?: VolumeMetadata
) {
  const ankiSettings = get(settings).ankiConnectSettings;
  const {
    popupDeckName,
    popupModelName,
    popupFieldMappings,
    tags,
    popupDuplicateBehavior: _popupDuplicateBehavior
  } = ankiSettings;

  const mappedFields = Object.fromEntries(
    Object.entries(popupFieldMappings)
      .map(([key, value]) => [key.trim(), value.trim()])
      .filter(([key, value]) => key.length > 0 && value.length > 0)
      .map(([key, value]) => [key, { value }])
  );

  if (Object.keys(mappedFields).length === 0) {
    throw new Error(
      'No popup field mappings configured. Configure fields in Settings > Anki Connect.'
    );
  }

  if (!popupModelName?.trim()) {
    throw new Error('No popup model configured. Configure model in Settings > Anki Connect.');
  }

  const resolvedDeckName = metadata ? resolveDynamicTags(popupDeckName, metadata) : popupDeckName;
  const resolvedTags = metadata ? resolveDynamicTags(tags || '', metadata) : tags || '';
  const tagList = resolvedTags
    .split(' ')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const ankiModule = await importCoreAnkiModule();
  const installed = await getInstalledDictionaries();
  const dictionaryStylesMap = new Map<string, string>(
    installed
      .map((item) => [item.title, item.styles ?? ''] as const)
      .filter(([, styles]) => styles.length > 0)
  );
  const dynamicTemplates =
    typeof ankiModule.getDynamicTemplates === 'function'
      ? ankiModule.getDynamicTemplates(
          installed.map((item) => ({ name: item.title, enabled: true })),
          installed
        )
      : '';
  const template =
    typeof ankiModule.getDefaultAnkiFieldTemplates === 'function'
      ? ankiModule.getDefaultAnkiFieldTemplates(dynamicTemplates)
      : undefined;
  const result = await ankiModule.buildAnkiNoteFromDictionaryEntry({
    dictionaryEntry,
    cardFormat: {
      deck: resolvedDeckName || 'Default',
      model: popupModelName,
      fields: mappedFields
    },
    context: {
      url: window.location.href,
      query: sourceText,
      fullQuery: sourceText,
      documentTitle: document.title
    },
    tags: tagList,
    duplicateScope: 'collection',
    duplicateScopeCheckAllModels: false,
    resultOutputMode: 'split',
    glossaryLayoutMode: 'default',
    compactTags: false,
    template,
    dictionaryStylesMap
  });

  return result;
}

export async function addPopupAnkiNote(
  dictionaryEntry: TermDictionaryEntry,
  sourceText: string,
  metadata?: VolumeMetadata
) {
  const result = await buildPopupAnkiNote(dictionaryEntry, sourceText, metadata);
  await ankiConnect('createDeck', { deck: result.note.deckName });
  const noteId = await ankiConnect('addNote', { note: result.note });
  if (!noteId) {
    throw new Error('Failed to add note to Anki.');
  }
  await syncAnkiWeb();

  return {
    noteId,
    errors: result.errors
  };
}

export type PopupAnkiPrecheckResult = {
  buttonStates: YomitanAnkiButtonUiState[];
  hadConnectionError: boolean;
};

export async function getPopupAnkiButtonStates(
  dictionaryEntries: TermDictionaryEntry[],
  sourceText: string,
  metadata?: VolumeMetadata
): Promise<PopupAnkiPrecheckResult> {
  if (dictionaryEntries.length === 0) {
    return { buttonStates: [], hadConnectionError: false };
  }

  const noteResults = await Promise.allSettled(
    dictionaryEntries.map((entry) => buildPopupAnkiNote(entry, sourceText, metadata))
  );
  const module = await importCoreAnkiModule();
  const AnkiConnect = (module as { AnkiConnect?: new (config?: { server?: string }) => unknown })
    .AnkiConnect;

  if (typeof AnkiConnect !== 'function') {
    return {
      buttonStates: dictionaryEntries.map(() => ({
        state: 'ready',
        title: PRECHECK_WARNING_TITLE
      })),
      hadConnectionError: true
    };
  }

  const url = get(settings).ankiConnectSettings.url || 'http://127.0.0.1:8765';
  const anki = new AnkiConnect({ server: url }) as {
    enabled: boolean;
    canAddNotesWithErrorDetail: (
      notes: Array<Record<string, unknown>>
    ) => Promise<Array<{ canAdd: boolean; error: string | null }>>;
    canAddNotes: (notes: Array<Record<string, unknown>>) => Promise<boolean[]>;
    findNoteIds: (notes: Array<Record<string, unknown>>) => Promise<number[][]>;
  };
  anki.enabled = true;

  const indexes: number[] = [];
  const notes: Array<Record<string, unknown>> = [];
  for (const [index, result] of noteResults.entries()) {
    if (result.status === 'fulfilled') {
      indexes.push(index);
      notes.push(result.value.note as unknown as Record<string, unknown>);
    }
  }

  const buttonStates: YomitanAnkiButtonUiState[] = dictionaryEntries.map((_, index) => {
    const result = noteResults[index];
    if (result.status === 'rejected') {
      return {
        state: 'ready',
        title: PRECHECK_WARNING_TITLE
      };
    }
    return { state: 'ready' };
  });

  if (notes.length === 0) {
    return {
      buttonStates,
      hadConnectionError: false
    };
  }

  try {
    const duplicateFlags = await findDuplicateFlags(anki, notes);
    const duplicateNotes = notes.filter((_, index) => duplicateFlags[index]);
    const duplicateNoteIds =
      duplicateNotes.length > 0 ? await anki.findNoteIds(duplicateNotes) : [];

    let duplicateOffset = 0;
    for (const [position, duplicate] of duplicateFlags.entries()) {
      if (!duplicate) continue;
      const originalIndex = indexes[position];
      const noteIds = duplicateNoteIds[duplicateOffset] ?? [];
      duplicateOffset += 1;

      buttonStates[originalIndex] = {
        state: 'duplicate',
        title:
          noteIds.length > 0
            ? 'Already exists in Anki; adding another copy.'
            : 'Likely duplicate in Anki; adding another copy.'
      };
    }

    return {
      buttonStates,
      hadConnectionError: false
    };
  } catch {
    const hasDuplicate = buttonStates.some((state) => state.state === 'duplicate');
    return {
      buttonStates: buttonStates.map((state) => ({
        ...state,
        state: state.state === 'duplicate' && hasDuplicate ? 'duplicate' : 'ready',
        title: PRECHECK_WARNING_TITLE
      })),
      hadConnectionError: true
    };
  }
}

async function findDuplicateFlags(
  anki: {
    canAddNotesWithErrorDetail: (
      notes: Array<Record<string, unknown>>
    ) => Promise<Array<{ canAdd: boolean; error: string | null }>>;
    canAddNotes: (notes: Array<Record<string, unknown>>) => Promise<boolean[]>;
  },
  notes: Array<Record<string, unknown>>
) {
  const stripped = stripNotesToFirstField(notes);
  const noDuplicatesAllowed = stripped.map((note) => ({
    ...note,
    options: { ...(note.options as Record<string, unknown>), allowDuplicate: false }
  }));

  try {
    const detailed = await anki.canAddNotesWithErrorDetail(noDuplicatesAllowed);
    return detailed.map((item) => isDuplicateErrorMessage(item.error));
  } catch (error) {
    if (!isUnsupportedActionError(error)) {
      throw error;
    }
  }

  const [withDuplicatesAllowed, withoutDuplicatesAllowed] = await Promise.all([
    anki.canAddNotes(stripped),
    anki.canAddNotes(noDuplicatesAllowed)
  ]);

  return withDuplicatesAllowed.map((value, index) => value !== withoutDuplicatesAllowed[index]);
}

function stripNotesToFirstField(notes: Array<Record<string, unknown>>) {
  return notes.map((note) => {
    const fields = (note.fields as Record<string, unknown>) || {};
    const firstField = Object.keys(fields)[0];
    if (!firstField) return note;

    return {
      ...note,
      fields: {
        [firstField]: fields[firstField]
      }
    };
  });
}

function isDuplicateErrorMessage(error: string | null | undefined) {
  if (!error) return false;
  return error.toLowerCase().includes('duplicate');
}

function isUnsupportedActionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('unsupported action')) return true;
  if (typeof error === 'object' && error !== null) {
    const data = (error as { data?: { apiError?: unknown } }).data;
    return data?.apiError === 'unsupported action';
  }
  return false;
}
