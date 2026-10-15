/**
 * The provider-agnostic half of `SyncProvider.readControlFile`: given the
 * nodes a provider found under a control file's name (with their versions),
 * answer `'not-modified'` when the whole set is unchanged, else download only
 * the nodes whose version moved since the last read.
 *
 * Each provider does the cheap part itself — one metadata call that lists
 * every node of the name (Drive `files.list`, Graph `getItemByPath`, a WebDAV
 * GET with `If-None-Match`, MEGA's in-memory tree) — and hands the nodes here.
 */
import type { ControlFileNode, ControlFileResult } from './provider-interface';

export interface ListedControlNode {
  id: string;
  /** The node's version; see `ControlFileNode.etag`. */
  etag: string;
  modified?: string;
}

/** The opaque version of a node set: order-independent, changes when any node does. */
export function controlSetEtag(
  nodes: ReadonlyArray<Pick<ListedControlNode, 'id' | 'etag'>>
): string {
  return nodes
    .map((n) => `${n.id}=${n.etag}`)
    .sort()
    .join('|');
}

/** Downloaded node bodies, by control-file name and node id, at the version they were read. */
export class ControlNodeCache {
  private byName = new Map<string, Map<string, { etag: string; blob: Blob }>>();

  get(name: string, id: string, etag: string): Blob | undefined {
    const hit = this.byName.get(name)?.get(id);
    return hit && hit.etag === etag ? hit.blob : undefined;
  }

  set(name: string, id: string, etag: string, blob: Blob): void {
    let nodes = this.byName.get(name);
    if (!nodes) this.byName.set(name, (nodes = new Map()));
    nodes.set(id, { etag, blob });
  }

  /** Forget nodes of `name` that are no longer listed. */
  retain(name: string, ids: Iterable<string>): void {
    const nodes = this.byName.get(name);
    if (!nodes) return;
    const keep = new Set(ids);
    for (const id of [...nodes.keys()]) if (!keep.has(id)) nodes.delete(id);
    if (nodes.size === 0) this.byName.delete(name);
  }

  clear(): void {
    this.byName.clear();
  }
}

/**
 * Turn a listing of a control file's nodes into a `readControlFile` result.
 * `download` runs only for nodes not cached at their current version.
 */
export async function readControlNodes(
  name: string,
  listed: ReadonlyArray<ListedControlNode>,
  download: (node: ListedControlNode) => Promise<Blob>,
  cache: ControlNodeCache,
  ifNoneMatch?: string
): Promise<ControlFileResult> {
  cache.retain(
    name,
    listed.map((n) => n.id)
  );
  if (listed.length === 0) return null;
  const etag = controlSetEtag(listed);
  if (ifNoneMatch !== undefined && ifNoneMatch === etag) return 'not-modified';
  const nodes: ControlFileNode[] = [];
  for (const node of listed) {
    let blob = cache.get(name, node.id, node.etag);
    if (!blob) {
      blob = await download(node);
      cache.set(name, node.id, node.etag, blob);
    }
    nodes.push({
      id: node.id,
      etag: node.etag,
      ...(node.modified ? { modified: node.modified } : {}),
      blob
    });
  }
  return { nodes, etag };
}
