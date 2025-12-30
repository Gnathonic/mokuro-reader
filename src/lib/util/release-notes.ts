import { writable } from 'svelte/store';
import { READER_VERSION, GITHUB_REPO } from '$lib/consts';

export interface ReleaseInfo {
  version: string;
  name: string;
  body: string;
  html_url: string;
  published_at: string;
}

export const latestRelease = writable<ReleaseInfo | null>(null);
export const releaseError = writable<string | null>(null);

const CACHE_KEY = 'mokuro-latest-release';
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  // Skip for dev builds (no configured repo)
  if (!GITHUB_REPO) {
    return null;
  }

  // Check cache first
  const cached = getCachedRelease();
  if (cached) {
    latestRelease.set(cached);
    return cached;
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github.v3+json' }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json();
    const release: ReleaseInfo = {
      version: data.tag_name.replace(/^v/, ''),
      name: data.name,
      body: data.body,
      html_url: data.html_url,
      published_at: data.published_at
    };

    cacheRelease(release);
    latestRelease.set(release);
    releaseError.set(null);
    return release;
  } catch (error) {
    releaseError.set(error instanceof Error ? error.message : 'Failed to fetch release');
    return null;
  }
}

function getCachedRelease(): ReleaseInfo | null {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) return null;

    const { release, timestamp } = JSON.parse(cached);
    if (Date.now() - timestamp > CACHE_TTL) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    return release;
  } catch {
    return null;
  }
}

function cacheRelease(release: ReleaseInfo): void {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        release,
        timestamp: Date.now()
      })
    );
  } catch {
    // Ignore storage errors
  }
}

export function isNewerVersionAvailable(latest: ReleaseInfo): boolean {
  return compareVersions(latest.version, READER_VERSION) > 0;
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}
