/**
 * A dependency-free git smart-HTTP client (protocol v2 and v0) for the github-core-clone-01
 * envelope. The trial pod has no `git` binary and no internet: every request this module makes
 * goes to the entry's base URL (`wire.ts`), and everything else is done in-process here.
 *
 * What it implements, and where:
 *   - pkt-line codec: 0000 flush, 0001 delim, 0002 response-end, 4-hex-length framing, max 65520
 *     bytes a packet (git's LARGE_PACKET_MAX). `PktLineDecoder` parses incrementally so a fetch
 *     response is never buffered whole just to be framed.
 *   - ref advertisement: v0 (`<oid> <ref>\0<caps>`, peeled tags, `symref=HEAD:...`, the empty
 *     repo's `capabilities^{}` pseudo-ref) and v2 (`version 2` + capability lines).
 *   - ls-refs (v2: `peel`, `symrefs`, `unborn`, `ref-prefix`; v0: the advertisement's ref list).
 *   - fetch (v2 sections `acknowledgments`, `shallow-info`, `wanted-refs`, `packfile`; v0
 *     `want`/`have`/`done`/`deepen` with side-band-64k), including shallow deepen.
 *   - receive-pack push (command list, create/update/delete, report-status and report-status-v2,
 *     side-band-64k), refusing nothing itself: the server's per-ref `ng` report is returned.
 *   - packfile READ: version 2/3 packs, zlib-inflated objects, OFS_DELTA and REF_DELTA (resolved
 *     recursively, thin-pack bases supplied by the caller), trailer checksum verified.
 *   - packfile WRITE: plain objects only (no deltas), for pushes. Small and correct.
 *   - object model: SHA-1 object hashing exactly as git computes it, commit/tree/tag parsing and
 *     building, and a reachability walk so a clone can be verified object-for-object.
 *
 * Every public call takes an `AbortSignal` and a per-call timeout; no call can hang a trial. A
 * check compares object hashes and bytes only: nothing here turns a duration into a pass bit.
 *
 * Runtime: Node 22, erasable TypeScript only (this file is loaded by `node --experimental-strip-types`
 * from sdk/run.ts and inlined by the bundle builder), Node built-ins only, no dependencies.
 */

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The all-zero object id: an unborn branch's old/new value in a receive-pack command list. */
export const ZERO_OID = '0'.repeat(40);
/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length. */
export const PKT_LINE_MAX = 65520;
/** The largest pkt-line payload (length minus the 4-byte header). */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** The per-request timeout every client call falls back to when its options name none. */
export const DEFAULT_GIT_TIMEOUT_MS = 8000;
/** The agent string the client advertises where a server advertises the `agent` capability. */
export const GIT_CLIENT_AGENT = 'makefun-git-client/1.0';
/** The only object format the client speaks (the contest's rules state SHA-1). */
export const GIT_OBJECT_FORMAT = 'sha1';

/** The two smart-HTTP services. */
export type GitService = 'git-upload-pack' | 'git-receive-pack';

/** The four object types git stores. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** Any error the client raises about the wire, with a stable machine-readable code. */
export class GitProtocolError extends Error {
  readonly code: string;

  constructor(message: string, code = 'protocol') {
    super(message);
    this.name = 'GitProtocolError';
    this.code = code;
  }
}

/** A non-200 (or unexpected) HTTP response from the entry. */
export class GitHttpError extends Error {
  readonly url: string;
  readonly status: number;
  readonly bodySnippet: string;

  constructor(message: string, url: string, status: number, bodySnippet = '') {
    super(message);
    this.name = 'GitHttpError';
    this.url = url;
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

/** One decoded pkt-line. `raw` is the exact bytes framing it, needed by the v0 raw-pack fallback. */
export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer; readonly raw: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new GitProtocolError(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`, 'pktline-too-long');
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a mixed sequence; the string `'flush'`/`'delim'`/`'response-end'` are the control packets. */
export function encodePktLines(
  items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>,
): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * An incremental pkt-line decoder. Push response chunks as they arrive; `next()` returns a packet
 * when one is complete and `null` when it needs more bytes. `finish()` marks the stream ended and
 * refuses trailing bytes, so a truncated packet is an error rather than silent data loss.
 */
export class PktLineDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  constructor(initial?: Uint8Array) {
    if (initial && initial.length) this.push(initial);
  }

  get bufferedBytes(): number {
    return this.buffered;
  }

  push(chunk: Uint8Array): void {
    if (this.ended) throw new GitProtocolError('pkt-line decoder received bytes after finish()', 'pktline-after-end');
    if (!chunk.length) return;
    this.chunks.push(asBuffer(chunk));
    this.buffered += chunk.length;
  }

  /** Mark the stream ended. A caller that expects raw trailing bytes takes them before this. */
  finish(): void {
    this.ended = true;
  }

  /** True once the stream is ended and every byte was consumed. */
  get complete(): boolean {
    return this.ended && this.buffered === 0;
  }

  /** A view of the next `n` bytes without consuming them, or null if fewer are buffered. */
  private peek(n: number): Buffer | null {
    if (this.buffered < n) return null;
    const first = this.chunks[0];
    if (first.length >= n) return first.subarray(0, n);
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    for (const chunk of this.chunks) {
      const need = n - filled;
      if (need <= 0) break;
      const take = Math.min(need, chunk.length);
      chunk.copy(out, filled, 0, take);
      filled += take;
    }
    return out;
  }

  /** Consume exactly `n` buffered bytes and return them. */
  private take(n: number): Buffer {
    if (this.buffered < n) throw new GitProtocolError('pkt-line decoder underrun', 'pktline-underrun');
    const first = this.chunks[0];
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0];
      const need = n - filled;
      if (chunk.length <= need) {
        chunk.copy(out, filled);
        filled += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(out, filled, 0, need);
        this.chunks[0] = chunk.subarray(need);
        filled = n;
      }
    }
    this.buffered -= n;
    return out;
  }

  /** True when the next four buffered bytes look like a pkt-line length, not raw pack data. */
  private nextLooksFramed(): boolean {
    const head = this.peek(4);
    return head !== null && HEX4.test(head.toString('ascii'));
  }

  /** Remove and return every buffered byte (the v0 raw-pack fallback). */
  takeBuffered(): Buffer {
    if (!this.buffered) return Buffer.alloc(0);
    const out = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    return out;
  }

  /**
   * The next packet, or null when more bytes are needed. Throws on a malformed header or a
   * truncated stream (after `finish()`), never returns a bogus packet.
   */
  next(): GitPacket | null {
    if (this.buffered < 4) {
      if (this.ended && this.buffered > 0) {
        throw new GitProtocolError(`truncated pkt-line: ${this.buffered} trailing byte(s)`, 'pktline-truncated');
      }
      return null;
    }
    const header = this.peek(4)!;
    if (!HEX4.test(header.toString('ascii'))) {
      throw new GitProtocolError(`invalid pkt-line length ${JSON.stringify(header.toString('ascii'))}`, 'pktline-header');
    }
    const length = Number.parseInt(header.toString('ascii'), 16);
    if (length === 0) {
      this.take(4);
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.take(4);
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.take(4);
      return { kind: 'response-end' };
    }
    if (length === 3) {
      throw new GitProtocolError('invalid pkt-line length 0003', 'pktline-header');
    }
    if (length > PKT_LINE_MAX) {
      throw new GitProtocolError(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`, 'pktline-too-long');
    }
    if (this.buffered < length) {
      if (this.ended) {
        throw new GitProtocolError(`truncated pkt-line: ${length} announced, ${this.buffered} available`, 'pktline-truncated');
      }
      return null;
    }
    const raw = this.take(length);
    return { kind: 'data', payload: raw.subarray(4), raw };
  }

  /**
   * Switch the decoder to raw (unframed) mode for a v0 fetch response without sideband: returns
   * the buffered bytes untouched when the next four bytes are not a pkt-line length.
   */
  nextIsRaw(): boolean {
    if (this.buffered < 4) return false;
    return !this.nextLooksFramed();
  }
}

/** Decode a complete buffer into packets; refuses trailing bytes. */
export function decodePktLines(bytes: Uint8Array, options: { allowTrailing?: boolean } = {}): GitPacket[] {
  const decoder = new PktLineDecoder(bytes);
  decoder.finish();
  const packets: GitPacket[] = [];
  for (;;) {
    if (options.allowTrailing && decoder.nextIsRaw()) break;
    const packet = decoder.next();
    if (packet === null) break;
    packets.push(packet);
  }
  return packets;
}

/** The decoded text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// object model
// ---------------------------------------------------------------------------------------------

/** A git object: its type and its exact byte content (no header, as the hash is computed over it). */
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The loose-object header `<type> <size>\0` that prefixes the bytes a SHA-1 is computed over. */
export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = asBuffer(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

/** The full loose-object bytes (header + content), as `git cat-file` would hash them. */
export function encodeLooseObject(type: GitObjectType, data: Uint8Array): Buffer {
  const body = asBuffer(data);
  return Buffer.concat([objectHeader(type, body.length), body]);
}

const HEX40 = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-hex object id (the only id form the client accepts). */
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** A parsed tree entry. `mode` is git's ASCII mode (`100644`, `40000`, `160000`, ...). */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  /** Any headers before the blank line that the client does not model (`gpgsig`, `encoding`, ...). */
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = asBuffer(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new GitProtocolError('tree entry has no mode separator', 'tree-parse');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new GitProtocolError('tree entry has no name terminator', 'tree-parse');
    if (nul + 21 > buffer.length) throw new GitProtocolError('tree entry has a truncated object id', 'tree-parse');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new GitProtocolError(`tree entry mode ${JSON.stringify(mode)} is not octal`, 'tree-parse');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new GitProtocolError(`tree entry ${entry.name} has a bad object id`, 'tree-build');
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object; refuses a malformed header layout. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  if (!isObjectId(tree)) throw new GitProtocolError('commit has no valid tree header', 'commit-parse');
  for (const parent of parents) if (!isObjectId(parent)) throw new GitProtocolError('commit has a bad parent id', 'commit-parse');
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new GitProtocolError(`tag header ${JSON.stringify(line)} has no value`, 'tag-parse');
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new GitProtocolError('tag has no valid object header', 'tag-parse');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new GitProtocolError(`tag has bad type ${JSON.stringify(type)}`, 'tag-parse');
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Fields for a deterministic commit object. */
export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  /** Unix seconds. Callers pass a fixed constant, never Date.now(). */
  readonly timestamp?: number;
  /** `+0000` by default, so two runs produce the same bytes. */
  readonly timezone?: string;
}

/** The default identity every generated commit and tag carries, so bytes are reproducible. */
export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';

/** Build a commit object's bytes. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new GitProtocolError('buildCommit needs a valid tree id', 'commit-build');
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new GitProtocolError('buildCommit needs valid parent ids', 'commit-build');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  if (!isObjectId(fields.object)) throw new GitProtocolError('buildTag needs a valid object id', 'tag-build');
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

/** A lookup from object id to object; a plain Map is the common case in the suite. */
export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `roots`: commit → tree + parents, tree → entries (gitlinks skipped),
 * tag → its target, blob → nothing. Throws on a missing object unless `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new GitProtocolError(`object ${oid} is missing from the store`, 'missing-object');
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue; // a gitlink names a commit the repo does not hold
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// packfile read
// ---------------------------------------------------------------------------------------------

export interface PackEntry {
  /** Byte offset of this entry's header in the pack. */
  readonly offset: number;
  /** The type stored in the pack (a delta entry reports `ofs-delta`/`ref-delta` through `delta`). */
  readonly type: GitObjectType;
  readonly size: number;
  readonly data: Buffer;
  readonly oid: string;
  readonly delta: { readonly kind: 'ofs' | 'ref'; readonly baseOid: string } | null;
}

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly entries: PackEntry[];
  readonly trailer: string;
  readonly computedTrailer: string;
  readonly checksumOk: boolean;
  readonly deltaCount: number;
  readonly byteLength: number;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new GitProtocolError('pack entry has no size header', 'pack-truncated');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitProtocolError('pack entry size varint is truncated', 'pack-truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new GitProtocolError('pack entry size varint is too long', 'pack-corrupt');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new GitProtocolError('ofs-delta has no base offset', 'pack-truncated');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new GitProtocolError('ofs-delta base offset is truncated', 'pack-truncated');
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = asBuffer(buffer).subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new GitProtocolError(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`, 'pack-zlib');
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new GitProtocolError(`zlib stream at offset ${offset} consumed no bytes`, 'pack-zlib');
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = asBuffer(base);
  const deltaBuffer = asBuffer(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new GitProtocolError('delta size varint is truncated', 'delta-corrupt');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new GitProtocolError('delta size varint is too long', 'delta-corrupt');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) {
    throw new GitProtocolError(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`, 'delta-base-size');
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new GitProtocolError('delta copy offset is truncated', 'delta-corrupt');
          copyOffset += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new GitProtocolError('delta copy size is truncated', 'delta-corrupt');
          copySize += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new GitProtocolError('delta copy is out of the base', 'delta-corrupt');
      if (written + copySize > targetSize) throw new GitProtocolError('delta writes past its target size', 'delta-corrupt');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new GitProtocolError('delta insert is truncated', 'delta-corrupt');
      if (written + literal > targetSize) throw new GitProtocolError('delta writes past its target size', 'delta-corrupt');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new GitProtocolError('delta opcode 0 is invalid', 'delta-corrupt');
    }
  }
  if (written !== targetSize) throw new GitProtocolError(`delta produced ${written} of ${targetSize} bytes`, 'delta-size');
  return out;
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Uint8Array): string {
  const buffer = asBuffer(pack);
  if (buffer.length < 20) throw new GitProtocolError('pack is shorter than its trailer', 'pack-truncated');
  return createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and REF_DELTA.
 * `resolveBase` supplies a base object a thin pack leaves out (the client already has it).
 * Every object's SHA-1 is recomputed and its declared size checked; a mismatch is an error, so a
 * corruption cannot be reported as a successful clone.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = asBuffer(pack);
  if (buffer.length < 32) throw new GitProtocolError(`pack is ${buffer.length} bytes, too short`, 'pack-truncated');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new GitProtocolError('pack does not start with PACK', 'pack-header');
  }
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new GitProtocolError(`unsupported pack version ${version}`, 'pack-version');
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new GitProtocolError(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`, 'pack-delta');
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new GitProtocolError('ref-delta base id is truncated', 'pack-truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new GitProtocolError(`pack entry ${index} has unknown type code ${typeCode}`, 'pack-type');
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new GitProtocolError(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
        'pack-size',
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new GitProtocolError(`pack has ${trailerStart - offset} stray bytes before its trailer`, 'pack-trailing');
  }

  const entries: PackEntry[] = [];
  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  // Resolved entries by their computed id, so a REF_DELTA base is an O(1) lookup, not a scan.
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new GitProtocolError(`delta cycle at pack offset ${entry.offset}`, 'pack-delta-cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new GitProtocolError(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`, 'pack-delta-base');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) {
          throw new GitProtocolError(`ref-delta base ${wanted} is neither in the pack nor supplied by the client`, 'pack-delta-base');
        }
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
    entries.push({
      offset: entry.offset,
      type: resolved.type,
      size: entry.size,
      data: entry.data,
      oid: resolved.oid,
      delta:
        entry.typeCode === 6
          ? { kind: 'ofs', baseOid: byOffset.get(entry.baseOffset!)?.oid ?? '' }
          : entry.typeCode === 7
            ? { kind: 'ref', baseOid: entry.baseOid! }
            : null,
    });
  }

  return {
    version,
    declaredCount,
    objects,
    entries,
    trailer,
    computedTrailer,
    checksumOk,
    deltaCount,
    byteLength: buffer.length,
  };
}

// ---------------------------------------------------------------------------------------------
// packfile write
// ---------------------------------------------------------------------------------------------

export interface GitObjectInput {
  readonly type: GitObjectType;
  readonly data: Uint8Array;
}

/** Encode one object's pack header: the type/size varint git's pack format uses. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas). The order is the caller's; git does not require
 * a particular order for index-pack to accept it. The trailer is SHA-1 over everything before it.
 */
export function writePack(objects: Iterable<GitObjectInput>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = asBuffer(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** True when the pack's trailer matches its bytes. */
export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const buffer = asBuffer(pack);
  const actual = buffer.subarray(buffer.length - 20).toString('hex');
  const expected = packChecksum(buffer);
  return { ok: actual === expected, expected, actual };
}

/** The objects reachable from `newTips` that a server holding `serverTips` does not have. */
export function objectsToSend(
  lookup: ObjectLookup,
  serverTips: Iterable<string>,
  newTips: Iterable<string>,
): GitObject[] {
  const onServer = collectReachable(serverTips, lookup, { allowMissing: true });
  const wanted = collectReachable(newTips, lookup);
  const send: GitObject[] = [];
  for (const oid of wanted) {
    if (onServer.has(oid)) continue;
    const object = lookup(oid);
    if (object) send.push(object);
  }
  return send;
}

