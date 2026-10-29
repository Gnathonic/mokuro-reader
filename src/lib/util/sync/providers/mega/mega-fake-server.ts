/**
 * TEST-ONLY fake MEGA backend at the HTTP level.
 *
 * Installed through megajs's static `API.fetchModule` (what every API
 * instance's defaultFetch calls), so the REAL megajs request/pull/reload/
 * _importFile/sc handling all run against it — only the network is fake.
 *
 * - `/cs` takes megajs's JSON array body and dispatches on `a`:
 *   `f` (full tree incl. `sn`; with `n` a subtree listing, no `sn`),
 *   `p` (mkdir / upload completion), `u` (upload URL), `g` (download URL),
 *   `d`, `m`, `a`, `ug`,
 *   `uq`, `sml`.
 * - `/sc` is the long-poll: a poll with sequence number X answers with the
 *   next action-packet batch after X, or stays open until one exists. Every
 *   open poll is recorded per session, so a test can count concurrent loops.
 * - `/ul/<id>/<pos>` takes the encrypted upload chunks and returns the
 *   completion token on the last one; `g` hands out `/dl/<handle>`, which
 *   serves those same encrypted bytes by `<start>-<end>` range.
 *
 * Nodes carry exactly what clients sent: a mkdir/upload echoes the client's
 * encrypted `a` and `k` back (k as `<user>:<k>`), so real megajs decrypts real
 * names. The server never knows a name in clear; `tree()` reads the server
 * state through a fresh observer Storage, i.e. through megajs's own crypto.
 *
 * Interleaving: `hold(match)` parks the response to the next matching request
 * (its result is computed when it ARRIVES — the server has processed it — and
 * delivered on `release()`), `withholdSc()` creates nodes without telling
 * anyone yet (a packet still in flight), `pushPackets()` injects a raw batch.
 */
import { API, Storage } from 'megajs';

/** The account's user handle; node keys are `<user>:<key>`. */
export const FAKE_USER = 'FAKEUSER0001';
/** 16 zero bytes, MEGA base64. Every session of the account shares it. */
export const FAKE_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAA';
/** The session under test. */
export const CLIENT_SID = 'client-session';
/** "Another device" / observer sessions. Never matched by default holds. */
export const OTHER_SID = 'other-device-session';

const GATEWAY = 'https://g.api.mega.co.nz/';

export interface ServerNode {
  h: string;
  p: string;
  u: string;
  t: number;
  a: string;
  k: string;
  s?: number;
  ts: number;
}

export interface CsRequest {
  sid: string | null;
  body: Record<string, any>;
}

interface Poll {
  sid: string;
  seq: number;
  settled: boolean;
  resolve: (body: unknown) => void;
  reject: (error: Error) => void;
}

interface Hold {
  match: (req: CsRequest) => boolean;
  consumed: boolean;
  arrivedResolve: () => void;
  arrived: Promise<void>;
  released: Promise<void>;
  release: () => void;
}

export interface HeldResponse {
  /** Resolves once the matching request reached the server (and was processed). */
  arrived: Promise<void>;
  /** Deliver the parked response. */
  release(): void;
}

/** A node as a fresh client decrypts it. */
export interface TreeNode {
  handle: string;
  name: string;
  path: string;
  parent: string | null;
  directory: boolean;
  timestamp: number;
}

export class ServerTree {
  constructor(readonly nodes: TreeNode[]) {}

  /** Every path under the Cloud Drive, one entry per node (duplicates repeat). */
  paths(): string[] {
    return this.nodes.map((n) => n.path).sort();
  }

  count(path: string): number {
    return this.nodes.filter((n) => n.path === path).length;
  }

  find(path: string): TreeNode[] {
    return this.nodes.filter((n) => n.path === path);
  }

  byHandle(handle: string): TreeNode | undefined {
    return this.nodes.find((n) => n.handle === handle);
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function response(body: unknown) {
  // Deep copy: megajs mutates the node objects it is handed (MutableFile
  // rewrites opt.k), and the server's own records must not change with it.
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => JSON.parse(text),
    arrayBuffer: async () => new TextEncoder().encode(text).buffer
  };
}

function bytesResponse(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => {
      throw new Error('not json');
    },
    arrayBuffer: async () => bytes.slice().buffer
  };
}

export class FakeMegaServer {
  /** Insertion order is listing order (what `f` returns). */
  readonly nodes = new Map<string, ServerNode>();
  readonly rootHandle = 'ROOTNODE';
  readonly trashHandle = 'TRASHNODE';
  readonly inboxHandle = 'INBOXNODE';
  /** Server clock (epoch seconds) stamped on every created node; settable. */
  clock = 1_780_000_000;
  /** Every /cs request, in arrival order. */
  readonly requests: CsRequest[] = [];

  private batches: { seq: number; packets: any[] }[] = [];
  private seq = 1;
  private polls: Poll[] = [];
  private holds: Hold[] = [];
  private uploadSessions = new Map<
    string,
    { size: number; received: number; token: string; chunks: Map<number, Uint8Array> }
  >();
  private completedUploads = new Map<string, Uint8Array>();
  /** A file node's encrypted content, exactly as its uploader sent it. */
  private contents = new Map<string, Uint8Array>();
  private withheld: any[][] | null = null;
  private nextId = 1;
  private shutDown = false;
  private previousFetchModule: unknown;

  constructor() {
    for (const [h, t] of [
      [this.rootHandle, 2],
      [this.inboxHandle, 3],
      [this.trashHandle, 4]
    ] as const) {
      this.nodes.set(h, { h, p: '', u: FAKE_USER, t, a: '', k: '', ts: this.clock });
    }
  }

  /** Route every megajs API instance's HTTP through this server. */
  install(): this {
    this.previousFetchModule = (API as any).fetchModule;
    (API as any).fetchModule = (url: string, opts: any) => this.fetch(url, opts);
    return this;
  }

  /** End every open poll (as an abort, which megajs ignores) and restore fetch. */
  uninstall(): void {
    this.shutDown = true;
    for (const poll of this.polls) {
      if (poll.settled) continue;
      poll.settled = true;
      poll.reject(abortError());
    }
    (API as any).fetchModule = this.previousFetchModule;
  }

  /** The session blob MegaProvider persists (`mega_session`) for the client session. */
  sessionBlob(): Record<string, unknown> {
    return {
      key: FAKE_MASTER_KEY,
      sid: CLIENT_SID,
      name: 'Fake User',
      user: FAKE_USER,
      options: { email: 'reader@example.com', keepalive: true }
    };
  }

  // ---------------------------------------------------------------- inspection

  /** sc long-polls currently open for a session: one per running sc loop. */
  openPolls(sid = CLIENT_SID): number {
    return this.polls.filter((p) => !p.settled && p.sid === sid).length;
  }

  /** The server's tree, decrypted by a fresh client of the same account. */
  async tree(): Promise<ServerTree> {
    const storage = await this.freshStorage();
    const nodes: TreeNode[] = [];
    const pathOf = (file: any): string | null => {
      const parts: string[] = [];
      let current = file;
      while (current && current !== storage.root) {
        if (!current.parent) return null; // not under the Cloud Drive
        parts.unshift(current.name);
        current = current.parent;
      }
      return current === storage.root ? parts.join('/') : null;
    };
    for (const file of Object.values(storage.files) as any[]) {
      if (file === storage.root) continue;
      const path = pathOf(file);
      if (path === null) continue;
      nodes.push({
        handle: file.nodeId,
        name: file.name,
        path,
        parent: file.parent?.nodeId ?? null,
        directory: !!file.directory,
        timestamp: file.timestamp
      });
    }
    return new ServerTree(nodes);
  }

  // ------------------------------------------------------------ interleaving

  /** Park the response to the next request matching `match` until release(). */
  hold(match: (req: CsRequest) => boolean): HeldResponse {
    let arrivedResolve!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((r) => (arrivedResolve = r));
    const released = new Promise<void>((r) => (release = r));
    const hold: Hold = { match, consumed: false, arrivedResolve, arrived, released, release };
    this.holds.push(hold);
    return { arrived, release };
  }

  /** Hold the client session's next FULL tree load (`a:'f'` without `n`). */
  holdNextFullLoad(): HeldResponse {
    return this.hold((req) => req.sid === CLIENT_SID && req.body.a === 'f' && !req.body.n);
  }

  /**
   * Run `action` with action packets withheld: the server changes, nobody is
   * told yet (a packet still in flight). Returns a release that publishes them
   * — as one sc batch with `oneBatch`, the way real MEGA answers a poll that
   * fell behind (a sleeping device, a new poll from an older snapshot).
   */
  async withholdSc(
    action: () => Promise<void>,
    { oneBatch = false }: { oneBatch?: boolean } = {}
  ): Promise<() => void> {
    const captured: any[][] = [];
    this.withheld = captured;
    try {
      await action();
    } finally {
      this.withheld = null;
    }
    return () => {
      if (oneBatch) this.publish(captured.flat());
      else for (const packets of captured) this.publish(packets);
    };
  }

  /** Publish a raw action-packet batch to every session. */
  pushPackets(packets: any[]): void {
    this.publish(packets);
  }

  /**
   * Answer `f` with `n` (a subtree listing) with the WHOLE tree, as a server
   * that ignores `n` would — callers must not trust the scoping.
   */
  subtreeFetchReturnsAll = false;

  /**
   * While set, every NEW sc long-poll of `sid` fails on arrival (a middlebox
   * rejecting /sc while /cs works); null lets polls through again.
   */
  rejectPollsOf: string | null = null;

  /** Fail a session's open sc long-polls the way a dropped connection does. */
  failPolls(sid = CLIENT_SID): void {
    for (const poll of this.polls) {
      if (poll.settled || poll.sid !== sid) continue;
      poll.settled = true;
      poll.reject(new TypeError('Failed to fetch'));
    }
  }

  /** Let in-flight fetches, polls and their megajs handlers run. */
  async flush(rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  }

  // ------------------------------------------------------------ other device

  /**
   * A fresh session of the same account ("another device"): a real megajs
   * Storage with the tree loaded, so its mkdir/upload encrypt names for real.
   */
  async otherDevice(): Promise<OtherDevice> {
    return new OtherDevice(await this.freshStorage());
  }

  async freshStorage(): Promise<any> {
    const storage: any = Storage.fromJSON({
      key: FAKE_MASTER_KEY,
      sid: OTHER_SID,
      name: 'Other',
      user: FAKE_USER,
      options: { keepalive: false }
    } as any);
    await storage.reload(true);
    storage.status = 'ready';
    return storage;
  }

  // ------------------------------------------------------------------ HTTP

  private async fetch(url: string, opts: any = {}): Promise<any> {
    if (this.shutDown) return new Promise(() => {});
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === '/cs') return this.handleCs(parsed, opts);
    if (path === '/sc') return this.handleSc(parsed, opts);
    if (path.startsWith('/ul/')) return this.handleUploadChunk(path, opts);
    if (path.startsWith('/dl/')) return this.handleDownload(path);
    throw new Error(`FakeMegaServer: unexpected URL ${url}`);
  }

  private async handleCs(url: URL, opts: any): Promise<any> {
    const [body] = JSON.parse(String(opts.body));
    const req: CsRequest = { sid: url.searchParams.get('sid'), body };
    this.requests.push(req);
    const result = this.dispatch(req);
    const hold = this.holds.find((h) => !h.consumed && h.match(req));
    if (hold) {
      hold.consumed = true;
      hold.arrivedResolve();
      await hold.released;
    }
    if (this.shutDown) return new Promise(() => {});
    return response([result]);
  }

  private handleSc(url: URL, opts: any): Promise<any> {
    const sid = url.searchParams.get('sid') ?? '';
    const seq = Number(String(url.searchParams.get('sn')).replace(/^sn/, ''));
    if (sid === this.rejectPollsOf) return Promise.reject(new TypeError('Failed to fetch'));
    return new Promise((resolve, reject) => {
      const poll: Poll = { sid, seq, settled: false, resolve, reject };
      this.polls.push(poll);
      opts.signal?.addEventListener?.('abort', () => {
        if (poll.settled) return;
        poll.settled = true;
        reject(abortError());
      });
      this.answerPoll(poll);
    });
  }

  private answerPoll(poll: Poll): void {
    if (poll.settled) return;
    const next = this.batches.find((b) => b.seq > poll.seq);
    if (!next) return;
    poll.settled = true;
    poll.resolve(response({ a: next.packets, sn: `sn${next.seq}` }));
  }

  private publish(packets: any[]): void {
    if (this.withheld) {
      this.withheld.push(packets);
      return;
    }
    this.seq += 1;
    this.batches.push({ seq: this.seq, packets: JSON.parse(JSON.stringify(packets)) });
    for (const poll of this.polls) this.answerPoll(poll);
  }

  private handleUploadChunk(path: string, opts: any): any {
    const id = path.split('/')[2];
    const session = this.uploadSessions.get(id);
    if (!session) return { ...bytesResponse(new Uint8Array()), ok: false, status: 404 };
    const chunk = new Uint8Array(opts.body ?? new Uint8Array());
    session.chunks.set(Number(path.split('/')[3] ?? 0), chunk);
    session.received += chunk.length;
    if (session.received < session.size) return bytesResponse(new Uint8Array());
    const content = new Uint8Array(session.size);
    for (const [offset, part] of session.chunks) content.set(part, offset);
    this.completedUploads.set(session.token, content);
    return bytesResponse(new TextEncoder().encode(session.token));
  }

  private handleDownload(path: string): any {
    const [, , handle, range] = path.split('/');
    const content = this.contents.get(handle);
    if (!content) return { ...bytesResponse(new Uint8Array()), ok: false, status: 404 };
    const [start, end] = (range ?? '').split('-').map(Number);
    const slice = content.slice(start || 0, Number.isFinite(end) ? end + 1 : undefined);
    // A real Response: megajs streams downloads through body.getReader().
    return new Response(slice, { status: 200 });
  }

  private mint(): string {
    return `N${String(this.nextId++).padStart(7, '0')}`;
  }

  private descendants(handle: string): string[] {
    const out = [handle];
    for (const node of this.nodes.values()) {
      if (node.p === handle) out.push(...this.descendants(node.h));
    }
    return out;
  }

  private dispatch(req: CsRequest): unknown {
    const body = req.body;
    switch (body.a) {
      case 'ug':
        return { u: FAKE_USER, name: 'Fake User', email: 'reader@example.com' };
      case 'uq':
        return { utype: 0, cstrg: 0, mstrg: 20 * 1024 ** 3 };
      case 'sml':
        return 0;
      case 'f': {
        if (body.n && !this.subtreeFetchReturnsAll) {
          if (!this.nodes.has(body.n)) return -9;
          return { f: this.descendants(body.n).map((h) => this.nodes.get(h)), ok: [] };
        }
        return { f: [...this.nodes.values()], ok: [], s: [], u: [], sn: `sn${this.seq}` };
      }
      case 'u': {
        const id = `ul${this.nextId++}`;
        // Base64-safe, never parses as a negative number.
        const token = `TOKEN${String(this.nextId++).padStart(31, '0')}`;
        this.uploadSessions.set(id, { size: body.s, received: 0, token, chunks: new Map() });
        return { p: `${GATEWAY}ul/${id}` };
      }
      case 'p': {
        if (!this.nodes.has(body.t)) return -9;
        const created: ServerNode[] = [];
        for (const n of body.n) {
          const node: ServerNode = {
            h: this.mint(),
            p: body.t,
            u: FAKE_USER,
            t: n.t,
            a: n.a,
            k: `${FAKE_USER}:${n.k}`,
            ts: this.clock++
          };
          if (n.t === 0) {
            const token = atob(n.h.replace(/-/g, '+').replace(/_/g, '/'));
            const content = this.completedUploads.get(token);
            node.s = content?.length ?? 0;
            if (content) this.contents.set(node.h, content);
          }
          this.nodes.set(node.h, node);
          created.push(node);
        }
        this.publish([{ a: 't', t: { f: created } }]);
        return { f: created };
      }
      case 'g': {
        const node = this.nodes.get(body.n);
        if (!node || node.t !== 0 || !this.contents.has(node.h)) return -9;
        return { s: node.s ?? 0, at: node.a, g: `${GATEWAY}dl/${node.h}` };
      }
      case 'd': {
        if (!this.nodes.has(body.n)) return -9;
        for (const h of this.descendants(body.n)) this.nodes.delete(h);
        this.publish([{ a: 'd', n: body.n }]);
        return 0;
      }
      case 'm': {
        const node = this.nodes.get(body.n);
        if (!node || !this.nodes.has(body.t)) return -9;
        node.p = body.t;
        this.publish([
          { a: 'd', n: node.h, m: 1 },
          { a: 't', t: { f: [node] } }
        ]);
        return 0;
      }
      case 'a': {
        const node = this.nodes.get(body.n);
        if (!node) return -9;
        node.a = body.at;
        this.publish([{ a: 'u', n: node.h, at: body.at, ts: this.clock }]);
        return 0;
      }
      default:
        return -2; // EARGS
    }
  }
}

/** Another session of the same account, driven by handle or by path. */
export class OtherDevice {
  constructor(readonly storage: any) {}

  /** Resolve a Cloud-Drive path (first live match per segment); '' = the Cloud Drive. */
  node(path: string): any {
    let current = this.storage.root;
    for (const part of path.split('/').filter(Boolean)) {
      current = current.children?.find((c: any) => c.name === part);
      if (!current) throw new Error(`OtherDevice: no '${part}' in '${path}'`);
    }
    return current;
  }

  private parentOf(parent: string | any): any {
    return typeof parent === 'string' ? (this.storage.files[parent] ?? this.node(parent)) : parent;
  }

  /** mkdir under a handle or path; returns the new handle. */
  async mkdir(parent: string | any, name: string): Promise<string> {
    const folder = await this.parentOf(parent).mkdir(name);
    return folder.nodeId;
  }

  /** Upload `content` under a handle or path; returns the new handle. */
  async upload(parent: string | any, name: string, content = 'x'): Promise<string> {
    // TextEncoder's array comes from another realm under jsdom; megajs's
    // stream only takes this realm's Uint8Array (or a Buffer).
    const bytes = Uint8Array.from(new TextEncoder().encode(content));
    const target = this.parentOf(parent);
    const file: any = await new Promise((resolve, reject) => {
      target.upload({ name, size: bytes.length }, bytes, (error: Error | null, f: any) =>
        error ? reject(error) : resolve(f)
      );
    });
    return file.nodeId;
  }

  /** Create every folder of `path` (from the Cloud Drive) and upload a file at its end. */
  async put(path: string, content = 'x'): Promise<string> {
    const parts = path.split('/');
    const name = parts.pop()!;
    let current = this.storage.root;
    for (const part of parts) {
      const existing = current.children?.find((c: any) => c.name === part && c.directory);
      current = existing ?? this.storage.files[await this.mkdir(current, part)];
    }
    return this.upload(current, name, content);
  }

  /** Move a node under another folder (MEGA `m`). */
  async move(handle: string, target: string): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.storage.api.request({ a: 'm', n: handle, t: target }, (e: Error | null) =>
        e ? reject(e) : resolve()
      )
    );
  }

  async delete(handle: string): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.storage.api.request({ a: 'd', n: handle }, (e: Error | null) =>
        e ? reject(e) : resolve()
      )
    );
  }
}
