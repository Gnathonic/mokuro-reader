/**
 * scripts/migrate-lib-subpath.mjs, the codemod every branch rebased past #359
 * re-runs. Each case copies the script into a fixture tree (it resolves
 * `src/lib` from its own location) and runs it there; the last case runs
 * `--check` on this repository, so a `$lib`, `$app/environment` or
 * `$env/dynamic/private` specifier that comes back fails `npm test`. In a
 * `vi.mock` string the deprecated `$app/environment` still RESOLVES (to a
 * module nothing imports any more), so such a mock would silently never apply.
 *
 * The old specifiers are built from pieces below so this file holds none
 * itself: the repository check would flag it otherwise.
 */
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error no type declarations for node:child_process in this project
import { spawnSync } from 'node:child_process';
// @ts-expect-error no type declarations for node:fs in this project
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// @ts-expect-error no type declarations for node:os in this project
import { tmpdir } from 'node:os';
// @ts-expect-error no type declarations for node:path in this project
import { dirname, join } from 'node:path';

// The one Node global read here (the project carries no `@types/node`).
declare const process: { execPath: string; cwd(): string };

// Vitest runs from the project root.
const SCRIPT_SOURCE = join(process.cwd(), 'scripts/migrate-lib-subpath.mjs');

const L = '$' + 'lib';
const ENV = '$' + 'app/environment';
const PRIVATE = '$' + 'env/dynamic/private';

/** The `src/lib` files every fixture resolves against. */
const LIB: Record<string, string> = {
  'src/lib/util/foo.ts': '',
  'src/lib/util/legacy.js': '',
  'src/lib/reader/edit/index.ts': '',
  'src/lib/index.ts': '',
  'src/lib/x/session.svelte.ts': '',
  'src/lib/x/Foo.svelte': '',
  'src/lib/x/style.css': '',
  'src/lib/workers/w.ts': ''
};

let root: string;

function tree(files: Record<string, string>) {
  root = mkdtempSync(join(tmpdir(), 'migrate-lib-'));
  const all = {
    ...LIB,
    ...files,
    'scripts/migrate-lib-subpath.mjs': readFileSync(SCRIPT_SOURCE, 'utf8')
  };
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
}

function run(...args: string[]) {
  const r = spawnSync(process.execPath, ['scripts/migrate-lib-subpath.mjs', ...args], {
    cwd: root,
    encoding: 'utf8'
  });
  return { code: r.status as number, stdout: r.stdout as string, stderr: r.stderr as string };
}

const read = (path: string) => readFileSync(join(root, path), 'utf8') as string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('migrate-lib-subpath', () => {
  it('names the file each specifier resolves to', () => {
    tree({
      'src/a.ts': [
        `import { foo } from '${L}/util/foo';`,
        `import { old } from '${L}/util/legacy';`,
        `import { edit } from '${L}/reader/edit';`,
        `import { root } from '${L}';`,
        `import { s } from '${L}/x/session.svelte';`,
        `import Foo from "${L}/x/Foo.svelte";`,
        `import '${L}/x/style.css';`,
        `import W from '${L}/workers/w.ts?worker';`,
        `import { already } from '${L}/util/foo.js';`,
        `import { dir } from '${L}/reader/edit/';`,
        `import { browser } from '${ENV}';`,
        ''
      ].join('\n')
    });
    const { code, stdout, stderr } = run();
    expect(stderr).toContain('changed 1 file(s): 10 ');
    expect(stderr).toContain(', 1 ');
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(join('src', 'a.ts'));
    expect(read('src/a.ts')).toBe(
      [
        `import { foo } from '#lib/util/foo.js';`,
        `import { old } from '#lib/util/legacy.js';`,
        `import { edit } from '#lib/reader/edit/index.js';`,
        `import { root } from '#lib/index.js';`,
        `import { s } from '#lib/x/session.svelte.js';`,
        `import Foo from "#lib/x/Foo.svelte";`,
        `import '#lib/x/style.css';`,
        `import W from '#lib/workers/w.ts?worker';`,
        `import { already } from '#lib/util/foo.js';`,
        `import { dir } from '#lib/reader/edit/index.js';`,
        `import { browser } from '$app/env';`,
        ''
      ].join('\n')
    );
  });

  it('rewrites two specifiers on one line, each on its own', () => {
    tree({
      'src/b.ts': `vi.mock('${L}/util/foo', () => ({})); vi.mock('${L}/util/legacy', () => ({}));\n`
    });
    expect(run().code).toBe(0);
    expect(read('src/b.ts')).toBe(
      `vi.mock('#lib/util/foo.js', () => ({})); vi.mock('#lib/util/legacy.js', () => ({}));\n`
    );
  });

  it('leaves backtick prose alone', () => {
    const body = `// see \`${L}/util/foo\` and \`${ENV}\`\nconst s = \`${L}/util/foo\`;\n`;
    tree({ 'src/c.ts': body });
    const { code, stdout } = run();
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(read('src/c.ts')).toBe(body);
  });

  it('never turns a worker URL into a #lib fragment, and reports it', () => {
    const body = `new Worker(new URL('${L}/workers/w.ts', import.meta.url));\n`;
    tree({ 'src/d.ts': body });
    const { code, stderr } = run();
    expect(read('src/d.ts')).toBe(body);
    expect(stderr).toContain('src/d.ts:1');
    expect(stderr).toContain('make it relative');
    expect(code).toBe(1);
  });

  it('reports a specifier that resolves to nothing and leaves it as it is', () => {
    const body = [
      `import { a } from '${L}/util/gone';`,
      // Written with an extension: still checked against the tree.
      `import { b } from '${L}/util/old-helper.js';`,
      `import { c } from '${L}/util/old-helper.ts';`,
      ''
    ].join('\n');
    tree({ 'src/e.ts': body });
    const { code, stderr } = run();
    expect(read('src/e.ts')).toBe(body);
    expect(stderr).toContain('src/e.ts:1');
    expect(stderr).toContain('src/e.ts:2');
    expect(stderr).toContain('src/e.ts:3');
    expect(stderr).toContain('resolves to no file under src/lib');
    expect(code).toBe(1);
  });

  it('reports $env/dynamic/private for a hand fix (the import changes shape)', () => {
    const body = `import { env } from '${PRIVATE}';\n`;
    tree({ 'src/routes/api/x/+server.ts': body });
    const { code, stderr } = run();
    expect(read('src/routes/api/x/+server.ts')).toBe(body);
    expect(stderr).toContain('import * as env from');
    expect(code).toBe(1);
  });

  it('--check writes nothing and fails; a second run changes nothing', () => {
    const body = `import { foo } from '${L}/util/foo';\n`;
    tree({ 'src/f.ts': body, 'e2e/g.spec.ts': `import { browser } from '${ENV}';\n` });

    const checked = run('--check');
    expect(checked.code).toBe(1);
    expect(checked.stderr).toContain('would change 2 file(s)');
    expect(read('src/f.ts')).toBe(body);

    expect(run().code).toBe(0);
    const after = read('src/f.ts');
    expect(after).toBe(`import { foo } from '#lib/util/foo.js';\n`);

    const again = run();
    expect(again.code).toBe(0);
    expect(again.stdout).toBe('');
    expect(read('src/f.ts')).toBe(after);
    expect(run('--check').code).toBe(0);
  });

  it('this repository has no specifier left to migrate', () => {
    const r = spawnSync(process.execPath, [SCRIPT_SOURCE, '--check'], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });
    expect(r.stdout + r.stderr).toContain('would change 0 file(s)');
    expect(r.status).toBe(0);
  });
});
