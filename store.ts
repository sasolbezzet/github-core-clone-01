import {
  hashObject,
  buildCommit,
  buildTree,
  type GitObject,
  type GitObjectType,
  ZERO_OID,
  parseCommit,
  parseTree,
  type TreeEntry,
} from './git.ts';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
  node_id: string;
}

export interface Label {
  id: number;
  node_id: string;
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  node_id: string;
  body: string;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  mergeable: boolean | null;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Repo {
  id: number;
  databaseId: number;
  node_id: string;
  name: string;
  full_name: string;
  nameWithOwner: string;
  owner: { login: string; id: number };
  private: boolean;
  description: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  has_issues: boolean;

  // Git data
  git_objects: Map<string, GitObject>;
  refs: Map<string, string>; // e.g. "refs/heads/main" -> oid
  head_symref: string; // e.g. "refs/heads/main"

  // Issues & Pulls
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pull_requests: Map<number, PullRequest>;

  next_issue_number: number;
  next_comment_id: number;
  next_pr_number: number;
  next_label_id: number;
}

export class ForgeStore {
  readonly viewer: User = {
    id: 1000,
    login: 'adaiversen',
    name: 'ada iversen',
    email: 'adaiversen@example.invalid',
    node_id: 'MDQ6VXNlcjEwMDA=',
  };

  readonly repos = new Map<string, Repo>(); // key: `${owner}/${name}`.toLowerCase()
  private nextRepoId = 1;

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`.toLowerCase());
  }

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string } = {}): Repo {
    const key = `${owner}/${name}`.toLowerCase();
    const existing = this.repos.get(key);
    if (existing) return existing;

    const id = this.nextRepoId++;
    const now = this.nowIso();
    const repo: Repo = {
      id,
      databaseId: id,
      node_id: Buffer.from(`010:Repository${id}`).toString('base64'),
      name,
      full_name: `${owner}/${name}`,
      nameWithOwner: `${owner}/${name}`,
      owner: { login: owner, id: owner === this.viewer.login ? this.viewer.id : 1002 },
      private: options.private ?? false,
      description: options.description ?? null,
      default_branch: 'main',
      created_at: now,
      updated_at: now,
      pushed_at: now,
      has_issues: true,

      git_objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      head_symref: 'refs/heads/main',

      labels: new Map<string, Label>(),
      issues: new Map<number, Issue>(),
      pull_requests: new Map<number, PullRequest>(),

      next_issue_number: 1,
      next_comment_id: 1,
      next_pr_number: 1,
      next_label_id: 1,
    };

    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = `${owner}/${name}`.toLowerCase();
    return this.repos.delete(key);
  }

  nowIso(): string {
    return process.env.MAKEFUN_TRIAL_NOW || '2025-01-01T00:00:00.000Z';
  }

  nowEpochSec(): number {
    return Math.floor(new Date(this.nowIso()).getTime() / 1000);
  }

  // ---------------------------------------------------------------- Git Tree Helpers
  flattenTree(
    repo: Repo,
    treeOid: string,
    prefix = '',
  ): Map<string, { oid: string; mode: string; size: number }> {
    const result = new Map<string, { oid: string; mode: string; size: number }>();
    const treeObj = repo.git_objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return result;
    const entries = parseTree(treeObj.data);
    for (const entry of entries) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        const sub = this.flattenTree(repo, entry.oid, fullPath);
        for (const [k, v] of sub) result.set(k, v);
      } else {
        const blobObj = repo.git_objects.get(entry.oid);
        const size = blobObj ? blobObj.data.length : 0;
        result.set(fullPath, { oid: entry.oid, mode: entry.mode, size });
      }
    }
    return result;
  }

  buildTreeFromMap(
    repo: Repo,
    files: Map<string, { oid: string; mode: string }>,
  ): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = makeNode();
    for (const [path, entry] of files) {
      const segments = path.split('/').filter(Boolean);
      let current = root;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        if (!current.dirs.has(seg)) current.dirs.set(seg, makeNode());
        current = current.dirs.get(seg)!;
      }
      current.files.set(segments[segments.length - 1], entry);
    }

    const serializeNode = (node: Node): string => {
      const treeEntries: TreeEntry[] = [];
      for (const [name, entry] of [...node.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        treeEntries.push({ mode: entry.mode, name, oid: entry.oid });
      }
      for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const childOid = serializeNode(child);
        treeEntries.push({ mode: '40000', name, oid: childOid });
      }
      const data = buildTree(treeEntries);
      const oid = hashObject('tree', data);
      repo.git_objects.set(oid, { type: 'tree', data });
      return oid;
    };

    return serializeNode(root);
  }

  findMergeBase(repo: Repo, oidA: string, oidB: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA = [oidA];
    while (queueA.length > 0) {
      const cur = queueA.shift()!;
      if (ancestorsA.has(cur)) continue;
      ancestorsA.add(cur);
      const obj = repo.git_objects.get(cur);
      if (obj && obj.type === 'commit') {
        const parsed = parseCommit(obj.data);
        for (const p of parsed.parents) queueA.push(p);
      }
    }

    const queueB = [oidB];
    const visitedB = new Set<string>();
    while (queueB.length > 0) {
      const cur = queueB.shift()!;
      if (visitedB.has(cur)) continue;
      visitedB.add(cur);
      if (ancestorsA.has(cur)) return cur;
      const obj = repo.git_objects.get(cur);
      if (obj && obj.type === 'commit') {
        const parsed = parseCommit(obj.data);
        for (const p of parsed.parents) queueB.push(p);
      }
    }
    return null;
  }

  getChangedFilesBetween(
    repo: Repo,
    baseCommitSha: string,
    headCommitSha: string,
  ): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseCommit = repo.git_objects.get(baseCommitSha);
    const headCommit = repo.git_objects.get(headCommitSha);
    if (!headCommit || headCommit.type !== 'commit') return [];

    const headTreeOid = parseCommit(headCommit.data).tree;
    const headFiles = this.flattenTree(repo, headTreeOid);

    const baseFiles = baseCommit && baseCommit.type === 'commit'
      ? this.flattenTree(repo, parseCommit(baseCommit.data).tree)
      : new Map();

    const result: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];

    for (const [path, headEntry] of headFiles) {
      const baseEntry = baseFiles.get(path);
      if (!baseEntry) {
        // added
        const blob = repo.git_objects.get(headEntry.oid);
        const lines = blob ? blob.data.toString('utf8').split('\n').length : 1;
        result.push({
          filename: path,
          status: 'added',
          additions: lines,
          deletions: 0,
          changes: lines,
        });
      } else if (baseEntry.oid !== headEntry.oid) {
        // modified
        const blob = repo.git_objects.get(headEntry.oid);
        const lines = blob ? blob.data.toString('utf8').split('\n').length : 1;
        result.push({
          filename: path,
          status: 'modified',
          additions: lines,
          deletions: 0,
          changes: lines,
        });
      }
    }

    for (const [path, baseEntry] of baseFiles) {
      if (!headFiles.has(path)) {
        const blob = repo.git_objects.get(baseEntry.oid);
        const lines = blob ? blob.data.toString('utf8').split('\n').length : 1;
        result.push({
          filename: path,
          status: 'deleted',
          additions: 0,
          deletions: lines,
          changes: lines,
        });
      }
    }

    return result;
  }
}
