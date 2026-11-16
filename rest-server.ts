import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  hashObject,
  buildCommit,
  parseCommit,
  parseTree,
  type GitObject,
} from './git.ts';
import { ForgeStore, type Repo, type Issue, type PullRequest, type Label } from './store.ts';

export class RestServer {
  constructor(private readonly store: ForgeStore) {}

  sendJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): void {
    const text = JSON.stringify(body) + '\n';
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      ...headers,
    });
    res.end(text);
  }

  handle(req: IncomingMessage, res: ServerResponse, url: URL, bodyBuffer: Buffer): void {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    // Check auth for all /api/v3 routes (except GET /api/v3 and GET /api/v3/meta which still check auth in reposUnauthorized)
    const auth = req.headers.authorization;
    const expectedToken = process.env.MAKEFUN_SHOP_TOKEN || '';

    // Route: GET /api/v3 or /api/v3/
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      this.sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          rate_limit_url: '/api/v3/rate_limit',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          user_repositories_url: '/api/v3/user/repos',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }

    // Auth check
    if (expectedToken && auth !== `Bearer ${expectedToken}`) {
      this.sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }

    // Route: GET /api/v3/meta
    if (method === 'GET' && path === '/api/v3/meta') {
      this.sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }

    // Route: GET /api/v3/user
    if (method === 'GET' && path === '/api/v3/user') {
      this.sendJson(res, 200, this.store.viewer);
      return;
    }

    // Route: GET /api/v3/user/repos
    if (method === 'GET' && path === '/api/v3/user/repos') {
      const perPage = parseInt(url.searchParams.get('per_page') ?? '30', 10);
      const page = parseInt(url.searchParams.get('page') ?? '1', 10);

      const allRepos = [...this.store.repos.values()]
        .filter((r) => r.owner.login === this.store.viewer.login)
        .sort((a, b) => a.id - b.id);

      const startIndex = (page - 1) * perPage;
      const paged = allRepos.slice(startIndex, startIndex + perPage);

      const headers: Record<string, string> = {};
      if (startIndex + perPage < allRepos.length) {
        const nextUrl = new URL(url.toString());
        nextUrl.searchParams.set('page', String(page + 1));
        nextUrl.searchParams.set('per_page', String(perPage));
        headers.link = `<${nextUrl.toString()}>; rel="next"`;
      }

      this.sendJson(res, 200, paged, headers);
      return;
    }

    // Route: POST /api/v3/user/repos
    if (method === 'POST' && path === '/api/v3/user/repos') {
      let data: any;
      try {
        data = JSON.parse(bodyBuffer.toString('utf8'));
      } catch {
        this.sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }

      if (!data || typeof data.name !== 'string') {
        this.sendJson(res, 422, { message: 'Missing repo name' });
        return;
      }

      const repo = this.store.createRepo(this.store.viewer.login, data.name, {
        private: data.private ?? false,
        description: data.description,
      });

      this.sendJson(res, 201, repo);
      return;
    }

    // Routes starting with /api/v3/repos/:owner/:repo
    const repoMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(.*)$/);
    if (repoMatch) {
      const owner = decodeURIComponent(repoMatch[1]);
      const repoName = decodeURIComponent(repoMatch[2]);
      const restPath = repoMatch[3];

      // Ownership check: must match viewer
      if (owner.toLowerCase() !== this.store.viewer.login.toLowerCase()) {
        this.sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      const repo = this.store.getRepo(owner, repoName);
      if (!repo) {
        this.sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      this.handleRepoRoute(req, res, repo, restPath, url, method, bodyBuffer);
      return;
    }

    // Default unknown /api/v3 route: 404
    this.sendJson(res, 404, { message: 'Not Found' });
  }

  private handleRepoRoute(
    req: IncomingMessage,
    res: ServerResponse,
    repo: Repo,
    subPath: string,
    url: URL,
    method: string,
    bodyBuffer: Buffer,
  ): void {
    // GET /api/v3/repos/:o/:r
    if (subPath === '' || subPath === '/') {
      if (method === 'GET') {
        this.sendJson(res, 200, repo);
        return;
      }
      if (method === 'PATCH') {
        let data: any;
        try {
          data = JSON.parse(bodyBuffer.toString('utf8'));
        } catch {
          this.sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        if (data.description !== undefined) repo.description = data.description;
        this.sendJson(res, 200, repo);
        return;
      }
      if (method === 'DELETE') {
        this.store.deleteRepo(repo.owner.login, repo.name);
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // Branches: GET /branches, GET /branches/:branch
    if (subPath === '/branches' && method === 'GET') {
      const branches: Array<{ name: string; commit: { sha: string } }> = [];
      for (const [ref, oid] of repo.refs) {
        if (ref.startsWith('refs/heads/')) {
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
        }
      }
      // If default branch exists in head_symref but not explicit in refs
      if (branches.length === 0 && repo.refs.has('HEAD')) {
        branches.push({ name: repo.default_branch, commit: { sha: repo.refs.get('HEAD')! } });
      }
      this.sendJson(res, 200, branches);
      return;
    }

    const branchMatch = subPath.match(/^\/branches\/([^/]+)$/);
    if (branchMatch && method === 'GET') {
      const name = branchMatch[1];
      const oid = repo.refs.get(`refs/heads/${name}`) ?? (name === repo.default_branch ? repo.refs.get('HEAD') : undefined);
      if (!oid) {
        this.sendJson(res, 404, { message: 'Branch not found' });
        return;
      }
      this.sendJson(res, 200, { name, commit: { sha: oid } });
      return;
    }

    // Git refs: POST /git/refs
    if (subPath === '/git/refs' && method === 'POST') {
      let data: any;
      try {
        data = JSON.parse(bodyBuffer.toString('utf8'));
      } catch {
        this.sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      if (!data || typeof data.ref !== 'string' || typeof data.sha !== 'string') {
        this.sendJson(res, 422, { message: 'Invalid ref parameters' });
        return;
      }
      repo.refs.set(data.ref, data.sha);
      this.sendJson(res, 201, {
        ref: data.ref,
        node_id: Buffer.from(`010:Ref${data.ref}`).toString('base64'),
        url: `${url.pathname}/${data.ref}`,
        object: { sha: data.sha, type: 'commit' },
      });
      return;
    }

    // Commits: GET /commits
    if (subPath === '/commits' && method === 'GET') {
      const shaParam = url.searchParams.get('sha') ?? repo.default_branch;
      let tip = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? (shaParam === repo.default_branch ? repo.refs.get('HEAD') : undefined);
      if (!tip && repo.git_objects.has(shaParam)) tip = shaParam;

      if (!tip) {
        this.sendJson(res, 200, []);
        return;
      }

      const commitList: Array<{ sha: string; commit: any }> = [];
      const queue = [tip];
      const seen = new Set<string>();

      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (seen.has(cur)) continue;
        seen.add(cur);

        const obj = repo.git_objects.get(cur);
        if (obj && obj.type === 'commit') {
          const parsed = parseCommit(obj.data);
          commitList.push({
            sha: cur,
            commit: {
              message: parsed.message.trim(),
              author: { name: this.store.viewer.name, email: this.store.viewer.email },
              committer: { name: this.store.viewer.name, email: this.store.viewer.email },
            },
          });
          for (const p of parsed.parents) queue.push(p);
        }
      }

      this.sendJson(res, 200, commitList);
      return;
    }

    // Contents: /contents/:path
    if (subPath.startsWith('/contents')) {
      const filePath = decodeURIComponent(subPath.slice('/contents'.length).replace(/^\/+/, ''));
      this.handleContents(req, res, repo, filePath, url, method, bodyBuffer);
      return;
    }

    // Labels: POST /labels, GET /labels
    if (subPath === '/labels') {
      if (method === 'POST') {
        let data: any;
        try {
          data = JSON.parse(bodyBuffer.toString('utf8'));
        } catch {
          this.sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        if (!data || typeof data.name !== 'string') {
          this.sendJson(res, 422, { message: 'Missing label name' });
          return;
        }
        const id = repo.next_label_id++;
        const label: Label = {
          id,
          node_id: Buffer.from(`010:Label${id}`).toString('base64'),
          name: data.name,
          color: data.color ?? 'ededed',
        };
        repo.labels.set(data.name, label);
        this.sendJson(res, 201, label);
        return;
      }
      if (method === 'GET') {
        this.sendJson(res, 200, [...repo.labels.values()]);
        return;
      }
    }

    // Issues: /issues
    if (subPath === '/issues') {
      if (method === 'POST') {
        let data: any;
        try {
          data = JSON.parse(bodyBuffer.toString('utf8'));
        } catch {
          this.sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        if (!data || typeof data.title !== 'string') {
          this.sendJson(res, 422, { message: 'Missing title' });
          return;
        }

        // Validate labels
        const labelObjs: Label[] = [];
        if (Array.isArray(data.labels)) {
          for (const lName of data.labels) {
            const found = repo.labels.get(lName);
            if (!found) {
              this.sendJson(res, 422, { message: `Label '${lName}' does not exist` });
              return;
            }
            labelObjs.push(found);
          }
        }

        const number = repo.next_issue_number++;
        const now = this.store.nowIso();
        const issue: Issue = {
          id: number,
          node_id: Buffer.from(`010:Issue${number}`).toString('base64'),
          number,
          title: data.title,
          body: data.body ?? '',
          state: 'open',
          labels: labelObjs,
          user: { login: this.store.viewer.login, id: this.store.viewer.id },
          created_at: now,
          updated_at: now,
          closed_at: null,
          comments: [],
        };
        repo.issues.set(number, issue);
        this.sendJson(res, 201, issue);
        return;
      }

      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const sort = url.searchParams.get('sort') ?? 'created';
        const direction = url.searchParams.get('direction') ?? 'desc';

        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');

        if (direction === 'asc') list.sort((a, b) => a.number - b.number);
        else list.sort((a, b) => b.number - a.number);

        this.sendJson(res, 200, list);
        return;
      }
    }

    // Issue by number: /issues/:number
    const issueMatch = subPath.match(/^\/issues\/(\d+)(.*)$/);
    if (issueMatch) {
      const num = parseInt(issueMatch[1], 10);
      const issueRest = issueMatch[2];
      const issue = repo.issues.get(num);
      if (!issue) {
        this.sendJson(res, 404, { message: 'Issue not found' });
        return;
      }

      if (issueRest === '' || issueRest === '/') {
        if (method === 'GET') {
          this.sendJson(res, 200, issue);
          return;
        }
        if (method === 'PATCH') {
          let data: any;
          try {
            data = JSON.parse(bodyBuffer.toString('utf8'));
          } catch {
            this.sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          if (data.state === 'closed') {
            issue.state = 'closed';
            issue.closed_at = this.store.nowIso();
          } else if (data.state === 'open') {
            issue.state = 'open';
            issue.closed_at = null;
          }
          if (typeof data.title === 'string') issue.title = data.title;
          if (typeof data.body === 'string') issue.body = data.body;
          issue.updated_at = this.store.nowIso();
          this.sendJson(res, 200, issue);
          return;
        }
      }

      if (issueRest === '/comments') {
        if (method === 'POST') {
          let data: any;
          try {
            data = JSON.parse(bodyBuffer.toString('utf8'));
          } catch {
            this.sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          if (!data || typeof data.body !== 'string') {
            this.sendJson(res, 422, { message: 'Missing comment body' });
            return;
          }
          const id = repo.next_comment_id++;
          const now = this.store.nowIso();
          const comment = {
            id,
            node_id: Buffer.from(`010:IssueComment${id}`).toString('base64'),
            body: data.body,
            user: { login: this.store.viewer.login, id: this.store.viewer.id },
            created_at: now,
            updated_at: now,
          };
          issue.comments.push(comment);
          this.sendJson(res, 201, comment);
          return;
        }
        if (method === 'GET') {
          this.sendJson(res, 200, issue.comments);
          return;
        }
      }
    }

    // Pull Requests: /pulls
    if (subPath === '/pulls') {
      if (method === 'POST') {
        let data: any;
        try {
          data = JSON.parse(bodyBuffer.toString('utf8'));
        } catch {
          this.sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        if (!data || !data.head || !data.base || !data.title) {
          this.sendJson(res, 422, { message: 'Missing PR fields' });
          return;
        }

        const headSha = repo.refs.get(`refs/heads/${data.head}`) ?? repo.refs.get(data.head);
        const baseSha = repo.refs.get(`refs/heads/${data.base}`) ?? repo.refs.get(data.base) ?? repo.refs.get('HEAD');

        if (!headSha || !baseSha) {
          this.sendJson(res, 422, { message: 'Invalid head or base ref' });
          return;
        }

        const number = repo.next_pr_number++;
        const now = this.store.nowIso();
        const pr: PullRequest = {
          id: number,
          node_id: Buffer.from(`010:PullRequest${number}`).toString('base64'),
          number,
          title: data.title,
          body: data.body ?? '',
          state: 'open',
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          head: { ref: data.head, sha: headSha },
          base: { ref: data.base, sha: baseSha },
          mergeable: true,
          user: { login: this.store.viewer.login, id: this.store.viewer.id },
          created_at: now,
          updated_at: now,
          closed_at: null,
        };
        repo.pull_requests.set(number, pr);
        this.sendJson(res, 201, pr);
        return;
      }

      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = [...repo.pull_requests.values()];
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        this.sendJson(res, 200, list);
        return;
      }
    }

    // Pull request by number: /pulls/:number
    const prMatch = subPath.match(/^\/pulls\/(\d+)(.*)$/);
    if (prMatch) {
      const num = parseInt(prMatch[1], 10);
      const prRest = prMatch[2];
      const pr = repo.pull_requests.get(num);
      if (!pr) {
        this.sendJson(res, 404, { message: 'Pull request not found' });
        return;
      }

      if (prRest === '' || prRest === '/') {
        if (method === 'GET') {
          this.sendJson(res, 200, pr);
          return;
        }
      }

      if (prRest === '/files' && method === 'GET') {
        const changed = this.store.getChangedFilesBetween(repo, pr.base.sha, pr.head.sha);
        this.sendJson(res, 200, changed);
        return;
      }

      if (prRest === '/merge' && method === 'PUT') {
        this.handleMergePull(req, res, repo, pr);
        return;
      }
    }

    this.sendJson(res, 404, { message: 'Not Found' });
  }

  private handleContents(
    req: IncomingMessage,
    res: ServerResponse,
    repo: Repo,
    filePath: string,
    url: URL,
    method: string,
    bodyBuffer: Buffer,
  ): void {
    if (method === 'PUT') {
      let data: any;
      try {
        data = JSON.parse(bodyBuffer.toString('utf8'));
      } catch {
        this.sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }

      const branch = data.branch ?? repo.default_branch;
      const branchRef = `refs/heads/${branch}`;
      const currentTip = repo.refs.get(branchRef) ?? (branch === repo.default_branch ? repo.refs.get('HEAD') : undefined);

      const files = currentTip
        ? this.store.flattenTree(repo, parseCommit(repo.git_objects.get(currentTip)!.data).tree)
        : new Map();

      const existingFile = files.get(filePath);

      // Check stale sha
      if (data.sha !== undefined) {
        if (!existingFile || existingFile.oid !== data.sha) {
          this.sendJson(res, 409, { message: 'sha does not match' });
          return;
        }
      }

      const contentBuffer = Buffer.from(data.content ?? '', 'base64');
      const blobOid = hashObject('blob', contentBuffer);
      repo.git_objects.set(blobOid, { type: 'blob', data: contentBuffer });

      // Update tree
      const updatedFiles = new Map<string, { oid: string; mode: string }>();
      for (const [p, e] of files) {
        updatedFiles.set(p, { oid: e.oid, mode: e.mode });
      }
      updatedFiles.set(filePath, { oid: blobOid, mode: '100644' });

      const newTreeOid = this.store.buildTreeFromMap(repo, updatedFiles);

      const parents = currentTip ? [currentTip] : [];
      const commitData = buildCommit({
        tree: newTreeOid,
        parents,
        message: data.message ?? 'Update contents',
        author: `${this.store.viewer.name} <${this.store.viewer.email}>`,
        committer: `${this.store.viewer.name} <${this.store.viewer.email}>`,
        timestamp: this.store.nowEpochSec(),
      });
      const commitOid = hashObject('commit', commitData);
      repo.git_objects.set(commitOid, { type: 'commit', data: commitData });

      repo.refs.set(branchRef, commitOid);
      if (branch === repo.default_branch) repo.refs.set('HEAD', commitOid);

      const status = existingFile ? 200 : 201;
      const basename = filePath.split('/').filter(Boolean).pop() ?? filePath;
      this.sendJson(res, status, {
        content: {
          name: basename,
          path: filePath,
          sha: blobOid,
          size: contentBuffer.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: commitOid },
      });
      return;
    }

    if (method === 'GET') {
      const refParam = url.searchParams.get('ref') ?? repo.default_branch;
      const tip = repo.refs.get(`refs/heads/${refParam}`) ?? repo.refs.get(refParam) ?? (refParam === repo.default_branch ? repo.refs.get('HEAD') : undefined);
      if (!tip) {
        this.sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      const commitObj = repo.git_objects.get(tip);
      if (!commitObj || commitObj.type !== 'commit') {
        this.sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      const treeOid = parseCommit(commitObj.data).tree;
      const files = this.store.flattenTree(repo, treeOid);

      // Check if it's an exact file
      const exactFile = files.get(filePath);
      if (exactFile) {
        const blobObj = repo.git_objects.get(exactFile.oid);
        const data = blobObj ? blobObj.data : Buffer.alloc(0);
        const basename = filePath.split('/').filter(Boolean).pop() ?? filePath;
        this.sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: basename,
          path: filePath,
          content: data.toString('base64'),
          sha: exactFile.oid,
        });
        return;
      }

      // Check if it's a directory
      const dirPrefix = filePath ? (filePath.endsWith('/') ? filePath : `${filePath}/`) : '';
      const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }>();

      for (const [p, e] of files) {
        if (dirPrefix === '' || p.startsWith(dirPrefix)) {
          const rel = dirPrefix === '' ? p : p.slice(dirPrefix.length);
          const parts = rel.split('/');
          const immediateName = parts[0];
          const immediatePath = dirPrefix ? `${dirPrefix}${immediateName}` : immediateName;

          if (parts.length === 1) {
            children.set(immediateName, {
              type: 'file',
              name: immediateName,
              path: immediatePath,
              sha: e.oid,
              size: e.size,
            });
          } else {
            children.set(immediateName, {
              type: 'dir',
              name: immediateName,
              path: immediatePath,
              sha: e.oid,
              size: 0,
            });
          }
        }
      }

      if (children.size > 0) {
        this.sendJson(res, 200, [...children.values()].sort((a, b) => a.name.localeCompare(b.name)));
        return;
      }

      this.sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (method === 'DELETE') {
      let data: any;
      try {
        data = JSON.parse(bodyBuffer.toString('utf8'));
      } catch {
        this.sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }

      const branch = data.branch ?? repo.default_branch;
      const branchRef = `refs/heads/${branch}`;
      const currentTip = repo.refs.get(branchRef) ?? (branch === repo.default_branch ? repo.refs.get('HEAD') : undefined);
      if (!currentTip) {
        this.sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      const files = this.store.flattenTree(repo, parseCommit(repo.git_objects.get(currentTip)!.data).tree);
      const existing = files.get(filePath);
      if (!existing || (data.sha && existing.oid !== data.sha)) {
        this.sendJson(res, 404, { message: 'File not found or sha mismatch' });
        return;
      }

      const updatedFiles = new Map<string, { oid: string; mode: string }>();
      for (const [p, e] of files) {
        if (p !== filePath) updatedFiles.set(p, { oid: e.oid, mode: e.mode });
      }

      const newTreeOid = this.store.buildTreeFromMap(repo, updatedFiles);
      const commitData = buildCommit({
        tree: newTreeOid,
        parents: [currentTip],
        message: data.message ?? 'Delete file',
        author: `${this.store.viewer.name} <${this.store.viewer.email}>`,
        committer: `${this.store.viewer.name} <${this.store.viewer.email}>`,
        timestamp: this.store.nowEpochSec(),
      });
      const commitOid = hashObject('commit', commitData);
      repo.git_objects.set(commitOid, { type: 'commit', data: commitData });

      repo.refs.set(branchRef, commitOid);
      if (branch === repo.default_branch) repo.refs.set('HEAD', commitOid);

      this.sendJson(res, 200, { commit: { sha: commitOid } });
      return;
    }

    this.sendJson(res, 404, { message: 'Not Found' });
  }

  private handleMergePull(
    req: IncomingMessage,
    res: ServerResponse,
    repo: Repo,
    pr: PullRequest,
  ): void {
    const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`) ?? repo.refs.get(pr.base.ref) ?? repo.refs.get('HEAD');
    const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`) ?? repo.refs.get(pr.head.ref);

    if (!baseTip || !headTip) {
      this.sendJson(res, 404, { message: 'Ref not found' });
      return;
    }

    const mergeBase = this.store.findMergeBase(repo, baseTip, headTip);
    const baseCommit = repo.git_objects.get(baseTip)!;
    const headCommit = repo.git_objects.get(headTip)!;

    const baseTreeOid = parseCommit(baseCommit.data).tree;
    const headTreeOid = parseCommit(headCommit.data).tree;

    const baseFiles = this.store.flattenTree(repo, baseTreeOid);
    const headFiles = this.store.flattenTree(repo, headTreeOid);
    const ancFiles = mergeBase
      ? this.store.flattenTree(repo, parseCommit(repo.git_objects.get(mergeBase)!.data).tree)
      : new Map();

    // Conflict detection: 3-way check
    let hasConflict = false;
    for (const [path, headEntry] of headFiles) {
      const ancEntry = ancFiles.get(path);
      const baseEntry = baseFiles.get(path);

      if (!ancEntry) {
        // Added in head
        if (baseEntry && baseEntry.oid !== headEntry.oid) {
          hasConflict = true;
          break;
        }
      } else {
        // Existed in ancestor
        if (headEntry.oid !== ancEntry.oid) {
          // Changed in head
          if (!baseEntry || baseEntry.oid !== ancEntry.oid) {
            // Changed or deleted in base
            if (!baseEntry || baseEntry.oid !== headEntry.oid) {
              hasConflict = true;
              break;
            }
          }
        }
      }
    }

    if (!hasConflict) {
      for (const [path, ancEntry] of ancFiles) {
        if (!headFiles.has(path)) {
          // Deleted in head
          const baseEntry = baseFiles.get(path);
          if (baseEntry && baseEntry.oid !== ancEntry.oid) {
            hasConflict = true;
            break;
          }
        }
      }
    }

    if (hasConflict) {
      this.sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      return;
    }

    // Merge changes into baseFiles
    const mergedFiles = new Map<string, { oid: string; mode: string }>();
    for (const [p, e] of baseFiles) {
      mergedFiles.set(p, { oid: e.oid, mode: e.mode });
    }
    for (const [p, e] of headFiles) {
      mergedFiles.set(p, { oid: e.oid, mode: e.mode });
    }
    for (const [p] of ancFiles) {
      if (!headFiles.has(p)) {
        mergedFiles.delete(p);
      }
    }

    const newTreeOid = this.store.buildTreeFromMap(repo, mergedFiles);

    const message = `Merge pull request #${pr.number} from ${pr.head.ref}\n\n${pr.title}`;
    const commitData = buildCommit({
      tree: newTreeOid,
      parents: [baseTip],
      message,
      author: `${this.store.viewer.name} <${this.store.viewer.email}>`,
      committer: `${this.store.viewer.name} <${this.store.viewer.email}>`,
      timestamp: this.store.nowEpochSec(),
    });
    const commitOid = hashObject('commit', commitData);
    repo.git_objects.set(commitOid, { type: 'commit', data: commitData });

    // Update base branch
    repo.refs.set(`refs/heads/${pr.base.ref}`, commitOid);
    if (pr.base.ref === repo.default_branch) repo.refs.set('HEAD', commitOid);

    // Update PR
    pr.state = 'closed';
    pr.merged = true;
    pr.merged_at = this.store.nowIso();
    pr.merge_commit_sha = commitOid;
    pr.closed_at = this.store.nowIso();

    this.sendJson(res, 200, {
      sha: commitOid,
      merged: true,
      message: 'Pull Request successfully merged',
    });
  }
}
