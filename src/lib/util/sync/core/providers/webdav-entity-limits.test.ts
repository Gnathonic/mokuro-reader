import { afterEach, describe, expect, it, vi } from 'vitest';

// The `webdav` library binds `fetch` when it loads: a delegating stub goes in
// before it is imported, and each test points it at its own response.
const fetchHandler = vi.hoisted(() => {
  const state: { body: string | null } = { body: null };
  const delegate = (async () => {
    if (state.body === null) throw new Error('fetch called without a response');
    return new Response(state.body, {
      status: 207,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' }
    });
  }) as typeof fetch;
  globalThis.fetch = delegate;
  if (typeof window !== 'undefined') window.fetch = delegate;
  return state;
});

import { createClient } from 'webdav';
import { WEBDAV_ENTITY_LIMITS, webdavAuthOptions } from './webdav-auth';

const SERVER = 'https://dav.example.test/';

/** A PROPFIND answer listing one folder per name; names are XML text as sent. */
function multistatus(names: string[], doctype = ''): string {
  const responses = names
    .map(
      (name) => `<d:response>
    <d:href>/mokuro-reader/${name.replaceAll(' ', '%20')}/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>${name}</d:displayname>
        <d:resourcetype><d:collection/></d:resourcetype>
        <d:getlastmodified>Mon, 02 Nov 2026 10:00:00 GMT</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>${doctype}
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/mokuro-reader/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  ${responses}
</d:multistatus>`;
}

afterEach(() => {
  fetchHandler.body = null;
});

describe('webdavAuthOptions entity limits', () => {
  it('gives every client the entity limits, with or without credentials', () => {
    expect(webdavAuthOptions('user', 'pw').entityDecoder).toEqual(WEBDAV_ENTITY_LIMITS);
    expect(webdavAuthOptions(undefined, undefined).entityDecoder).toEqual(WEBDAV_ENTITY_LIMITS);
    expect(webdavAuthOptions('', '', {}, 'tok').entityDecoder).toEqual(WEBDAV_ENTITY_LIMITS);
    // Non-zero: 0 means "unlimited" to the decoder.
    expect(WEBDAV_ENTITY_LIMITS.limit.maxTotalExpansions).toBeGreaterThan(0);
    expect(WEBDAV_ENTITY_LIMITS.limit.maxExpandedLength).toBeGreaterThan(0);
  });

  it('lets a caller override the limits through extra', () => {
    const custom = { limit: { maxTotalExpansions: 5, maxExpandedLength: 50 } };
    expect(webdavAuthOptions('user', 'pw', { entityDecoder: custom }).entityDecoder).toBe(custom);
  });

  it('keeps the limits when extra carries entityDecoder: undefined', () => {
    const withToken = webdavAuthOptions('', '', { entityDecoder: undefined }, 'tok');
    const anonymous = webdavAuthOptions(undefined, undefined, { entityDecoder: undefined });
    expect(withToken.entityDecoder).toEqual(WEBDAV_ENTITY_LIMITS);
    expect(anonymous.entityDecoder).toEqual(WEBDAV_ENTITY_LIMITS);
  });
});

describe('the webdav client the reader builds', () => {
  it('parses an ordinary listing and decodes &amp; and numeric references', async () => {
    fetchHandler.body = multistatus(['Tom &amp; Jerry', '&#x65E5;&#x672C;&#x8A9E;', 'Plain']);
    const client = createClient(SERVER, webdavAuthOptions('user', 'pw'));

    const entries = await client.getDirectoryContents('/mokuro-reader/');

    expect(entries.map((e) => e.basename).sort()).toEqual(['Plain', 'Tom & Jerry', '日本語']);
  });

  it('parses many escaped names in one listing: predefined entities are not limited', async () => {
    const names = Array.from({ length: 1500 }, (_, i) => `A &amp; B ${i}`);
    fetchHandler.body = multistatus(names);
    const client = createClient(SERVER, webdavAuthOptions('user', 'pw'));

    const entries = await client.getDirectoryContents('/mokuro-reader/');

    expect(entries).toHaveLength(1500);
  });

  it('applies the configured expansion-length limit, not only the parser default', async () => {
    // WEBDAV_ENTITY_LIMITS' length cap equals fast-xml-parser's built-in
    // 100 000-character default, so a body over it fails with or without our
    // decoder and proves nothing. A tighter cap passed through `extra` does:
    // ~10 KB of expansion is fine by the defaults and refused only if the
    // configured decoder is what the parser actually uses.
    const doctype = `<!DOCTYPE d:multistatus [<!ENTITY big "${'x'.repeat(1000)}">]>`;
    const body = multistatus(['&big;'.repeat(10)], doctype);

    fetchHandler.body = body;
    const defaults = createClient(SERVER, webdavAuthOptions('user', 'pw'));
    const parsed = await defaults.getDirectoryContents('/mokuro-reader/');
    expect(parsed.map((e) => e.basename)).toContain('x'.repeat(10_000));

    fetchHandler.body = body;
    const tight = { limit: { maxTotalExpansions: 1000, maxExpandedLength: 5000 } };
    const limited = createClient(SERVER, webdavAuthOptions('user', 'pw', { entityDecoder: tight }));
    await expect(limited.getDirectoryContents('/mokuro-reader/')).rejects.toThrow(
      /limit exceeded/i
    );
  });

  it('refuses a response that references a declared entity too many times', async () => {
    const doctype = '<!DOCTYPE d:multistatus [<!ENTITY e "y">]>';
    fetchHandler.body = multistatus(['&e;'.repeat(2000)], doctype);
    const client = createClient(SERVER, webdavAuthOptions('user', 'pw'));

    await expect(client.getDirectoryContents('/mokuro-reader/')).rejects.toThrow(/limit exceeded/i);
  });
});
