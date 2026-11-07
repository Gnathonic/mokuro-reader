import { describe, expect, it } from 'vitest';
import {
  classifyHost,
  describeLinkTarget,
  linkMayPrefillServer,
  linkTargetWarnings,
  parseCloudLinkPrefill,
  redirectEscape,
  assertNoRedirectEscape
} from './link-safety';

/** What the URL parser hands the classifier for this link host. */
const hostOf = (url: string) => new URL(url).hostname;

describe('classifyHost', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.8.9.10', 'loopback'],
    ['localhost', 'loopback'],
    ['LOCALHOST.', 'loopback'],
    ['app.localhost', 'loopback'],
    ['[::1]', 'loopback'],
    ['::1', 'loopback'],
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.20', 'private'],
    ['100.64.0.1', 'private'],
    ['0.0.0.0', 'private'],
    ['[fd12:3456::1]', 'private'],
    ['[fc00::1]', 'private'],
    ['[::]', 'private'],
    ['nas', 'private'],
    ['nas.local', 'private'],
    ['files.home.arpa', 'private'],
    ['server.lan', 'private'],
    ['169.254.10.1', 'link-local'],
    ['[fe80::1]', 'link-local'],
    ['[febf::1]', 'link-local'],
    ['example.com', 'public'],
    ['8.8.8.8', 'public'],
    ['172.32.0.1', 'public'],
    ['172.15.0.1', 'public'],
    ['100.128.0.1', 'public'],
    ['192.169.0.1', 'public'],
    ['[2001:db8::1]', 'public'],
    ['localhost.example.com', 'public']
  ])('%s is %s', (host, scope) => {
    expect(classifyHost(host)).toBe(scope);
  });

  it('sees through the spellings the URL parser canonicalises', () => {
    // Hex, octal-ish and shortened IPv4 all reach the classifier as dotted quads.
    expect(classifyHost(hostOf('http://0x7f.1/'))).toBe('loopback');
    expect(classifyHost(hostOf('http://2130706433/'))).toBe('loopback');
    expect(classifyHost(hostOf('http://0xc0.0xa8.1.1/'))).toBe('private');
    // IPv4-mapped IPv6 is judged as the IPv4 address inside it.
    expect(classifyHost(hostOf('http://[::ffff:127.0.0.1]/'))).toBe('loopback');
    expect(classifyHost(hostOf('http://[::ffff:192.168.0.9]/'))).toBe('private');
    expect(classifyHost(hostOf('http://[::ffff:8.8.8.8]/'))).toBe('public');
    expect(classifyHost(hostOf('http://[0:0:0:0:0:0:0:1]/'))).toBe('loopback');
  });
});

describe('describeLinkTarget', () => {
  it('names the host with its port, and whether the connection is secure', () => {
    expect(describeLinkTarget('https://example.com:8443/a/b.cbz')).toEqual({
      url: 'https://example.com:8443/a/b.cbz',
      host: 'example.com:8443',
      secure: true,
      scope: 'public'
    });
    expect(describeLinkTarget('http://192.168.1.5/x')).toMatchObject({
      host: '192.168.1.5',
      secure: false,
      scope: 'private'
    });
  });

  it('shows an internationalised name in its ASCII form, so a look-alike cannot pose as another', () => {
    expect(describeLinkTarget('https://exаmple.com/')?.host).toBe('xn--exmple-4nf.com');
  });

  it('resolves a relative URL against a base', () => {
    expect(describeLinkTarget('/lib/x.cbz', 'https://example.com/#/upload')?.host).toBe(
      'example.com'
    );
  });

  it('is null for anything that is not an http(s) URL', () => {
    expect(describeLinkTarget('not a url')).toBeNull();
    expect(describeLinkTarget('javascript:alert(1)')).toBeNull();
    expect(describeLinkTarget('data:application/zip;base64,AAAA')).toBeNull();
    expect(describeLinkTarget('ftp://example.com/x')).toBeNull();
    expect(describeLinkTarget('file:///etc/passwd')).toBeNull();
  });
});

describe('linkTargetWarnings', () => {
  const warn = (url: string) => linkTargetWarnings(describeLinkTarget(url)!);

  it('has nothing to say about a public https host', () => {
    expect(warn('https://example.com/a.cbz')).toEqual([]);
  });

  it('says in plain words when the connection is not secure', () => {
    const [warning] = warn('http://example.com/a.cbz');
    expect(warning).toContain('example.com');
    expect(warning).toContain('secure connection (https)');
  });

  it('says when a link points at this device, without calling loopback http insecure', () => {
    const warnings = warn('http://127.0.0.1:9090/a.cbz');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('127.0.0.1:9090 is this device itself');
  });

  it('says when a link points into the local network — both warnings for plain http there', () => {
    const warnings = warn('http://192.168.1.20/a.cbz');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('secure connection');
    expect(warnings[1]).toContain('private address');
    expect(warnings[1]).toContain('your own network');
    expect(warn('https://[fe80::1]/a.cbz')[0]).toContain('link-local address');
  });
});

describe('linkMayPrefillServer', () => {
  const may = (url: string) => linkMayPrefillServer(describeLinkTarget(url)!);

  it('allows https anywhere, and plain http only on this device', () => {
    expect(may('https://dav.example.com/remote.php/dav')).toBe(true);
    expect(may('https://192.168.1.20/dav')).toBe(true);
    expect(may('http://localhost:9090')).toBe(true);
    expect(may('http://127.0.0.1:9090')).toBe(true);
    expect(may('http://[::1]:9090')).toBe(true);
    expect(may('http://192.168.1.20/dav')).toBe(false);
    expect(may('http://nas.local/dav')).toBe(false);
    expect(may('http://dav.example.com/dav')).toBe(false);
  });
});

describe('parseCloudLinkPrefill', () => {
  it('is null for a cloud link that carries nothing', () => {
    expect(parseCloudLinkPrefill('#/cloud')).toBeNull();
    expect(parseCloudLinkPrefill('#/cloud?other=1')).toBeNull();
  });

  it('fills an https server and the username, naming the host for the banner', () => {
    const server = 'https://dav.example.com:8443/remote.php/dav';
    expect(
      parseCloudLinkPrefill(`#/cloud?server=${encodeURIComponent(server)}&username=reader`)
    ).toEqual({
      server: { url: server, host: 'dav.example.com:8443' },
      username: 'reader'
    });
  });

  it('fills plain http on this device', () => {
    expect(parseCloudLinkPrefill('#/cloud?server=http://localhost:9090')?.server).toEqual({
      url: 'http://localhost:9090',
      host: 'localhost:9090'
    });
  });

  it('refuses plain http anywhere else, and drops the username that came with it', () => {
    expect(
      parseCloudLinkPrefill(
        `#/cloud?server=${encodeURIComponent('http://192.168.1.20/dav?x=Trust me')}&username=bob`
      )
    ).toEqual({ refused: { value: 'http://192.168.1.20', reason: 'insecure' } });
  });

  it('refuses what is not a web address at all', () => {
    expect(parseCloudLinkPrefill('#/cloud?server=javascript:alert(1)')).toEqual({
      refused: { value: '', reason: 'invalid' }
    });
    expect(parseCloudLinkPrefill('#/cloud?server=nas.local')).toEqual({
      refused: { value: '', reason: 'invalid' }
    });
  });

  it('fills nothing from a bare username: no server, no banner, no silent pairing', () => {
    // The form would pair it with the server remembered from the last session.
    expect(parseCloudLinkPrefill('#/cloud?username=reader')).toBeNull();
    expect(parseCloudLinkPrefill('#/cloud?server=&username=reader')).toBeNull();
  });
});

describe('redirectEscape', () => {
  it.each([
    ['https://a.example/x', 'https://a.example/x'],
    ['https://a.example/x', 'https://cdn.example/y'],
    ['http://a.example/x', 'https://a.example/x'],
    ['http://192.168.1.2/x', 'http://192.168.1.2/y'],
    ['http://localhost:9090/x', 'http://localhost:9090/y']
  ])('lets %s go on to %s', (from, to) => {
    expect(redirectEscape(from, to)).toBeNull();
  });

  it('refuses plain http after https, even on the same host', () => {
    expect(redirectEscape('https://a.example/x', 'http://a.example/x')).toContain(
      'from a secure (https) address to a.example'
    );
  });

  it.each(['https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://[fe80::1]/x', 'https://nas/x'])(
    'refuses a public host handing the fetch to %s',
    (to) => {
      expect(redirectEscape('https://a.example/x', to)).toContain(
        'an address on this device or your own network'
      );
    }
  );

  it('refuses one private host handing the fetch to another the dialog never named', () => {
    expect(redirectEscape('http://192.168.1.2/x', 'http://192.168.1.3/x')).toContain('192.168.1.3');
  });

  it('refuses a landing that is not a web address at all', () => {
    expect(redirectEscape('https://a.example/x', 'file:///etc/passwd')).toContain(
      'not a web address'
    );
  });
});

describe('assertNoRedirectEscape', () => {
  function response(redirected: boolean, url: string): Response {
    const r = new Response('x');
    Object.defineProperty(r, 'redirected', { value: redirected });
    Object.defineProperty(r, 'url', { value: url });
    return r;
  }

  it('passes a response that was never redirected', () => {
    expect(() =>
      assertNoRedirectEscape('https://a.example/x', response(false, 'http://10.0.0.1/'))
    ).not.toThrow();
  });

  it('throws, naming the requested URL and why, for a refused redirect', () => {
    expect(() =>
      assertNoRedirectEscape('https://a.example/x', response(true, 'http://10.0.0.1/'))
    ).toThrow('Refused https://a.example/x: it was redirected from a secure (https) address');
  });
});
