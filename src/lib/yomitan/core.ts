import type { ParseTextResultItem, Summary, TermDictionaryEntry } from 'yomitan-core';
import { createTermEntryRenderer as createCoreTermEntryRenderer } from 'yomitan-core/render';
import type {
  RenderHostOptions,
  RenderedTermEntry,
  TermEntryRenderer,
  PopupTheme,
  TermEntryRendererCreateOptions
} from 'yomitan-core/render';
import type { DictionaryPreference } from './preferences';
import { getCodePointPreview, logYomitanDebug } from './debug';

export type YomitanDictionarySummary = Summary;

export interface YomitanToken {
  text: string;
  reading: string;
  term: string;
  selectable: boolean;
  kind?: 'word' | 'punct' | 'other';
}

export type YomitanPopupTheme = PopupTheme;

export type YomitanRenderHostOptions = RenderHostOptions;
export type YomitanRenderedTermEntry = RenderedTermEntry;
export type YomitanTermEntryRenderer = TermEntryRenderer;
export type YomitanTermEntryRendererCreateOptions = TermEntryRendererCreateOptions;

type SimpleEnabledDictionaryMap = Map<string, { index: number; priority: number }>;

let coreInstance: any | null = null;

async function importCoreIndexModule() {
  return await import('yomitan-core');
}

async function getCoreInstance() {
  if (coreInstance) return coreInstance;

  const module = await importCoreIndexModule();
  const YomitanCore = module.default;
  const core = new YomitanCore({
    databaseName: 'mokuro-reader-yomitan',
    initLanguage: true
  });
  await core.initialize();
  coreInstance = core;
  return coreInstance;
}

function toFindTermDictionaryMap(enabledDictionaryMap: SimpleEnabledDictionaryMap) {
  const map = new Map<
    string,
    {
      index: number;
      alias: string;
      allowSecondarySearches: boolean;
      partsOfSpeechFilter: boolean;
      useDeinflections: boolean;
    }
  >();

  for (const [name, { index }] of enabledDictionaryMap.entries()) {
    map.set(name, {
      index,
      alias: name,
      allowSecondarySearches: false,
      partsOfSpeechFilter: true,
      useDeinflections: true
    });
  }

  return map;
}

function normalizeSourceText(lines: string[]) {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join('')
    .replace(/\s+/g, '')
    .trim();
}

export function buildEnabledDictionaryMap(preferences: DictionaryPreference[]) {
  const enabled = preferences.filter((item) => item.enabled);
  const map: SimpleEnabledDictionaryMap = new Map();

  enabled.forEach((item, index) => {
    map.set(item.title, {
      index,
      priority: 0
    });
  });

  return map;
}

export async function getInstalledDictionaries(): Promise<YomitanDictionarySummary[]> {
  const core = await getCoreInstance();
  const dictionaries = (await core.getDictionaryInfo()) as Summary[];
  return [...dictionaries].sort((a, b) => b.importDate - a.importDate);
}

export async function importDictionaryZip(
  archive: ArrayBuffer,
  onProgress?: (progress: { index: number; count: number; nextStep?: boolean }) => void
) {
  const core = await getCoreInstance();
  return await core.importDictionary(archive, {
    onProgress
  });
}

export async function deleteDictionary(title: string) {
  const core = await getCoreInstance();
  await core.deleteDictionary(title);
}

export async function tokenizeText(text: string, enabledDictionaryMap: SimpleEnabledDictionaryMap) {
  const core = await getCoreInstance();
  const parserDictionaryMap = toFindTermDictionaryMap(enabledDictionaryMap);
  logYomitanDebug('core', 'tokenize:start', {
    textLength: text.length,
    textPreview: text.slice(0, 80),
    textCodePoints: getCodePointPreview(text),
    enabledDictionaryCount: parserDictionaryMap.size,
    enabledDictionaryNames: [...parserDictionaryMap.keys()]
  });

  const parsed = (await core.parseText(text, {
    language: 'ja',
    enabledDictionaryMap: parserDictionaryMap,
    scanLength: 10,
    searchResolution: 'letter',
    removeNonJapaneseCharacters: false,
    deinflect: true,
    textReplacements: [null]
  })) as ParseTextResultItem[];

  logYomitanDebug('core', 'tokenize:parseText-complete', {
    parseResultCount: parsed.length,
    contentBlockCount: parsed.reduce(
      (total, parseResult) => total + (parseResult.content?.length || 0),
      0
    )
  });

  const tokens: YomitanToken[] = [];
  for (const parseResult of parsed) {
    const lines = parseResult.content || [];
    for (const line of lines) {
      for (const segment of line) {
        if (!segment.text) continue;
        const tokenText = segment.text.trim();
        if (!tokenText) continue;

        const selectable = Array.isArray(segment.headwords) && segment.headwords.length > 0;

        tokens.push({
          text: tokenText,
          reading: segment.reading || '',
          term: tokenText,
          selectable,
          kind: selectable ? 'word' : 'other'
        });
      }
    }
  }

  logYomitanDebug('core', 'tokenize:complete', {
    tokenCount: tokens.length,
    selectableCount: tokens.filter((token) => token.selectable).length,
    tokenPreview: tokens.slice(0, 10).map((token) => ({
      text: token.text,
      selectable: token.selectable,
      reading: token.reading
    }))
  });

  return tokens;
}

export async function lookupTerm(text: string, enabledDictionaryMap: SimpleEnabledDictionaryMap) {
  const core = await getCoreInstance();
  const result = (await core.findTerms(text, {
    mode: 'group',
    language: 'ja',
    enabledDictionaryMap: toFindTermDictionaryMap(enabledDictionaryMap),
    options: {
      matchType: 'exact',
      deinflect: true,
      removeNonJapaneseCharacters: false,
      searchResolution: 'letter'
    }
  })) as { entries: TermDictionaryEntry[]; originalTextLength: number };

  return result;
}

export function createTermEntryRenderer(
  options?: YomitanTermEntryRendererCreateOptions
): YomitanTermEntryRenderer {
  return createCoreTermEntryRenderer(options);
}

export function joinTextBoxLines(lines: string[]) {
  return normalizeSourceText(lines);
}
