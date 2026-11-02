import type { Route } from '@playwright/test';

/**
 * A tiny in-memory WebDAV server for e2e specs, served through `page.route`
 * (`context.route` shares one between devices). Binary bodies go through
 * `postDataBuffer()` — a string round-trip corrupts compressed history files.
 * Answers 404 for bunko's `/login/api/me`, so the client treats it as plain
 * WebDAV.
 */

const ROOT = '/mokuro-reader';

interface StubEntry {
  dir: boolean;
  body: Buffer;
  mtime: string;
}

/** A tiny in-memory WebDAV server behind `page.route` that logs every request. */
export class WebDavStub {
  files = new Map<string, StubEntry>();
  log: Array<{ method: string; path: string }> = [];

  constructor() {
    this.dir('/');
    this.dir(ROOT);
  }
  dir(path: string) {
    this.files.set(this.norm(path), {
      dir: true,
      body: Buffer.alloc(0),
      mtime: new Date().toUTCString()
    });
  }
  file(path: string, body: Buffer, mtime: string) {
    const p = this.norm(path);
    this.dir(p.slice(0, p.lastIndexOf('/')) || '/');
    this.files.set(p, { dir: false, body, mtime });
  }
  norm(path: string): string {
    const decoded = decodeURIComponent(path).replace(/\/+$/, '');
    return decoded === '' ? '/' : decoded;
  }
  private children(path: string, deep: boolean): string[] {
    const prefix = path === '/' ? '/' : `${path}/`;
    return [...this.files.keys()].filter(
      (p) => p !== path && p.startsWith(prefix) && (deep || !p.slice(prefix.length).includes('/'))
    );
  }
  private multistatus(paths: string[]): string {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const responses = paths.map((p) => {
      const e = this.files.get(p)!;
      const href = e.dir && p !== '/' ? `${p}/` : p;
      return (
        `<d:response><d:href>${esc(encodeURI(href))}</d:href><d:propstat><d:prop>` +
        `<d:resourcetype>${e.dir ? '<d:collection/>' : ''}</d:resourcetype>` +
        `<d:getcontentlength>${e.dir ? 0 : Buffer.byteLength(e.body)}</d:getcontentlength>` +
        `<d:getlastmodified>${e.mtime}</d:getlastmodified>` +
        `<d:getcontenttype>${e.dir ? 'httpd/unix-directory' : 'application/octet-stream'}</d:getcontenttype>` +
        `<d:displayname>${esc(p.split('/').pop() ?? '')}</d:displayname>` +
        `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
      );
    });
    return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`;
  }
  gets(path: string): number {
    return this.log.filter((l) => l.method === 'GET' && l.path === path).length;
  }
  handle = async (route: Route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = this.norm(url.pathname);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods':
        'GET, HEAD, PUT, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*'
    };
    const reply = (
      status: number,
      body: string | Buffer = '',
      headers: Record<string, string> = {}
    ) => route.fulfill({ status, body, headers: { ...cors, ...headers } });

    if (url.pathname.endsWith('/login/api/me')) return reply(404, 'not bunko');
    if (method === 'OPTIONS') {
      return reply(200, '', {
        DAV: '1,2',
        Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, PROPFIND'
      });
    }
    this.log.push({ method, path });
    const entry = this.files.get(path);
    switch (method) {
      case 'PROPFIND': {
        if (!entry) return reply(404);
        const depth = (request.headers()['depth'] ?? '1').toLowerCase();
        const paths =
          depth === '0'
            ? [path]
            : [path, ...this.children(path, depth === 'infinity')].filter((p) => this.files.has(p));
        return reply(207, this.multistatus(paths), { 'Content-Type': 'application/xml' });
      }
      case 'HEAD':
      case 'GET': {
        if (!entry || entry.dir) return reply(404);
        return reply(200, method === 'GET' ? entry.body : Buffer.alloc(0), {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(Buffer.byteLength(entry.body))
        });
      }
      case 'MKCOL': {
        this.dir(path);
        return reply(201);
      }
      case 'PUT': {
        this.file(path, request.postDataBuffer() ?? Buffer.alloc(0), new Date().toUTCString());
        return reply(201);
      }
      case 'DELETE': {
        if (!entry) return reply(404);
        for (const p of [path, ...this.children(path, true)]) this.files.delete(p);
        return reply(204);
      }
      default:
        return reply(405);
    }
  };
}
