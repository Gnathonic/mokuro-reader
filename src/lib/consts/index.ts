import pkg from '../../../package.json';

export const READER_VERSION = pkg.version;

// Map deployment URLs to their GitHub repos
// Returns null for dev/unknown builds (changelog not applicable)
function getGitHubRepo(): string | null {
  if (typeof window === 'undefined') return null;

  switch (window.location.hostname) {
    case 'reader.mokuro.app':
      return 'ZXY101/mokuro-reader';
    case 'mokuro-reader-tan.vercel.app':
      return 'Gnathonic/mokuro-reader';
    default:
      return null;
  }
}

export const GITHUB_REPO = getGitHubRepo();
