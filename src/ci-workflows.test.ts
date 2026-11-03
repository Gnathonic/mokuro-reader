// Supply-chain rules for .github/: these files never reach the app, so nothing
// else would notice a regression until a compromised action or an over-broad
// token had already run. Line-based on purpose (no YAML parser is a dependency
// of the app); the files are hand-written in one consistent style.
import { describe, expect, it } from 'vitest';

const raw = (files: Record<string, string>) =>
  Object.entries(files).map(([path, text]) => ({ name: path.split('/').pop()!, text }));

const workflows = raw(
  import.meta.glob<string>('/.github/workflows/*.{yml,yaml}', {
    query: '?raw',
    import: 'default',
    eager: true
  })
);

const indentOf = (line: string) => line.length - line.trimStart().length;

/** The jobs of a workflow: each job id with the lines of its block. */
function jobBlocks(text: string): { id: string; lines: string[] }[] {
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
  const jobs: { id: string; lines: string[] }[] = [];
  for (const line of lines.slice(start + 1)) {
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1];
    if (id) jobs.push({ id, lines: [] });
    else if (/^\S/.test(line)) break;
    else jobs.at(-1)?.lines.push(line);
  }
  return jobs;
}

/** Every `run:` script body of a workflow, line by line. */
function runScriptLines(text: string): string[] {
  const out: string[] = [];
  let runIndent = -1;
  for (const line of text.split('\n')) {
    if (runIndent >= 0) {
      if (line.trim() === '' || indentOf(line) > runIndent) {
        out.push(line);
        continue;
      }
      runIndent = -1;
    }
    const run = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
    if (run) {
      if (/^[|>]/.test(run[2])) runIndent = run[1].length;
      else out.push(run[2]);
    }
  }
  return out;
}

describe('GitHub workflows', () => {
  it('finds the workflows', () => {
    expect(workflows.map((w) => w.name)).toEqual(
      expect.arrayContaining(['ci.yml', 'release.yml', 'interop.yml'])
    );
  });

  it.each(workflows)('$name pins every action to a commit, with its version noted', ({ text }) => {
    const uses = text.split('\n').filter((line) => /^\s*(?:- )?uses:/.test(line));
    for (const line of uses) {
      expect(line).toMatch(
        /uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # (v\d+\.\d+\.\d+|stable branch \(no release tags\), \d{4}-\d{2}-\d{2})$/
      );
    }
  });

  it.each(workflows)('$name defaults its token to read-only contents', ({ text }) => {
    expect(text).toMatch(/^permissions:\n {2}contents: read\n\n/m);
  });

  it.each(workflows)('$name gives every job a timeout', ({ text }) => {
    const jobs = jobBlocks(text);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(
        job.lines.some((line) => /^ {4}timeout-minutes: \d+$/.test(line)),
        `${job.id} has timeout-minutes`
      ).toBe(true);
    }
  });

  it.each(workflows)('$name never interpolates an expression into a shell script', ({ text }) => {
    // Values reach scripts through `env:`; `${{ }}` inside `run:` is pasted into
    // the script before the shell parses it.
    for (const line of runScriptLines(text)) expect(line).not.toContain('${{');
  });

  it('grants write access only to the release job and the PR guard', () => {
    const writers = workflows.flatMap(({ name, text }) =>
      jobBlocks(text)
        .filter((job) => job.lines.some((line) => /^ {6}[a-z-]+: write$/.test(line)))
        .map((job) => `${name}:${job.id}`)
    );
    expect(writers.sort()).toEqual([
      // id-token: write is the action's OIDC exchange, not repository access.
      'claude.yml:claude',
      'pr-target-guard.yml:redirect-forks',
      'pr-target-guard.yml:require-develop-to-main',
      'release.yml:release'
    ]);
  });

  it('release.yml creates the release with the gh CLI and the workflow token', () => {
    const release = workflows.find((w) => w.name === 'release.yml')!.text;
    expect(release).not.toMatch(/uses:\s*softprops\//);
    expect(release).toMatch(/^ {6}contents: write$/m);
    expect(release).toContain('gh release create "v$VERSION"');
    expect(release).toContain('--title "v$VERSION"');
    expect(release).toContain('--notes-file "$RUNNER_TEMP/release-notes.md"');
    expect(release).not.toContain('--prerelease');
    expect(release).not.toContain('--generate-notes');
    expect(release).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    // Notes travel by file, never through a multi-line step output.
    expect(release).not.toMatch(/<<\s*EOF/);
  });

  it.each(['ci.yml', 'interop.yml'])('%s cancels superseded runs on PRs only', (name) => {
    const text = workflows.find((w) => w.name === name)!.text;
    expect(text).toContain(
      'group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.sha }}'
    );
    expect(text).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });
});

describe('Dependabot', () => {
  const [{ text: config }] = raw(
    import.meta.glob<string>('/.github/dependabot.yml', {
      query: '?raw',
      import: 'default',
      eager: true
    })
  );
  const updates = config
    .split(/^ {2}- package-ecosystem: /m)
    .slice(1)
    .map((block) => ({ ecosystem: block.split('\n')[0].trim(), block }));

  it('updates npm and the workflow actions', () => {
    expect(updates.map((u) => u.ecosystem)).toEqual(['npm', 'github-actions']);
  });

  it.each(updates)(
    '$ecosystem: weekly, into develop, a week old, minor/patch grouped',
    ({ block }) => {
      expect(block).toMatch(/^ {4}target-branch: develop$/m);
      expect(block).toMatch(/^ {6}interval: weekly$/m);
      expect(block).toMatch(/^ {4}cooldown:\n {6}default-days: 7$/m);
      expect(block).toMatch(/^ {8}update-types: \[minor, patch\]$/m);
      const limit = Number(/open-pull-requests-limit: (\d+)/.exec(block)?.[1]);
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(5);
    }
  );
});
