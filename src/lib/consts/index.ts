import pkg from '../../../package.json';

export const READER_VERSION = pkg.version;

// Returns null for dev/unknown builds (disables release note fetching)
function getGitHubRepo(): string | null {
  if (typeof window === 'undefined') return null;

  switch (window.location.hostname) {
    case 'reader.mokuro.app':
    case 'mokuro-reader-tan.vercel.app':
      return 'Gnathonic/mokuro-reader';
    default:
      return null;
  }
}

export const GITHUB_REPO = getGitHubRepo();
