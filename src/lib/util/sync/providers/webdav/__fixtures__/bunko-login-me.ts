/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck - This file uses Node.js APIs and is only run by vitest
/**
 * The `/login/api/me` bodies mokuro-bunko serves a signed-in uploader: its
 * contract fixtures `interop/contract/bunko/login-me-basic.json` (a series of
 * its own, nothing closed) and `login-me-closed-series.json` (another
 * account's series closed to it), read from the checkout `BUNKO_REPO` names.
 * Without one (and without `BUNKO_CONTRACT_REQUIRED=1`) the snapshots below,
 * in the shape bunko 0.8 reports series owners with (`permissions.addFiles`).
 *
 * A stand-in until `$lib/interop/contract` reaches this branch, like
 * `catalog/__fixtures__/bunko-marker-active.ts`.
 *
 * Test-only: never import this from app code.
 */
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const PER_USER = {
  per_user_files: ['volume-data.json', 'profiles.json', 'goals.json', 'positions.json', 'history/'],
  per_user_layers: ['edit'],
  version: '0.0.0'
};

function uploaderBody(closedSeries: string[]) {
  return {
    authenticated: true,
    username: 'reader',
    role: 'uploader',
    created_at: '2000-01-01 00:00:00',
    permissions: {
      canWriteProgress: true,
      canAddFiles: true,
      canModifyDelete: false,
      metadata: { scope: 'owned', ownedSeries: ['Contract Series'] },
      // Its one series is its own: no shared-folder uploads to list.
      curated: { scope: 'owned', volumes: [] },
      addFiles: { scope: 'open', closedSeries }
    },
    ...PER_USER
  };
}

export const LOGIN_ME_SNAPSHOTS = {
  'login-me-basic': uploaderBody([]),
  'login-me-closed-series': uploaderBody(['Admin Series'])
};

export type LoginMeFixture = keyof typeof LOGIN_ME_SNAPSHOTS;

/** The body of one `/login/api/me` contract fixture. */
export function bunkoLoginMe(name: LoginMeFixture): Record<string, unknown> {
  const repo = process.env.BUNKO_REPO;
  if (repo) {
    const file = join(resolve(repo), 'interop', 'contract', 'bunko', `${name}.json`);
    // Asked for by name: a wrong path is a mistake, never a quiet fallback.
    if (!existsSync(file)) throw new Error(`BUNKO_REPO=${repo} has no ${file}`);
    return JSON.parse(readFileSync(file, 'utf8')).body;
  }
  if (process.env.BUNKO_CONTRACT_REQUIRED === '1') {
    throw new Error('BUNKO_CONTRACT_REQUIRED=1 but BUNKO_REPO is unset');
  }
  return structuredClone(LOGIN_ME_SNAPSHOTS[name]);
}
