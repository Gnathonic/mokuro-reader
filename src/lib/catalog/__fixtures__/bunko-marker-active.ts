/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck - This file uses Node.js APIs and is only run by vitest
/**
 * The lease marker (`.mokuro-bunko.json`) a running mokuro-bunko writes: its
 * contract fixture `interop/contract/bunko/marker-active.json`, read from the
 * checkout `BUNKO_REPO` names. Without one (and without
 * `BUNKO_CONTRACT_REQUIRED=1`) the snapshot below, copied from that fixture.
 *
 * A stand-in until `$lib/interop/contract` reaches this branch: then
 * `servedMarker` (`__fixtures__/bunko-marker.ts`) replaces it.
 *
 * The tests that read it assert `dedup: true`, so a Bunko checkout from
 * before the marker carried `dedup` fails them on purpose: whatever Bunko ref
 * CI checks out for `BUNKO_REPO` must carry that fixture before this runs
 * there with `BUNKO_CONTRACT_REQUIRED=1`.
 *
 * Test-only: never import this from app code.
 */
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

/** `marker-active`'s body as exported (sentinel times and ids). */
export const ACTIVE_MARKER_SNAPSHOT = {
  version: 1,
  kind: 'mokuro-bunko',
  instance_id: '<id-1>',
  boot_id: '<id-2>',
  instance_name: 'contract-host',
  bunko_version: '0.0.0',
  epoch: 1,
  claimed_at: '2000-01-01T00:00:00.000Z',
  heartbeat_at: '2000-01-01T00:00:00.000Z',
  ttl_s: 900,
  state: 'active',
  compiles: ['series.json', 'catalog.json'],
  ocr: true,
  queue: '.mokuro-queue.json',
  dedup: true,
  took_over_from: null as string | null,
  per_user_files: ['volume-data.json', 'profiles.json', 'goals.json', 'positions.json', 'history/']
};

/**
 * The marker Bunko writes, sentinel times and all: pin the marker clock to its
 * `heartbeat_at` and it reads as a fresh cold-start holder.
 */
export function activeBunkoMarker(): typeof ACTIVE_MARKER_SNAPSHOT {
  const repo = process.env.BUNKO_REPO;
  if (repo) {
    const file = join(resolve(repo), 'interop', 'contract', 'bunko', 'marker-active.json');
    // Asked for by name: a wrong path is a mistake, never a quiet fallback.
    if (!existsSync(file)) throw new Error(`BUNKO_REPO=${repo} has no ${file}`);
    return JSON.parse(readFileSync(file, 'utf8')).body;
  }
  if (process.env.BUNKO_CONTRACT_REQUIRED === '1') {
    throw new Error('BUNKO_CONTRACT_REQUIRED=1 but BUNKO_REPO is unset');
  }
  return structuredClone(ACTIVE_MARKER_SNAPSHOT);
}
