import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import { getPopupAnkiButtonStates } from './anki-note';

const coreMocks = vi.hoisted(() => ({
  getInstalledDictionaries: vi.fn()
}));

const ankiCoreMocks = vi.hoisted(() => ({
  importCoreAnkiModule: vi.fn()
}));

vi.mock('$lib/yomitan/core', () => coreMocks);
vi.mock('$lib/yomitan/anki-core', () => ankiCoreMocks);
vi.mock('$lib/settings', () => {
  const settings = writable({
    ankiConnectSettings: {
      url: 'http://127.0.0.1:8765',
      popupDeckName: 'Default',
      popupModelName: 'Basic',
      popupFieldMappings: { Front: '{expression}' },
      tags: '',
      popupDuplicateBehavior: 'new'
    }
  });

  return { settings };
});

function createMockAnkiModule(overrides?: {
  canAddNotesWithErrorDetail?: (
    notes: any[]
  ) => Promise<Array<{ canAdd: boolean; error: string | null }>>;
  canAddNotes?: (notes: any[]) => Promise<boolean[]>;
  findNoteIds?: (notes: any[]) => Promise<number[][]>;
}) {
  class MockAnkiConnect {
    enabled = false;

    async canAddNotesWithErrorDetail(notes: any[]) {
      if (overrides?.canAddNotesWithErrorDetail) {
        return await overrides.canAddNotesWithErrorDetail(notes);
      }
      return notes.map(() => ({ canAdd: true, error: null }));
    }

    async canAddNotes(notes: any[]) {
      if (overrides?.canAddNotes) {
        return await overrides.canAddNotes(notes);
      }
      return notes.map(() => true);
    }

    async findNoteIds(notes: any[]) {
      if (overrides?.findNoteIds) {
        return await overrides.findNoteIds(notes);
      }
      return notes.map(() => []);
    }
  }

  return {
    buildAnkiNoteFromDictionaryEntry: vi.fn(async () => ({
      note: {
        deckName: 'Default',
        modelName: 'Basic',
        fields: {
          Front: '猫'
        },
        tags: [],
        options: {
          allowDuplicate: true,
          duplicateScope: 'collection',
          duplicateScopeOptions: {
            deckName: null,
            checkChildren: false,
            checkAllModels: false
          }
        }
      },
      errors: [],
      requirements: []
    })),
    getDynamicTemplates: vi.fn(() => ''),
    getDefaultAnkiFieldTemplates: vi.fn(() => ''),
    AnkiConnect: MockAnkiConnect
  };
}

describe('getPopupAnkiButtonStates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coreMocks.getInstalledDictionaries.mockResolvedValue([]);
  });

  it('marks entries as duplicate when detailed duplicate check reports duplicates', async () => {
    ankiCoreMocks.importCoreAnkiModule.mockResolvedValue(
      createMockAnkiModule({
        canAddNotesWithErrorDetail: async () => [
          { canAdd: false, error: 'cannot create note because it is a duplicate' }
        ],
        findNoteIds: async () => [[1234]]
      })
    );

    const result = await getPopupAnkiButtonStates([{} as never], '猫');

    expect(result.hadConnectionError).toBe(false);
    expect(result.buttonStates[0]?.state).toBe('duplicate');
    expect(result.buttonStates[0]?.title).toContain('Already exists in Anki');
  });

  it('falls back to canAddNotes comparison when canAddNotesWithErrorDetail is unsupported', async () => {
    ankiCoreMocks.importCoreAnkiModule.mockResolvedValue(
      createMockAnkiModule({
        canAddNotesWithErrorDetail: async () => {
          throw new Error('Anki error: unsupported action');
        },
        canAddNotes: async (notes: any[]) => {
          const allowDuplicate = notes[0]?.options?.allowDuplicate !== false;
          return [allowDuplicate];
        },
        findNoteIds: async () => [[55]]
      })
    );

    const result = await getPopupAnkiButtonStates([{} as never], '猫');

    expect(result.hadConnectionError).toBe(false);
    expect(result.buttonStates[0]?.state).toBe('duplicate');
  });

  it('fails open with ready state when precheck connection fails', async () => {
    ankiCoreMocks.importCoreAnkiModule.mockResolvedValue(
      createMockAnkiModule({
        canAddNotesWithErrorDetail: async () => {
          throw new Error('Anki connection failure');
        }
      })
    );

    const result = await getPopupAnkiButtonStates([{} as never], '猫');

    expect(result.hadConnectionError).toBe(true);
    expect(result.buttonStates[0]?.state).toBe('ready');
  });
});
