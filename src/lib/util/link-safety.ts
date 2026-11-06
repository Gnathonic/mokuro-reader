/**
 * Where does a URL that arrived in a LINK point?
 *
 * Deep links (`#/upload?cbz=…`, `#/cloud?server=…`) carry addresses someone
 * else chose. Before the app talks to one on the user's behalf, the user sees
 * the host and is told, in plain words, when it is not a secure (https)
 * connection or when it points at their own device or local network — the two
 * cases where a link from a web page is most likely to be up to something.
 *
 * Only the address is judged; nothing here resolves DNS, so a public name that
 * resolves to a private address reads as public. The point is to describe what
 * the user is about to agree to, not to be a firewall.
 */

export type HostScope = 'public' | 'loopback' | 'private' | 'link-local';

/** Dotted-quad IPv4 → four octets, or null. Expects the WHATWG-canonical form. */
function ipv4Octets(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}

function classifyIpv4([a, b]: number[]): HostScope {
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  // Carrier-grade NAT space, which overlay VPNs hand out to home machines too.
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  // "This network" (0.0.0.0/8): not routable, reaches the local machine on some systems.
  if (a === 0) return 'private';
  return 'public';
}

/** IPv6 text (no brackets) → eight 16-bit groups, or null. */
function ipv6Groups(host: string): number[] | null {
  if (!host.includes(':')) return null;
  let text = host.toLowerCase();
  // A trailing dotted quad (::ffff:1.2.3.4) is two groups.
  const quad = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (quad) {
    const octets = ipv4Octets(quad[1]);
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = text.slice(0, quad.index) + `${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const values = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return values.some(Number.isNaN) ? null : values;
}

function classifyIpv6(groups: number[]): HostScope {
  const allZeroUpTo = (n: number) => groups.slice(0, n).every((g) => g === 0);
  if (allZeroUpTo(7) && groups[7] === 1) return 'loopback'; // ::1
  if (allZeroUpTo(8)) return 'private'; // :: (unspecified)
  // IPv4-mapped (::ffff:a.b.c.d): judged as the IPv4 address it carries.
  if (allZeroUpTo(5) && groups[5] === 0xffff) {
    return classifyIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  if ((groups[0] & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  if ((groups[0] & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfec0) return 'private'; // fec0::/10 old site-local
  return 'public';
}

/** Name suffixes that only ever mean "a machine on this network". */
const LOCAL_NAME_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.intranet', '.home.arpa'];

/**
 * Classify a hostname as `URL.hostname` gives it (IPv6 in brackets, IPv4 in
 * canonical dotted form — the URL parser already turned `0x7f.1` into
 * `127.0.0.1`). A bare name with no dot is an intranet name: private.
 */
export function classifyHost(hostname: string): HostScope {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.+$/, ''); // a fully-qualified trailing dot
  if (host === '') return 'private';

  const v4 = ipv4Octets(host);
  if (v4) return classifyIpv4(v4);
  const v6 = ipv6Groups(host);
  if (v6) return classifyIpv6(v6);

  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (!host.includes('.')) return 'private';
  if (LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'private';
  return 'public';
}

export interface LinkTarget {
  /** The URL, normalised by the URL parser. */
  url: string;
  /** Host with its port when it has one — what the user is shown. */
  host: string;
  /** `https:` or not. */
  secure: boolean;
  scope: HostScope;
}

/** A link's http(s) URL, judged; null when it is not one (unparseable, or another scheme). */
export function describeLinkTarget(raw: string, base?: string): LinkTarget | null {
  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return {
    url: url.toString(),
    host: url.host,
    secure: url.protocol === 'https:',
    scope: classifyHost(url.hostname)
  };
}

/**
 * The plain-words warnings for one target — empty for a public https host.
 * Plain http to this device itself is not called insecure: that traffic never
 * leaves the machine, and the loopback warning already says where it goes.
 */
export function linkTargetWarnings(target: LinkTarget): string[] {
  const warnings: string[] = [];
  if (!target.secure && target.scope !== 'loopback') {
    warnings.push(
      `${target.host} does not use a secure connection (https). What is downloaded from it could be read or changed on the way.`
    );
  }
  switch (target.scope) {
    case 'loopback':
      warnings.push(
        `${target.host} is this device itself. A link from a website should not normally point here.`
      );
      break;
    case 'private':
      warnings.push(
        `${target.host} is a private address — a machine on your own network, not on the public internet. A link from a website should not normally point there.`
      );
      break;
    case 'link-local':
      warnings.push(
        `${target.host} is a link-local address — a device connected directly to your network. A link from a website should not normally point there.`
      );
      break;
    case 'public':
      break;
  }
  return warnings;
}

/**
 * May a LINK fill this server address into a login form? https anywhere, plain
 * http only on this device. A LAN http server is legitimate, but the user has
 * to type it: a link that pre-fills one is the shape of a credential grab
 * (the password would travel in the clear to whatever the link named).
 */
export function linkMayPrefillServer(target: LinkTarget): boolean {
  return target.secure || target.scope === 'loopback';
}

/** What a `#/cloud?server=…&username=…` link may put into the WebDAV login form. */
export interface CloudLinkPrefill {
  /** The server address to fill in, with the host to name in the banner. */
  server?: { url: string; host: string };
  /**
   * Only with an accepted server: the banner that names the server is what
   * tells the user the link filled the form in.
   */
  username?: string;
  /**
   * A server address the link carried that was NOT filled in, and why. `value`
   * is only the scheme and host of an insecure one (what the banner names) —
   * never the rest of the link's text.
   */
  refused?: { value: string; reason: 'insecure' | 'invalid' };
}

/**
 * Read the WebDAV prefill a cloud link carries; null when it carries none.
 * Nothing here logs in: the form is only filled, and the password never comes
 * from a link. A refused server takes its username with it — the name belongs
 * to that server, not to whatever the user types instead — and so does no
 * server at all: a username alone would land, unannounced, beside the server
 * the form remembers from the user's last session, a pairing the link chose.
 */
export function parseCloudLinkPrefill(hash: string): CloudLinkPrefill | null {
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return null;
  const params = new URLSearchParams(hash.slice(queryIndex + 1));
  const server = params.get('server')?.trim() || '';
  const username = params.get('username') || '';
  if (!server) return null;

  const target = describeLinkTarget(server);
  if (!target) return { refused: { value: '', reason: 'invalid' } };
  if (!linkMayPrefillServer(target)) {
    return { refused: { value: `http://${target.host}`, reason: 'insecure' } };
  }
  return {
    // The link's own spelling, not the parser's: it is what the user would have typed.
    server: { url: server, host: target.host },
    ...(username ? { username } : {})
  };
}

/**
 * Did a redirect take a link's request somewhere the user was not shown?
 *
 * The confirmation judged the address the LINK named; `fetch` follows
 * redirects without asking, so a public https server answering 302 with a
 * private or plain-http address would otherwise have that address's answer
 * read and imported unannounced. The browser has already sent the redirected
 * request by the time this is asked: what is refused is reading and importing
 * the response, not the request. A redirect may go anywhere that is no worse
 * than what was shown: another public https server (a CDN) is fine; plain
 * http after https is not, and neither is a private, link-local or loopback
 * address the dialog did not name. Null when the final address is acceptable, else why not, in words.
 */
export function redirectEscape(requested: string, final: string): string | null {
  const from = describeLinkTarget(requested);
  const to = describeLinkTarget(final);
  if (!to) return 'it was redirected to an address that is not a web address';
  if (!from || to.url === from.url) return null;
  if (from.secure && !to.secure) {
    return `it was redirected from a secure (https) address to ${to.host}, which is not secure`;
  }
  if (to.scope !== 'public' && to.host !== from.host) {
    return `it was redirected to ${to.host}, an address on this device or your own network`;
  }
  return null;
}

/**
 * Throw when `response` came back through a redirect `redirectEscape` refuses,
 * so its body is never read or imported (the redirected request itself has
 * already gone out). Call it on every response to a URL a link (or a link's
 * manifest) chose, before its body is used.
 */
export function assertNoRedirectEscape(requested: string, response: Response): void {
  if (!response.redirected || !response.url) return;
  const reason = redirectEscape(requested, response.url);
  if (reason) throw new Error(`Refused ${requested}: ${reason}`);
}
