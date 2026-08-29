import type { SeriesTitles } from './types';

export interface MetadataSearchResult {
  provider: 'anilist';
  id: number;
  idMal?: number;
  titles: SeriesTitles;
  synonyms: string[];
  format?: string;
  status?: string;
  year?: number;
  volumes?: number;
  chapters?: number;
  coverUrl?: string;
  siteUrl: string;
}

export interface MetadataProvider {
  id: 'anilist';
  search(query: string, signal?: AbortSignal): Promise<MetadataSearchResult[]>;
  getById(id: number): Promise<MetadataSearchResult | null>;
  siteUrl(id: number): string;
}
