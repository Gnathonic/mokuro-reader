#!/usr/bin/env node
// Copy fold v2 and sidecar names rule 2 from a mokuro-bunko checkout into this
// repository, byte for byte: `fold-table.json` (the tables the reader's own
// fold and NFD/NFC are built from, bundled into the app), `fold.json` (its
// vectors and digest) and `sidecar-names.json` (rule 2's vectors).
//
//   BUNKO_REPO=<bunko checkout> node scripts/vendor-contract.mjs [--check]
//
// They are Bunko's files, generated there by
// `crates/bunko-core/scripts/gen_fold.py` (the two fold files) or written there
// by hand (the rule): never edit the copies. The fold's SHA-256 is checked
// against `fold.json`'s `table_sha256` before anything is written. `--check`
// writes nothing and exits 1 when a copy differs from the checkout's.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['fold-table.json', 'fold.json', 'sidecar-names.json'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'src', 'lib', 'interop', 'contract');
const check = process.argv.includes('--check');

const repo = process.env.BUNKO_REPO;
if (!repo) {
  console.error('vendor-contract: set BUNKO_REPO to a mokuro-bunko checkout');
  process.exit(2);
}
const source = join(resolve(repo), 'interop', 'contract');
const bytes = {};
for (const file of FILES) {
  const path = join(source, file);
  if (!existsSync(path)) {
    console.error(`vendor-contract: ${path} is missing (a Bunko branch before fold v2?)`);
    process.exit(2);
  }
  bytes[file] = readFileSync(path);
}

const fold = JSON.parse(bytes['fold.json'].toString('utf8'));
const tableSha = createHash('sha256').update(bytes['fold-table.json']).digest('hex');
if (tableSha !== fold.table_sha256) {
  console.error(
    `vendor-contract: fold-table.json hashes to ${tableSha}, fold.json says ${fold.table_sha256}`
  );
  process.exit(1);
}
const rule = JSON.parse(bytes['sidecar-names.json'].toString('utf8')).rule;

let differs = 0;
for (const file of FILES) {
  const dest = join(target, file);
  const same = existsSync(dest) && readFileSync(dest).equals(bytes[file]);
  if (same) continue;
  differs++;
  if (check) console.error(`vendor-contract: ${dest} differs from ${join(source, file)}`);
  else writeFileSync(dest, bytes[file]);
}
if (check && differs) process.exit(1);
console.log(
  `vendor-contract: fold ${fold.fold} (UCD ${fold.ucd}), sidecar names rule ${rule}: ` +
    (check ? (differs ? `${differs} differ` : 'up to date') : `${differs} file(s) written`)
);
