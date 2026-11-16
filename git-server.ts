import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  encodePktLine,
  pktLineFlush,
  pktLineDelim,
  decodePktLines,
  hashObject,
  buildCommit,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  collectReachable,
  isObjectId,
  type GitObject,
  type GitPacket,
  type TreeEntry,
  ZERO_OID,
} from './git.ts';
import { ForgeStore, type Repo } from './store.ts';

export class GitServer {
  constructor(private readonly store: ForgeStore) {}

  handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, service: string): void {
    const repo = this.store.getRepo(owner, repoName);
    if (!repo) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: 'Not Found' }) + '\n');
      return;
    }

    const auth = req.headers.authorization;
    const expectedToken = process.env.MAKEFUN_SHOP_TOKEN || '';
    if (expectedToken && auth !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: 'Bad credentials' }) + '\n');
      return;
    }

    res.setHeader('content-type', `application/x-${service}-advertisement`);
    res.setHeader('cache-control', 'no-cache');

    if (service === 'git-upload-pack') {
      const gitProtocol = req.headers['git-protocol'];
      if (typeof gitProtocol === 'string' && gitProtocol.includes('version=2')) {
        // Protocol v2 advertisement
        const packets = [
          encodePktLine('version 2\n'),
          encodePktLine('ls-refs=trace\n'),
          encodePktLine('fetch=shallow wait-for-done filter\n'),
          encodePktLine('server-option\n'),
          encodePktLine('object-format=sha1\n'),
          pktLineFlush(),
        ];
        res.writeHead(200);
        res.end(Buffer.concat(packets));
        return;
      }

      // Protocol v0 advertisement
      const caps = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done filter object-format=sha1 agent=makefun-forge';
      const packets: Buffer[] = [
        encodePktLine('# service=git-upload-pack\n'),
        pktLineFlush(),
      ];

      const refEntries = this.getOrderedRefs(repo);
      if (refEntries.length === 0) {
        packets.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:refs/heads/main\n`));
      } else {
        const [firstRef, firstOid] = refEntries[0];
        const symrefPart = firstRef === 'HEAD' ? ` symref=HEAD:${repo.head_symref}` : '';
        packets.push(encodePktLine(`${firstOid} ${firstRef}\0${caps}${symrefPart}\n`));

        for (let i = 1; i < refEntries.length; i++) {
          const [ref, oid] = refEntries[i];
          packets.push(encodePktLine(`${oid} ${ref}\n`));
          this.maybeAppendPeeled(repo, ref, oid, packets);
        }
      }
      packets.push(pktLineFlush());
      res.writeHead(200);
      res.end(Buffer.concat(packets));
      return;
    }

    if (service === 'git-receive-pack') {
      // Protocol v0 only
      const caps = 'report-status report-status-v2 delete-refs side-band-64k object-format=sha1 agent=makefun-forge';
      const packets: Buffer[] = [
        encodePktLine('# service=git-receive-pack\n'),
        pktLineFlush(),
      ];

      const refEntries = this.getOrderedRefs(repo);
      if (refEntries.length === 0) {
        packets.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
      } else {
        const [firstRef, firstOid] = refEntries[0];
        packets.push(encodePktLine(`${firstOid} ${firstRef}\0${caps}\n`));
        for (let i = 1; i < refEntries.length; i++) {
          const [ref, oid] = refEntries[i];
          packets.push(encodePktLine(`${oid} ${ref}\n`));
        }
      }
      packets.push(pktLineFlush());
      res.writeHead(200);
      res.end(Buffer.concat(packets));
      return;
    }

    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: `Unknown service ${service}` }) + '\n');
  }

  handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, body: Buffer): void {
    const repo = this.store.getRepo(owner, repoName);
    if (!repo) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: 'Not Found' }) + '\n');
      return;
    }

    const auth = req.headers.authorization;
    const expectedToken = process.env.MAKEFUN_SHOP_TOKEN || '';
    if (expectedToken && auth !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: 'Bad credentials' }) + '\n');
      return;
    }

    res.setHeader('content-type', 'application/x-git-upload-pack-result');
    res.setHeader('cache-control', 'no-cache');

    const packets = decodePktLines(body, { allowTrailing: true });
    const lines = packets
      .filter((p): p is { kind: 'data'; payload: Buffer; raw: Buffer } => p.kind === 'data')
      .map((p) => p.payload.toString('utf8').replace(/\n$/, ''));

    const gitProtocol = req.headers['git-protocol'];
    const isV2 = typeof gitProtocol === 'string' && gitProtocol.includes('version=2');

    if (isV2 && lines[0] === 'command=ls-refs') {
      const symrefs = lines.includes('symrefs');
      const peel = lines.includes('peel');
      const prefixes = lines
        .filter((l) => l.startsWith('ref-prefix '))
        .map((l) => l.slice('ref-prefix '.length));

      const outPackets: Buffer[] = [];
      const refEntries = this.getOrderedRefs(repo);

      if (refEntries.length === 0) {
        // Unborn repository
        const matchesHead = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p) || p.startsWith('HEAD'));
        if (symrefs && matchesHead) {
          outPackets.push(encodePktLine(`unborn HEAD symref-target:${repo.head_symref}\n`));
        }
      } else {
        for (const [ref, oid] of refEntries) {
          const match = prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
          if (!match) continue;

          let line = `${oid} ${ref}`;
          if (symrefs && ref === 'HEAD') {
            line += ` symref-target:${repo.head_symref}`;
          }
          if (peel) {
            const obj = repo.git_objects.get(oid);
            if (obj && obj.type === 'tag') {
              const tag = parseTag(obj.data);
              line += ` peeled:${tag.object}`;
            }
          }
          outPackets.push(encodePktLine(`${line}\n`));
        }
      }

      outPackets.push(pktLineFlush());
      res.writeHead(200);
      res.end(Buffer.concat(outPackets));
      return;
    }

    if (isV2 && lines[0] === 'command=fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const previousShallows: string[] = [];
      let depth: number | null = null;
      let deepen: number | null = null;

      for (const line of lines) {
        if (line.startsWith('want ')) wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) previousShallows.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) deepen = parseInt(line.slice(7).trim(), 10);
        else if (line.startsWith('depth ')) depth = parseInt(line.slice(6).trim(), 10);
      }

      const outPackets: Buffer[] = [];

      // Acknowledgments section first in v2
      outPackets.push(encodePktLine('acknowledgments\n'));
      outPackets.push(pktLineDelim());

      // Shallow calculation
      const targetDepth = depth ?? deepen;
      if (targetDepth !== null) {
        outPackets.push(encodePktLine('shallow-info\n'));
        const newShallows = new Set<string>();
        const newUnshallows = new Set<string>();

        for (const want of wants) {
          this.calculateShallowBoundaries(
            repo,
            want,
            targetDepth,
            previousShallows,
            newShallows,
            newUnshallows,
          );
        }

        for (const s of newShallows) {
          outPackets.push(encodePktLine(`shallow ${s}\n`));
        }
        for (const u of newUnshallows) {
          outPackets.push(encodePktLine(`unshallow ${u}\n`));
        }
        outPackets.push(pktLineDelim());
      }

      // Packfile section
      outPackets.push(encodePktLine('packfile\n'));

      // Collect objects to send
      const objectsToSend = this.collectObjectsForFetch(
        repo,
        wants,
        haves,
        targetDepth,
        previousShallows,
      );

      const packBytes = writePack(objectsToSend);
      this.writeSidebandPackets(packBytes, outPackets);
      outPackets.push(pktLineFlush());

      res.writeHead(200);
      res.end(Buffer.concat(outPackets));
      return;
    }

    // Fallback v0 fetch
    const wants = lines.filter((l) => l.startsWith('want ')).map((l) => l.slice(5).trim());
    const haves = lines.filter((l) => l.startsWith('have ')).map((l) => l.slice(5).trim());

    const outPackets: Buffer[] = [
      encodePktLine('NAK\n'),
    ];
    const objectsToSend = this.collectObjectsForFetch(repo, wants, haves, null);
    const packBytes = writePack(objectsToSend);
    this.writeSidebandPackets(packBytes, outPackets);
    outPackets.push(pktLineFlush());

    res.writeHead(200);
    res.end(Buffer.concat(outPackets));
  }

  handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, body: Buffer): void {
    const repo = this.store.getRepo(owner, repoName);
    if (!repo) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: 'Not Found' }) + '\n');
      return;
    }

    const auth = req.headers.authorization;
    const expectedToken = process.env.MAKEFUN_SHOP_TOKEN || '';
    if (expectedToken && auth !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: 'Bad credentials' }) + '\n');
      return;
    }

    res.setHeader('content-type', 'application/x-git-receive-pack-result');
    res.setHeader('cache-control', 'no-cache');

    // Decode commands up to flush pkt-line
    const decoder = decodePktLines(body, { allowTrailing: true });
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    let sideband = false;
    let packOffset = 0;

    for (const pkt of decoder) {
      if (pkt.kind === 'flush') {
        packOffset += 4;
        break;
      }
      if (pkt.kind === 'delim' || pkt.kind === 'response-end') {
        packOffset += 4;
        continue;
      }
      packOffset += pkt.raw.length;
      if (pkt.kind === 'data') {
        let text = pkt.payload.toString('utf8').replace(/\n$/, '');
        if (text.includes('\0')) {
          const [cmdPart, capsPart] = text.split('\0');
          text = cmdPart;
          if (capsPart && capsPart.includes('side-band-64k')) sideband = true;
        }
        const parts = text.split(' ').filter(Boolean);
        if (parts.length >= 3) {
          commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
        }
      }
    }

    // Unpack packfile if present
    const rawPack = body.subarray(packOffset);
    let unpackOk = true;
    let unpackDetail = 'ok';

    if (rawPack.length > 0) {
      try {
        const result = readPack(rawPack, {
          resolveBase: (oid) => repo.git_objects.get(oid),
        });
        for (const [oid, obj] of result.objects) {
          repo.git_objects.set(oid, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : String(err);
      }
    }

    // Process ref updates
    const refReports: Array<{ ref: string; ok: boolean; reason?: string }> = [];

    if (unpackOk) {
      for (const cmd of commands) {
        if (cmd.newOid === ZERO_OID) {
          // Delete ref
          const current = repo.refs.get(cmd.ref);
          if (current && current === cmd.oldOid) {
            repo.refs.delete(cmd.ref);
            refReports.push({ ref: cmd.ref, ok: true });
          } else {
            repo.refs.delete(cmd.ref); // tolerate if already absent
            refReports.push({ ref: cmd.ref, ok: true });
          }
        } else if (cmd.oldOid === ZERO_OID) {
          // Create ref
          repo.refs.set(cmd.ref, cmd.newOid);
          if (cmd.ref === repo.head_symref) {
            repo.refs.set('HEAD', cmd.newOid);
          }
          refReports.push({ ref: cmd.ref, ok: true });
        } else {
          // Update ref: check fast-forward
          const current = repo.refs.get(cmd.ref);
          const reachable = collectReachable([cmd.newOid], (oid) => repo.git_objects.get(oid));
          if (reachable.has(cmd.oldOid)) {
            // Fast-forward OK
            repo.refs.set(cmd.ref, cmd.newOid);
            if (cmd.ref === repo.head_symref) {
              repo.refs.set('HEAD', cmd.newOid);
            }
            refReports.push({ ref: cmd.ref, ok: true });
          } else {
            // Non-fast-forward
            refReports.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          }
        }
      }
    }

    // Build report lines
    const reportLines: string[] = [];
    reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
    for (const r of refReports) {
      reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? 'error'}\n`);
    }

    const outPackets: Buffer[] = [];
    if (sideband) {
      for (const line of reportLines) {
        const payload = Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')]);
        outPackets.push(encodePktLine(payload));
      }
      outPackets.push(pktLineFlush());
    } else {
      for (const line of reportLines) {
        outPackets.push(encodePktLine(line));
      }
      outPackets.push(pktLineFlush());
    }

    res.writeHead(200);
    res.end(Buffer.concat(outPackets));
  }

  private getOrderedRefs(repo: Repo): Array<[string, string]> {
    const entries: Array<[string, string]> = [];
    const headOid = repo.refs.get('HEAD') ?? (repo.head_symref ? repo.refs.get(repo.head_symref) : undefined);
    if (headOid) {
      entries.push(['HEAD', headOid]);
    }
    const otherRefs = [...repo.refs.entries()]
      .filter(([name]) => name !== 'HEAD')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    entries.push(...otherRefs);
    return entries;
  }

  private maybeAppendPeeled(repo: Repo, ref: string, oid: string, packets: Buffer[]): void {
    const obj = repo.git_objects.get(oid);
    if (obj && obj.type === 'tag') {
      const tag = parseTag(obj.data);
      packets.push(encodePktLine(`${tag.object} ${ref}^{}\n`));
    }
  }

  private writeSidebandPackets(packBytes: Buffer, outPackets: Buffer[]): void {
    const CHUNK_SIZE = 65515; // 65520 - 4 pkt header - 1 band byte
    let offset = 0;
    while (offset < packBytes.length) {
      const end = Math.min(offset + CHUNK_SIZE, packBytes.length);
      const chunk = packBytes.subarray(offset, end);
      const payload = Buffer.concat([Buffer.from([1]), chunk]);
      outPackets.push(encodePktLine(payload));
      offset = end;
    }
  }

  private calculateShallowBoundaries(
    repo: Repo,
    tip: string,
    depth: number,
    previousShallows: string[],
    newShallows: Set<string>,
    newUnshallows: Set<string>,
  ): void {
    // Traverse from tip down to depth
    let currentGen = new Set<string>([tip]);
    for (let gen = 0; gen < depth; gen++) {
      const nextGen = new Set<string>();
      for (const oid of currentGen) {
        const obj = repo.git_objects.get(oid);
        if (obj && obj.type === 'commit') {
          const parsed = parseCommit(obj.data);
          for (const p of parsed.parents) nextGen.add(p);
        }
      }
      if (gen === depth - 1) {
        // At the boundary
        for (const oid of currentGen) {
          const obj = repo.git_objects.get(oid);
          if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) {
            newShallows.add(oid);
          }
        }
      }
      currentGen = nextGen;
    }

    for (const prev of previousShallows) {
      if (!newShallows.has(prev)) {
        newUnshallows.add(prev);
      }
    }
  }

  private collectObjectsForFetch(
    repo: Repo,
    wants: string[],
    haves: string[],
    shallowDepth: number | null,
    previousShallows: string[] = [],
  ): GitObject[] {
    const shallowSet = new Set(previousShallows);
    const haveSet = new Set<string>();
    const haveQueue: string[] = [];

    for (const have of haves) {
      if (isObjectId(have)) haveQueue.push(have);
    }

    while (haveQueue.length > 0) {
      const oid = haveQueue.pop()!;
      if (haveSet.has(oid)) continue;
      const obj = repo.git_objects.get(oid);
      if (!obj) continue;
      haveSet.add(oid);

      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        haveQueue.push(commit.tree);
        // If this commit is a shallow boundary for the client, its parents are NOT held by the client!
        if (!shallowSet.has(oid)) {
          for (const parent of commit.parents) {
            haveQueue.push(parent);
          }
        }
      } else if (obj.type === 'tag') {
        haveQueue.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode === '160000') continue;
          haveQueue.push(entry.oid);
        }
      }
    }

    const toSend = new Map<string, GitObject>();

    if (shallowDepth !== null) {
      // Shallow collection: traverse only up to shallowDepth generations
      let currentLevel = new Set<string>(wants);
      for (let gen = 0; gen < shallowDepth; gen++) {
        const nextLevel = new Set<string>();
        for (const oid of currentLevel) {
          const obj = repo.git_objects.get(oid);
          if (!obj) continue;

          if (!haveSet.has(oid) && !toSend.has(oid)) {
            toSend.set(oid, obj);
            if (obj.type === 'commit') {
              const commit = parseCommit(obj.data);
              this.collectTreeObjects(repo, commit.tree, toSend, haveSet);
            }
          }

          if (gen < shallowDepth - 1) {
            if (obj.type === 'commit') {
              const commit = parseCommit(obj.data);
              for (const p of commit.parents) nextLevel.add(p);
            } else if (obj.type === 'tag') {
              const tag = parseTag(obj.data);
              nextLevel.add(tag.object);
            }
          }
        }
        currentLevel = nextLevel;
      }
      return [...toSend.values()];
    }

    // Normal full or incremental fetch
    const wantSet = collectReachable(wants, (oid) => repo.git_objects.get(oid));
    for (const oid of wantSet) {
      if (!haveSet.has(oid)) {
        const obj = repo.git_objects.get(oid);
        if (obj) toSend.set(oid, obj);
      }
    }
    return [...toSend.values()];
  }

  private collectTreeObjects(
    repo: Repo,
    treeOid: string,
    toSend: Map<string, GitObject>,
    haveSet: Set<string>,
  ): void {
    if (haveSet.has(treeOid) || toSend.has(treeOid)) return;
    const treeObj = repo.git_objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return;
    toSend.set(treeOid, treeObj);

    const entries = parseTree(treeObj.data);
    for (const entry of entries) {
      if (haveSet.has(entry.oid) || toSend.has(entry.oid)) continue;
      const childObj = repo.git_objects.get(entry.oid);
      if (!childObj) continue;
      if (childObj.type === 'tree') {
        this.collectTreeObjects(repo, entry.oid, toSend, haveSet);
      } else {
        toSend.set(entry.oid, childObj);
      }
    }
  }
}
