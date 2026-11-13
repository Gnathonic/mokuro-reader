#!/usr/bin/env node
// Rewrites `$lib` import specifiers to `#lib` subpath imports, and the
// deprecated `$app/environment` to `$app/env` (SvelteKit 3; issue #359).
//
// SvelteKit 3 no longer provides `$lib`. The app resolves `#lib/*` through
// package.json `"imports": { "#lib/*": "./src/lib/*" }`, which Vite, Vitest,
// TypeScript (svelte-check) and Node all understand. A subpath import names a
// real file, so the rewrite adds the extension the file resolves with, the way
// `sv migrate sveltekit-3` does:
//
//   '$lib/util/foo'            -> '#lib/util/foo.js'       (foo.ts or foo.js)
//   '$lib/reader/edit'         -> '#lib/reader/edit/index.js' (a directory)
//   '$lib/x/session.svelte'    -> '#lib/x/session.svelte.js'  (session.svelte.ts)
//   '$lib/x/Foo.svelte'        -> '#lib/x/Foo.svelte'      (an existing file: kept)
//   '$lib/x/foo.ts?worker'     -> '#lib/x/foo.ts?worker'   (extension, query kept)
//   '$app/environment'         -> '$app/env'
//
// `$env/dynamic/private` is reported, never rewritten: its replacement is a
// different import SHAPE (`import { env } from '$env/dynamic/private'` becomes
// `import * as env from '$app/env/private'`, and a `vi.mock` of it returns the
// variables themselves), so it is fixed by hand.
//
// What it deliberately does NOT do (gotchas from the trial run on #359):
// - It matches each quoted string on its own, never a greedy span across a
//   line, so two specifiers on one line both rewrite correctly.
// - Backtick-quoted mentions (`$lib/...` in comments and template strings)
//   are left alone: they are prose, not specifiers.
// - A string passed to `new URL('...', import.meta.url)` is never rewritten:
//   `#lib/...` in a URL reads as a fragment. Such a URL must be relative;
//   the script reports it so it can be fixed by hand.
//
// Usage (from the repository root):
//
//   node scripts/migrate-lib-subpath.mjs            # rewrite in place
//   node scripts/migrate-lib-subpath.mjs --check    # report only; exit 1 if anything would change
//   node scripts/migrate-lib-subpath.mjs src/lib/foo  # only these files/directories
//
// The paths of the files it changed go to stdout (one per line, the summary to
// stderr), so formatting them is one pipe:
//
//   node scripts/migrate-lib-subpath.mjs | xargs -r npx prettier --write
//
// It is idempotent: a second run changes nothing. A branch that still has
// `$lib` imports after #359 landed (rebased onto it, or merged it in) runs it
// again, formats the touched files, and commits the result. Specifiers it
// cannot resolve (a typo, a file that does not exist, even one written with
// its extension) are left as they are and reported; the run then exits 1.
//
// src/migrate-lib-subpath.test.ts runs it on fixture trees, and runs `--check`
// on this repository: a `$lib`, `$app/environment` or `$env/dynamic/private`
// specifier that comes back fails `npm test` — also in a `vi.mock` string,
// where the two deprecated modules still resolve (to modules nothing imports
// any more), so the mock would silently never apply.
//
// No dependencies beyond Node itself.

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const LIB_DIR = join(ROOT, 'src', 'lib');

/** Directories walked by default, and the root-level config files. */
const DEFAULT_DIRS = ['src', 'e2e', 'scripts'];
const ROOT_FILE = /^[^.].*\.(?:[cm]?[jt]s)$/;
const SOURCE_FILE = /\.(?:svelte|[cm]?[jt]s)$/;
const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', 'build', '.vercel', 'coverage', '.git']);

// Built from pieces so this file's own source holds no specifier to rewrite.
const OLD = '$' + 'lib';
const NEW = '#' + 'lib';
const OLD_ENV = '$' + 'app/environment';
const NEW_ENV = '$' + 'app/env';
const OLD_PRIVATE = '$' + 'env/dynamic/private';
const NEW_PRIVATE = '$' + 'app/env/private';

/**
 * One quoted string at a time: the quote, `$lib`, `$app/environment` or
 * `$env/dynamic/private`, then (`$lib` only) anything but that quote, a
 * backslash or a line break, then the same quote.
 */
const SPECIFIER = /(['"])(\$lib(?:\/[^'"\\\n]*)?|\$app\/environment|\$env\/dynamic\/private)\1/g;

/** `new URL(` right before the string (whitespace allowed). */
const URL_CALL = /new\s+URL\(\s*$/;

/**
 * The `#lib` specifier for a `$lib` one, or `null` when nothing resolves it.
 * @param {string} spec `$lib/...`, with any `?query`
 */
function rewriteLib(spec) {
  const q = spec.indexOf('?');
  const path = q === -1 ? spec : spec.slice(0, q);
  const query = q === -1 ? '' : spec.slice(q);
  const sub = path === OLD ? '' : path.slice(OLD.length + 1).replace(/\/+$/, '');
  const target = join(LIB_DIR, sub);
  let out;
  if (sub !== '' && isFile(target)) {
    out = sub; // names a file as it is (.ts, .js, .svelte, .css, an asset)
  } else if (sub !== '' && sub.endsWith('.js') && isFile(target.slice(0, -3) + '.ts')) {
    out = sub; // already the `.js` name of a `.ts` source
  } else if (sub !== '' && (isFile(target + '.ts') || isFile(target + '.js'))) {
    out = sub + '.js'; // a module: TypeScript and Vite map `.js` onto the `.ts` source
  } else if (isFile(join(target, 'index.ts')) || isFile(join(target, 'index.js'))) {
    out = sub === '' ? 'index.js' : sub + '/index.js';
  } else {
    return null;
  }
  return `${NEW}/${out}${query}`;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} file
 * @param {string} text
 */
function transform(file, text) {
  let lib = 0;
  let env = 0;
  /** @type {string[]} */
  const problems = [];
  const out = text.replace(SPECIFIER, (match, quote, spec, offset) => {
    const line = text.slice(0, offset).split('\n').length;
    const where = `${relative(ROOT, file)}:${line}`;
    if (URL_CALL.test(text.slice(Math.max(0, offset - 40), offset))) {
      if (spec.startsWith(OLD)) {
        problems.push(
          `${where}: ${match} is a URL (new URL(..., import.meta.url)): make it relative`
        );
      }
      return match;
    }
    if (spec === OLD_PRIVATE) {
      problems.push(
        `${where}: ${match} is now ${quote}${NEW_PRIVATE}${quote}, imported as a namespace ` +
          `(import * as env from ${quote}${NEW_PRIVATE}${quote}): change it by hand`
      );
      return match;
    }
    if (spec === OLD_ENV) {
      env++;
      return quote + NEW_ENV + quote;
    }
    const next = rewriteLib(spec);
    if (next === null) {
      problems.push(`${where}: ${match} resolves to no file under src/lib`);
      return match;
    }
    lib++;
    return quote + next + quote;
  });
  return { out, lib, env, problems };
}

/** @param {string} dir @param {string[]} into */
function walk(dir, into) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, into);
    else if (entry.isFile() && SOURCE_FILE.test(entry.name)) into.push(path);
  }
  return into;
}

function collect(args) {
  /** @type {string[]} */
  const files = [];
  if (args.length === 0) {
    for (const dir of DEFAULT_DIRS) {
      if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir), files);
    }
    for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
      if (entry.isFile() && ROOT_FILE.test(entry.name)) files.push(join(ROOT, entry.name));
    }
  } else {
    for (const arg of args) {
      const path = resolve(arg);
      if (statSync(path).isDirectory()) walk(path, files);
      else files.push(path);
    }
  }
  return files.filter((f) => f !== SELF && !f.split(sep).includes('node_modules'));
}

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const unknown = argv.filter((a) => a.startsWith('-') && a !== '--check');
if (unknown.length > 0) {
  console.error(`Unknown option(s): ${unknown.join(' ')}`);
  process.exit(2);
}

let files = 0;
let libTotal = 0;
let envTotal = 0;
/** @type {string[]} */
const problems = [];
for (const file of collect(argv.filter((a) => !a.startsWith('-')))) {
  const text = readFileSync(file, 'utf8');
  const { out, lib, env, problems: found } = transform(file, text);
  problems.push(...found);
  if (out === text) continue;
  files++;
  libTotal += lib;
  envTotal += env;
  if (!check) writeFileSync(file, out);
  console.log(relative(process.cwd(), file));
}

const verb = check ? 'would change' : 'changed';
console.error(
  `${verb} ${files} file(s): ${libTotal} ${OLD} specifier(s), ${envTotal} ${OLD_ENV} specifier(s)`
);
for (const problem of problems) console.error(`  not rewritten: ${problem}`);
if (problems.length > 0 || (check && files > 0)) process.exit(1);
