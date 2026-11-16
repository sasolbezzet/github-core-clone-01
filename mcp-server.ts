import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeStore, type Repo, type Issue, type PullRequest } from './store.ts';
import { buildCommit, hashObject, parseCommit } from './git.ts';

export class McpServer {
  constructor(private readonly store: ForgeStore) {}

  sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body) + '\n';
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  handle(req: IncomingMessage, res: ServerResponse, bodyBuffer: Buffer): void {
    const auth = req.headers.authorization;
    const expectedToken = process.env.MAKEFUN_SHOP_TOKEN || '';
    if (expectedToken && auth !== `Bearer ${expectedToken}`) {
      this.sendJson(res, 401, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unauthorized' },
      });
      return;
    }

    let parsedBody: any;
    try {
      parsedBody = JSON.parse(bodyBuffer.toString('utf8'));
    } catch {
      this.sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    const id = parsedBody.id ?? null;
    const method = parsedBody.method;

    if (method === 'server/discover') {
      this.sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: ['2026-07-28', '2025-11-25'],
          capabilities: { tools: {} },
          serverInfo: { name: 'github-core-clone', version: '1.0.0' },
          instructions: 'GitHub Forge MCP Server',
        },
      });
      return;
    }

    if (method === 'initialize') {
      this.sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'github-core-clone', version: '1.0.0' },
          instructions: 'GitHub Forge MCP Server',
        },
      });
      return;
    }

    if (method === 'notifications/initialized') {
      this.sendJson(res, 200, { jsonrpc: '2.0', result: {} });
      return;
    }

    if (method === 'tools/list') {
      this.sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'create_repo',
              description: 'Create a new repository',
              inputSchema: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Repository name' },
                  description: { type: 'string', description: 'Repository description' },
                  private: { type: 'boolean', description: 'Whether the repository is private' },
                },
                required: ['name'],
              },
            },
            {
              name: 'get_repo',
              description: 'Get repository information',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: { type: 'string', description: 'Repository owner' },
                  repo: { type: 'string', description: 'Repository name' },
                  full_name: { type: 'string', description: 'Full owner/name format' },
                },
                required: ['owner', 'repo'],
              },
            },
            {
              name: 'create_issue',
              description: 'Create an issue in a repository',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: { type: 'string', description: 'Repository owner' },
                  repo: { type: 'string', description: 'Repository name' },
                  title: { type: 'string', description: 'Issue title' },
                  body: { type: 'string', description: 'Issue body' },
                },
                required: ['owner', 'repo', 'title'],
              },
            },
            {
              name: 'list_issues',
              description: 'List issues in a repository',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: { type: 'string', description: 'Repository owner' },
                  repo: { type: 'string', description: 'Repository name' },
                  state: { type: 'string', description: 'State: open, closed, or all' },
                },
                required: ['owner', 'repo'],
              },
            },
            {
              name: 'create_pull_request',
              description: 'Create a pull request in a repository',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: { type: 'string', description: 'Repository owner' },
                  repo: { type: 'string', description: 'Repository name' },
                  title: { type: 'string', description: 'Pull request title' },
                  head: { type: 'string', description: 'Head branch' },
                  base: { type: 'string', description: 'Base branch' },
                },
                required: ['owner', 'repo', 'title', 'head', 'base'],
              },
            },
            {
              name: 'merge_pull_request',
              description: 'Merge a pull request in a repository',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: { type: 'string', description: 'Repository owner' },
                  repo: { type: 'string', description: 'Repository name' },
                  pull_number: { type: 'integer', description: 'Pull request number' },
                },
                required: ['owner', 'repo', 'pull_number'],
              },
            },
          ],
        },
      });
      return;
    }

    if (method === 'tools/call') {
      const params = parsedBody.params ?? {};
      const toolName = params.name ?? '';
      const args = params.arguments ?? {};

      this.executeToolCall(res, id, toolName, args);
      return;
    }

    this.sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  private executeToolCall(res: ServerResponse, id: any, rawName: string, args: Record<string, any>): void {
    const name = this.normalizeToolName(rawName);

    if (!name) {
      this.sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${rawName}` },
      });
      return;
    }

    // Resolve owner and repo from args or full_name
    let owner = args.owner ?? args.owner_login ?? this.store.viewer.login;
    let repoName = args.repo ?? args.repository ?? args.name;

    if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
      const [o, r] = args.full_name.split('/', 2);
      if (o && r) {
        owner = o;
        repoName = r;
      }
    }

    if (name === 'create_repo') {
      const repoNameInput = args.name ?? args.repo;
      if (!repoNameInput || typeof repoNameInput !== 'string') {
        this.sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'Missing required argument: name' }] },
        });
        return;
      }
      const repo = this.store.createRepo(owner, repoNameInput, {
        description: args.description,
        private: args.private ?? false,
      });
      this.sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(repo) }],
        },
      });
      return;
    }

    if (name === 'get_repo') {
      if (!repoName) {
        this.sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'Missing required argument: repo' }] },
        });
        return;
      }
      const repo = this.store.getRepo(owner, repoName);
      if (!repo) {
        this.sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'Repository not found' }] },
        });
        return;
      }
      this.sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(repo) }],
        },
      });
      return;
    }

    if (name === 'create_issue') {
      if (!repoName || !args.title) {
        this.sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'Missing required arguments: repo, title' }] },
        });
        return;
      }
      const repo = this.store.getRepo(owner, repoName);
      if (!repo) {
        this.sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'Repository not found' }] },
        });
        return;
      }

      const number = repo.next_issue_number++;
      const now = this.store.nowIso();
      const issue: Issue = {
        id: number,
        node_id: Buffer.from(`010:Issue${number}`).toString('base64'),
        number,
        title: args.title,
        body: args.body ?? '',
        state: 'open',
        labels: [],
        user: { login: this.store.viewer.login, id: this.store.viewer.id },
        created_at: now,
        updated_at: now,
        closed_at: null,
        comments: [],
      };
      repo.issues.set(number, issue);
      this.sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(issue) }],
        },
      });
      return;
    }

    if (name === 'list_issues') {
      if (!repoName) {
        this.sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'Missing required argument: repo' }] },
        });
        return;
      }
      const repo = this.store.getRepo(owner, repoName);
      if (!repo) {
        this.sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'Repository not found' }] },
        });
        return;
      }

      const state = args.state ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');

      this.sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(issues) }],
        },
      });
      return;
    }

    if (name === 'create_pull_request') {
      if (!repoName || !args.title || !args.head || !args.base) {
        this.sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'Missing required PR arguments' }] },
        });
        return;
      }
      const repo = this.store.getRepo(owner, repoName);
      if (!repo) {
        this.sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'Repository not found' }] },
        });
        return;
      }

      const headSha = repo.refs.get(`refs/heads/${args.head}`) ?? repo.refs.get(args.head);
      const baseSha = repo.refs.get(`refs/heads/${args.base}`) ?? repo.refs.get(args.base) ?? repo.refs.get('HEAD');

      const number = repo.next_pr_number++;
      const now = this.store.nowIso();
      const pr: PullRequest = {
        id: number,
        node_id: Buffer.from(`010:PullRequest${number}`).toString('base64'),
        number,
        title: args.title,
        body: args.body ?? '',
        state: 'open',
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        head: { ref: args.head, sha: headSha ?? '' },
        base: { ref: args.base, sha: baseSha ?? '' },
        mergeable: true,
        user: { login: this.store.viewer.login, id: this.store.viewer.id },
        created_at: now,
        updated_at: now,
        closed_at: null,
      };
      repo.pull_requests.set(number, pr);
      this.sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(pr) }],
        },
      });
      return;
    }

    if (name === 'merge_pull_request') {
      const pullNumber = args.pull_number ?? args.number ?? args.pull_request_number;
      if (!repoName || pullNumber === undefined) {
        this.sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'Missing required arguments: repo, pull_number' }] },
        });
        return;
      }
      const repo = this.store.getRepo(owner, repoName);
      if (!repo) {
        this.sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'Repository not found' }] },
        });
        return;
      }
      const pr = repo.pull_requests.get(Number(pullNumber));
      if (!pr) {
        this.sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'Pull request not found' }] },
        });
        return;
      }

      // Execute squash merge
      const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`) ?? repo.refs.get(pr.base.ref) ?? repo.refs.get('HEAD');
      const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`) ?? repo.refs.get(pr.head.ref);

      const baseFiles = baseTip ? this.store.flattenTree(repo, parseCommit(repo.git_objects.get(baseTip)!.data).tree) : new Map();
      const headFiles = headTip ? this.store.flattenTree(repo, parseCommit(repo.git_objects.get(headTip)!.data).tree) : new Map();

      const mergedFiles = new Map<string, { oid: string; mode: string }>();
      for (const [p, e] of baseFiles) mergedFiles.set(p, { oid: e.oid, mode: e.mode });
      for (const [p, e] of headFiles) mergedFiles.set(p, { oid: e.oid, mode: e.mode });

      const newTreeOid = this.store.buildTreeFromMap(repo, mergedFiles);
      const commitData = buildCommit({
        tree: newTreeOid,
        parents: baseTip ? [baseTip] : [],
        message: `Merge pull request #${pr.number} from ${pr.head.ref}\n\n${pr.title}`,
        author: `${this.store.viewer.name} <${this.store.viewer.email}>`,
        committer: `${this.store.viewer.name} <${this.store.viewer.email}>`,
        timestamp: this.store.nowEpochSec(),
      });
      const commitOid = hashObject('commit', commitData);
      repo.git_objects.set(commitOid, { type: 'commit', data: commitData });

      repo.refs.set(`refs/heads/${pr.base.ref}`, commitOid);
      if (pr.base.ref === repo.default_branch) repo.refs.set('HEAD', commitOid);

      pr.state = 'closed';
      pr.merged = true;
      pr.merged_at = this.store.nowIso();
      pr.merge_commit_sha = commitOid;

      this.sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ merged: true, sha: commitOid }) }],
        },
      });
      return;
    }

    this.sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown tool: ${rawName}` },
    });
  }

  private normalizeToolName(name: string): string | null {
    const lower = name.toLowerCase();
    const candidates = [
      'create_repo',
      'get_repo',
      'create_issue',
      'list_issues',
      'create_pull_request',
      'merge_pull_request',
    ];

    for (const c of candidates) {
      if (lower === c || lower.endsWith(`_${c}`) || lower.endsWith(`__${c}`)) return c;
    }

    // Aliases
    if (lower.includes('create_repo') || lower.includes('create_repository') || lower.includes('repo_create')) return 'create_repo';
    if (lower.includes('get_repo') || lower.includes('get_repository') || lower.includes('repo_get')) return 'get_repo';
    if (lower.includes('create_issue') || lower.includes('issue_create')) return 'create_issue';
    if (lower.includes('list_issues') || lower.includes('issue_list') || lower.includes('issues_list')) return 'list_issues';
    if (lower.includes('create_pull_request') || lower.includes('create_pr') || lower.includes('pr_create')) return 'create_pull_request';
    if (lower.includes('merge_pull_request') || lower.includes('merge_pr') || lower.includes('pr_merge')) return 'merge_pull_request';

    return null;
  }
}
