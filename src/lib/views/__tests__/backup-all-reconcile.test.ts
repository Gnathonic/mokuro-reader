import { describe, expect, it } from 'vitest';

/**
 * Both "backup everything" buttons early-return when there is nothing left to
 * upload — and that return is precisely the case a user with an older library
 * hits: every `.cbz` is already in the cloud, so the backup run (the only path
 * that publishes `series.json`/`catalog.json` as a side effect) never starts,
 * and the folders keep sitting there with no index. The fix is one
 * fire-and-forget `reconcileMissingMetadataFiles()` on that branch.
 *
 * Asserted against the SOURCE rather than a rendered component on purpose:
 * reaching that branch through the UI means standing up the whole cloud screen
 * (five providers, quota, queues) or the whole series page (catalog, router,
 * volume list) just to observe one fire-and-forget call. The behaviour of the
 * reconcile itself is covered in `series-file-sync.reconcile.test.ts` and its
 * automatic call site in `unified-cloud-manager.test.ts`; what is left to
 * protect here is only that these two branches still make the call at all.
 */

const sources = import.meta.glob('../*.svelte', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

function read(name: string): string {
  const key = Object.keys(sources).find((path) => path.endsWith(`/${name}`));
  expect(key, `${name} not found`).toBeTruthy();
  return sources[key!];
}

/** The body of `functionName`'s zero-to-upload early return, snackbar included. */
function earlyReturnBranch(source: string, functionName: string): string {
  const start = source.indexOf(`function ${functionName}(`);
  expect(start, `${functionName} not found`).toBeGreaterThan(-1);
  const branchStart = source.indexOf('if (volumesToBackup.length === 0) {', start);
  expect(branchStart, `${functionName} no longer early-returns on an empty queue`).toBeGreaterThan(
    -1
  );
  const branchEnd = source.indexOf('}', source.indexOf('return;', branchStart));
  return source.slice(branchStart, branchEnd);
}

describe('the "already backed up" branch backfills the metadata files', () => {
  const cases: Array<[string, string]> = [
    ['CloudView.svelte', 'backupAllSeries'],
    ['SeriesView.svelte', 'backupSeries']
  ];

  for (const [file, fn] of cases) {
    it(`${file} — ${fn} reconciles before telling the user there is nothing to do`, () => {
      const source = read(file);
      expect(source).toContain(
        "import { reconcileMissingMetadataFiles } from '$lib/metadata/series-file-sync';"
      );

      const branch = earlyReturnBranch(source, fn);
      // Fire-and-forget: the snackbar must not wait on a cloud round trip.
      expect(branch).toContain('void reconcileMissingMetadataFiles()');
      expect(branch.indexOf('reconcileMissingMetadataFiles()')).toBeLessThan(
        branch.indexOf('showSnackbar(')
      );
    });
  }
});
