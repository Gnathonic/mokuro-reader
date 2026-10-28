/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any */
// @ts-nocheck - This file uses Node.js APIs and is only run by vitest
/**
 * The reader side of the Bunko contract (mokuro-bunko `interop/contract/`).
 *
 * Bunko exports what it answers the reader as golden fixtures
 * (`interop/contract/bunko/*.json`, written by its `contract_export` test from
 * a seeded server); the reader's tests parse those instead of hand-written
 * JSON. The reader records the requests it sends (`recordRequest`) into
 * `interop/contract/reader/*.json`, which Bunko replays (`contract_replay`).
 *
 * The fixtures are read from a Bunko checkout, never copied into this repo:
 * `BUNKO_REPO` (CI), else a sibling `mokuro-webdav-library` checkout. Without
 * one the contract tests skip with a warning; `BUNKO_CONTRACT_REQUIRED=1`
 * makes that a failure.
 *
 * Test-only: never import this from app code.
 */
import { describe } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

/** The reader repo's root (this file is `src/lib/interop/contract.ts`). */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** Bunko's sentinels (see its `interop/contract/README.md`). */
export const ISO_SENTINEL = '2000-01-01T00:00:00Z';
export const HTTP_DATE_SENTINEL = 'Sat, 01 Jan 2000 00:00:00 GMT';
export const EPOCH_S = 946684800;
export const EPOCH_MS = 946684800000;
export const ETAG_SENTINEL = '"etag"';
export const TOKEN_SENTINEL = '<token>';
/** A recorded `Content-Digest`: Bunko's replay sends the digest of its own body. */
export const DIGEST_SENTINEL = '<digest>';

export interface ContractRequest {
  method?: string;
  path?: string;
  auth?: string;
  headers?: Record<string, string>;
  body?: unknown;
  body_text?: string;
  body_cbz?: { pages: number };
  /** Files Bunko writes into a library: the path in the library. */
  file?: string;
}

/** One `interop/contract/bunko/<name>.json`. */
export interface Fixture {
  request: ContractRequest;
  status?: number;
  headers?: Record<string, string>;
  body?: any;
  body_text?: string;
}

export interface SeedUser {
  username: string;
  password: string;
  role: string;
}

export interface Seed {
  users: SeedUser[];
  library: Array<{
    series: string;
    volumes: Array<{ name: string; pages: number; mokuro: boolean }>;
  }>;
}

function hasSeed(dir: string): boolean {
  return existsSync(join(dir, 'seed.json'));
}

/** `<bunko checkout>/interop/contract`, or null when there is none. */
export function contractDir(): string | null {
  const env = process.env.BUNKO_REPO;
  if (env) {
    const dir = join(resolve(REPO_ROOT, env), 'interop', 'contract');
    return hasSeed(dir) ? dir : null;
  }
  for (const rel of [
    '../mokuro-webdav-library',
    '../../mokuro-webdav-library',
    '../../../mokuro-webdav-library'
  ]) {
    const dir = join(resolve(REPO_ROOT, rel), 'interop', 'contract');
    if (hasSeed(dir)) return dir;
  }
  return null;
}

export function hasContract(): boolean {
  return contractDir() !== null;
}

/** Throws when the contract is required (`BUNKO_CONTRACT_REQUIRED=1`, CI) and missing. */
export function requireContract(): void {
  if (process.env.BUNKO_CONTRACT_REQUIRED === '1' && !hasContract()) {
    throw new Error(
      `BUNKO_CONTRACT_REQUIRED=1 but no Bunko contract was found (BUNKO_REPO=${process.env.BUNKO_REPO ?? '<unset>'}); ` +
        'check out mokuro-bunko and point BUNKO_REPO at it'
    );
  }
}

let warned = false;

/** Warn once (per test file) that the contract tests are skipped. */
export function warnMissingContract(): void {
  if (warned || hasContract()) return;
  warned = true;
  console.warn(
    '[contract] No Bunko checkout found: the Bunko contract tests are SKIPPED. ' +
      'Set BUNKO_REPO=<path to a mokuro-webdav-library checkout> to run them.'
  );
}

/** `describe` for tests that read the contract: skipped (with one warning) without it. */
export function describeContract(name: string, fn: () => void): void {
  requireContract();
  warnMissingContract();
  describe.skipIf(!hasContract())(name, fn);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadSeed(): Seed {
  const dir = contractDir();
  if (!dir) throw new Error('no Bunko contract (see describeContract)');
  return readJson(join(dir, 'seed.json'));
}

/** Seconds/ms/ISO/HTTP-date sentinels moved so that the sentinel time is `now`. */
export function rebase<T>(value: T, now: number): T {
  const iso = new Date(Math.floor(now / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const http = new Date(now).toUTCString();
  const walk = (v: any): any => {
    if (v === EPOCH_S) return Math.floor(now / 1000);
    if (v === EPOCH_MS) return now;
    if (typeof v === 'string') {
      return v.split(ISO_SENTINEL).join(iso).split(HTTP_DATE_SENTINEL).join(http);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value);
}

/**
 * `interop/contract/bunko/<name>.json`, with its sentinel times rebased onto
 * `now` (default: the current clock), so freshness rules see a live answer.
 */
export function loadBunkoFixture(name: string, opts: { now?: number } = {}): Fixture {
  const dir = contractDir();
  if (!dir) throw new Error(`no Bunko contract to load ${name} from (see describeContract)`);
  return rebase(readJson(join(dir, 'bunko', `${name}.json`)), opts.now ?? Date.now());
}

/**
 * The body of fixture `name` rebased onto `now`; without a Bunko checkout (and
 * without `BUNKO_CONTRACT_REQUIRED=1`), `snapshot` (a copy of that body,
 * sentinels and all), with the usual warning. For hand-built test documents
 * that start from what Bunko serves.
 */
export function bunkoBody<T>(name: string, snapshot: T, now: number): T {
  requireContract();
  if (hasContract()) return loadBunkoFixture(name, { now }).body;
  warnMissingContract();
  return rebase(structuredClone(snapshot), now);
}

/**
 * `obj` with `patch` applied, where every patched field must already be in
 * `obj`: a test variation of a Bunko document fails on a field Bunko renamed
 * or dropped instead of quietly adding it back.
 */
export function editExisting<T extends object>(obj: T, patch: Partial<T>): T {
  for (const key of Object.keys(patch)) {
    if (!(key in obj)) {
      throw new Error(
        `Bunko's document has no "${key}" field (renamed or dropped?): ${JSON.stringify(obj)}`
      );
    }
  }
  return { ...obj, ...patch };
}

/** Every fixture name Bunko exported. */
export function bunkoFixtureNames(): string[] {
  const dir = contractDir();
  if (!dir) return [];
  return readdirSync(join(dir, 'bunko'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/** The fixture's answer as a fetch `Response`. */
export function fixtureResponse(fx: Fixture): Response {
  const status = fx.status ?? 200;
  const noBody = status === 204 || status === 304;
  const body = noBody
    ? null
    : fx.body !== undefined
      ? JSON.stringify(fx.body)
      : (fx.body_text ?? null);
  return new Response(body, { status, headers: fx.headers ?? {} });
}

/** A response-header reader over the fixture (case-insensitive), as XHR's. */
export function fixtureHeader(fx: Fixture): (name: string) => string | null {
  return (name) => {
    const hit = Object.entries(fx.headers ?? {}).find(
      ([k]) => k.toLowerCase() === name.toLowerCase()
    );
    return hit ? hit[1] : null;
  };
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers;
  if (!h) return null;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name);
  const hit = Object.entries(h as Record<string, string>).find(
    ([k]) => k.toLowerCase() === name.toLowerCase()
  );
  return hit ? hit[1] : null;
}

/**
 * A `fetch` that answers like the seeded Bunko did: a request matches a
 * fixture by method, path and query (and `Depth` for PROPFIND); anything else
 * is a 404. `calls` records what was asked.
 */
export function fixtureFetch(fixtures: Fixture[]) {
  const calls: Array<{ method: string; url: string; init?: RequestInit }> = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : ((input as Request).url ?? String(input))
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url: url.toString(), init });
    const depth = headerOf(init, 'depth');
    const hit = fixtures.find((fx) => {
      const r = fx.request;
      if ((r.method ?? 'GET').toUpperCase() !== method) return false;
      if (r.path !== url.pathname + url.search) return false;
      if (method === 'PROPFIND') {
        const want = Object.entries(r.headers ?? {}).find(([k]) => k === 'depth')?.[1];
        if (want !== undefined && depth !== null && want !== depth) return false;
      }
      return true;
    });
    return hit ? fixtureResponse(hit) : new Response('not in the contract', { status: 404 });
  };
  return { fetch: impl as typeof fetch, calls };
}

// ---------------------------------------------------------------- the reader's records

export interface ReaderExpect {
  status: number[];
  body_fields?: string[];
  headers?: string[];
}

export interface ReaderRecord {
  request: ContractRequest;
  expect: ReaderExpect;
  /** The record whose answer's ETag replaces the `"etag"` sentinel in this request. */
  after?: string;
}

/** What a test captured of one request the reader's code sent. */
export interface CapturedRequest {
  method: string;
  /** Absolute or root-relative URL; only the path and query are kept. */
  url: string;
  headers?: Record<string, string> | Headers;
  /** A string body (JSON is parsed), or a description of a binary one. */
  body?: string | { cbz: { pages: number } };
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])])
    );
  }
  return v;
}

function utf8Basic(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

/** `basic:<user>` / `bearer:<user>` for a seed user's header, else `raw:<value>`. */
function authOf(value: string | null, tokens: Record<string, string>, seed: Seed): string {
  if (!value) return 'none';
  for (const u of seed.users) {
    if (value === utf8Basic(u.username, u.password)) return `basic:${u.username}`;
  }
  if (value.startsWith('Bearer ')) {
    const token = value.slice('Bearer '.length).trim();
    const user = Object.entries(tokens).find(([, t]) => t === token)?.[0];
    if (user) return `bearer:${user}`;
  }
  return `raw:${value}`;
}

/** Header values with their volatile part replaced, as Bunko's normalizer does. */
function normalizeHeader(name: string, value: string): string {
  if ((name === 'if-none-match' || name === 'if-match') && value !== '*') return ETAG_SENTINEL;
  // Of the body the test sent; the replay computes it for the body it sends.
  if (name === 'content-digest') return DIGEST_SENTINEL;
  return value;
}

/** Headers never recorded: transport details, and the one carried by `auth`. */
const DROPPED_HEADERS = new Set(['authorization', 'content-length', 'host', 'user-agent']);

/** Passwords of seed users in a JSON body, back to `<password:USER>`. */
function hidePasswords(v: any, seed: Seed): any {
  if (typeof v === 'string') {
    const u = seed.users.find((x) => x.password === v);
    return u ? `<password:${u.username}>` : v;
  }
  if (Array.isArray(v)) return v.map((x) => hidePasswords(x, seed));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hidePasswords(x, seed)]));
  }
  return v;
}

/** The captured request in the record format (normalized, keys sorted). */
export function normalizeRequest(
  captured: CapturedRequest,
  opts: { tokens?: Record<string, string>; seed?: Seed } = {}
): ContractRequest {
  const seed = opts.seed ?? loadSeed();
  const url = new URL(captured.url, 'http://bunko.invalid');
  const raw: Record<string, string> = {};
  const src = captured.headers;
  if (src && typeof (src as Headers).get === 'function') {
    (src as Headers).forEach((v, k) => (raw[k.toLowerCase()] = v));
  } else if (src) {
    for (const [k, v] of Object.entries(src as Record<string, string>)) raw[k.toLowerCase()] = v;
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!DROPPED_HEADERS.has(k)) headers[k] = normalizeHeader(k, v);
  }
  const req: ContractRequest = {
    method: captured.method.toUpperCase(),
    path: url.pathname + url.search,
    auth: authOf(raw.authorization ?? null, opts.tokens ?? {}, seed),
    headers
  };
  const body = captured.body;
  if (typeof body === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && typeof parsed === 'object') req.body = hidePasswords(parsed, seed);
    else req.body_text = body.replace(/\r\n/g, '\n');
  } else if (body && typeof body === 'object' && 'cbz' in body) {
    req.body_cbz = { pages: body.cbz.pages };
  }
  return sortKeys(req);
}

function render(v: unknown): string {
  return JSON.stringify(sortKeys(v), null, 2) + '\n';
}

/**
 * Compare a record with `<contract>/reader/<name>.json`, or write it with
 * `READER_BLESS=1`. Returns null when they agree (or it was written), else
 * the message to fail with.
 */
export function recordRequest(
  name: string,
  record: { request: CapturedRequest; expect: ReaderExpect; after?: string },
  opts: { tokens?: Record<string, string> } = {}
): string | null {
  const dir = contractDir();
  if (!dir) throw new Error('no Bunko contract to record into (see describeContract)');
  const out: ReaderRecord = {
    request: normalizeRequest(record.request, { tokens: opts.tokens }),
    expect: record.expect,
    ...(record.after ? { after: record.after } : {})
  };
  const path = join(dir, 'reader', `${name}.json`);
  const want = render(out);
  if (process.env.READER_BLESS === '1') {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, want);
    return null;
  }
  if (!existsSync(path)) return `${name}.json is not recorded yet; it would be:\n${want}`;
  const have = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  if (have === want) return null;
  return (
    `${name}.json differs from what the reader sends now.\n--- recorded\n${have}\n+++ now\n${want}\n` +
    'run READER_BLESS=1 npx vitest run src/lib/interop (with BUNKO_REPO set) to accept'
  );
}
