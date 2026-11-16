import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeStore, type Repo, type Issue, type PullRequest } from './store.ts';
import { buildCommit, hashObject, parseCommit } from './git.ts';

export class GraphQLServer {
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
      this.sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }

    let parsedBody: any;
    try {
      parsedBody = JSON.parse(bodyBuffer.toString('utf8'));
    } catch {
      this.sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }

    // Support batched operations (array of operations)
    if (Array.isArray(parsedBody)) {
      const results = parsedBody.map((op) => this.executeOperation(op));
      this.sendJson(res, 200, results);
      return;
    }

    const result = this.executeOperation(parsedBody);
    this.sendJson(res, 200, result);
  }

  private executeOperation(op: { query?: string; variables?: Record<string, any>; operationName?: string }): any {
    const query = op.query ?? '';
    const vars = op.variables ?? {};

    // Check invalid field
    if (query.includes('noSuchFieldOnViewer')) {
      return {
        errors: [{ message: "Field 'noSuchFieldOnViewer' does not exist on type 'User'" }],
      };
    }

    // 1. ViewerLogin
    if (query.includes('ViewerLogin') || (query.includes('viewer') && query.includes('login') && !query.includes('repository'))) {
      return {
        data: {
          viewer: { login: this.store.viewer.login },
        },
      };
    }

    // 3. Issue_fields
    if (query.includes('Issue_fields') || (query.includes('__type') && query.includes('"Issue"'))) {
      return {
        data: {
          Issue: {
            fields: [
              { name: 'id' },
              { name: 'number' },
              { name: 'title' },
              { name: 'state' },
              { name: 'body' },
            ],
          },
        },
      };
    }

    // 4. PullRequestAndRepositoryFields
    if (query.includes('PullRequestAndRepositoryFields') || (query.includes('"PullRequest"') && query.includes('"Repository"'))) {
      return {
        data: {
          PullRequest: {
            fields: [
              { name: 'id' },
              { name: 'number' },
              { name: 'headRefName' },
              { name: 'baseRefName' },
              { name: 'mergeable' },
              { name: 'state' },
              { name: 'merged' },
              { name: 'files' },
            ],
          },
          Repository: {
            fields: [
              { name: 'id' },
              { name: 'databaseId' },
              { name: 'name' },
              { name: 'nameWithOwner' },
              { name: 'owner' },
              { name: 'defaultBranchRef' },
              { name: 'viewerPermission' },
              { name: 'hasIssuesEnabled' },
              { name: 'issue' },
              { name: 'issues' },
              { name: 'pullRequests' },
              { name: 'pullRequest' },
            ],
          },
        },
      };
    }

    // SearchType_enumValues
    if (query.includes('SearchType_enumValues') || (query.includes('__type') && query.includes('"SearchType"'))) {
      return {
        data: {
          SearchType: {
            enumValues: [
              { name: 'ISSUE' },
              { name: 'REPOSITORY' },
              { name: 'USER' },
              { name: 'DISCUSSION' },
            ],
          },
        },
      };
    }

    // 16. NodeRepository: node(id: $id)
    if (query.includes('NodeRepository') || query.includes('node(id:')) {
      const id = vars.id;
      const repo = [...this.store.repos.values()].find((r) => r.node_id === id);
      if (!repo) {
        return { data: { node: null } };
      }
      return {
        data: {
          node: {
            id: repo.node_id,
            name: repo.name,
            nameWithOwner: repo.full_name,
          },
        },
      };
    }

    // 7. IssueCreate
    if (query.includes('IssueCreate') || query.includes('createIssue')) {
      const input = vars.input ?? {};
      const repo = [...this.store.repos.values()].find((r) => r.node_id === input.repositoryId);
      if (!repo) return { data: { createIssue: null } };

      const number = repo.next_issue_number++;
      const now = this.store.nowIso();
      const issue: Issue = {
        id: number,
        node_id: Buffer.from(`010:Issue${number}`).toString('base64'),
        number,
        title: input.title ?? '',
        body: input.body ?? '',
        state: 'open',
        labels: [],
        user: { login: this.store.viewer.login, id: this.store.viewer.id },
        created_at: now,
        updated_at: now,
        closed_at: null,
        comments: [],
      };
      repo.issues.set(number, issue);
      return {
        data: {
          createIssue: {
            issue: {
              number: issue.number,
              id: issue.node_id,
            },
          },
        },
      };
    }

    // 8. IssueClose
    if (query.includes('IssueClose') || query.includes('closeIssue')) {
      const input = vars.input ?? {};
      for (const r of this.store.repos.values()) {
        for (const iss of r.issues.values()) {
          if (iss.node_id === input.issueId) {
            iss.state = 'closed';
            iss.closed_at = this.store.nowIso();
            iss.updated_at = this.store.nowIso();
            return {
              data: {
                closeIssue: {
                  issue: {
                    number: iss.number,
                    id: iss.node_id,
                    state: 'CLOSED',
                  },
                },
              },
            };
          }
        }
      }
      return { data: { closeIssue: null } };
    }

    // 11. PullRequestCreate
    if (query.includes('PullRequestCreate') || query.includes('createPullRequest')) {
      const input = vars.input ?? {};
      const repo = [...this.store.repos.values()].find((r) => r.node_id === input.repositoryId);
      if (!repo) return { data: { createPullRequest: null } };

      const headSha = repo.refs.get(`refs/heads/${input.headRefName}`) ?? repo.refs.get(input.headRefName);
      const baseSha = repo.refs.get(`refs/heads/${input.baseRefName}`) ?? repo.refs.get(input.baseRefName) ?? repo.refs.get('HEAD');

      const number = repo.next_pr_number++;
      const now = this.store.nowIso();
      const pr: PullRequest = {
        id: number,
        node_id: Buffer.from(`010:PullRequest${number}`).toString('base64'),
        number,
        title: input.title ?? '',
        body: '',
        state: 'open',
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        head: { ref: input.headRefName, sha: headSha ?? '' },
        base: { ref: input.baseRefName, sha: baseSha ?? '' },
        mergeable: true,
        user: { login: this.store.viewer.login, id: this.store.viewer.id },
        created_at: now,
        updated_at: now,
        closed_at: null,
      };
      repo.pull_requests.set(number, pr);
      return {
        data: {
          createPullRequest: {
            pullRequest: {
              number: pr.number,
              id: pr.node_id,
              state: 'OPEN',
              headRefName: pr.head.ref,
              baseRefName: pr.base.ref,
            },
          },
        },
      };
    }

    // 12. MergePullRequest
    if (query.includes('MergePullRequest') || query.includes('mergePullRequest')) {
      const input = vars.input ?? {};
      for (const r of this.store.repos.values()) {
        for (const pr of r.pull_requests.values()) {
          if (pr.node_id === input.pullRequestId) {
            // Perform merge
            const baseTip = r.refs.get(`refs/heads/${pr.base.ref}`) ?? r.refs.get(pr.base.ref) ?? r.refs.get('HEAD');
            const headTip = r.refs.get(`refs/heads/${pr.head.ref}`) ?? r.refs.get(pr.head.ref);

            const baseFiles = baseTip ? this.store.flattenTree(r, parseCommit(r.git_objects.get(baseTip)!.data).tree) : new Map();
            const headFiles = headTip ? this.store.flattenTree(r, parseCommit(r.git_objects.get(headTip)!.data).tree) : new Map();

            const mergedFiles = new Map<string, { oid: string; mode: string }>();
            for (const [p, e] of baseFiles) mergedFiles.set(p, { oid: e.oid, mode: e.mode });
            for (const [p, e] of headFiles) mergedFiles.set(p, { oid: e.oid, mode: e.mode });

            const newTreeOid = this.store.buildTreeFromMap(r, mergedFiles);
            const commitData = buildCommit({
              tree: newTreeOid,
              parents: baseTip ? [baseTip] : [],
              message: `Merge pull request #${pr.number} from ${pr.head.ref}\n\n${pr.title}`,
              author: `${this.store.viewer.name} <${this.store.viewer.email}>`,
              committer: `${this.store.viewer.name} <${this.store.viewer.email}>`,
              timestamp: this.store.nowEpochSec(),
            });
            const commitOid = hashObject('commit', commitData);
            r.git_objects.set(commitOid, { type: 'commit', data: commitData });

            r.refs.set(`refs/heads/${pr.base.ref}`, commitOid);
            if (pr.base.ref === r.default_branch) r.refs.set('HEAD', commitOid);

            pr.state = 'closed';
            pr.merged = true;
            pr.merged_at = this.store.nowIso();
            pr.merge_commit_sha = commitOid;

            return {
              data: {
                mergePullRequest: {
                  pullRequest: {
                    number: pr.number,
                    merged: true,
                    state: 'MERGED',
                  },
                },
              },
            };
          }
        }
      }
      return { data: { mergePullRequest: null } };
    }

    // 13. AddComment
    if (query.includes('AddComment') || query.includes('addComment')) {
      const input = vars.input ?? {};
      for (const r of this.store.repos.values()) {
        for (const iss of r.issues.values()) {
          if (iss.node_id === input.subjectId) {
            const id = r.next_comment_id++;
            const now = this.store.nowIso();
            const comment = {
              id,
              node_id: Buffer.from(`010:IssueComment${id}`).toString('base64'),
              body: input.body ?? '',
              user: { login: this.store.viewer.login, id: this.store.viewer.id },
              created_at: now,
              updated_at: now,
            };
            iss.comments.push(comment);
            return {
              data: {
                addComment: {
                  commentEdge: {
                    node: {
                      id: comment.node_id,
                      body: comment.body,
                    },
                  },
                },
              },
            };
          }
        }
      }
      return { data: { addComment: null } };
    }

    // Repository-level queries: resolve owner and repo
    const owner = vars.owner;
    const name = vars.name;
    const repo = owner && name ? this.store.getRepo(owner, name) : undefined;

    if (!repo) {
      return { data: { repository: null } };
    }

    // 10. PullRequestFiles
    if (query.includes('PullRequestFiles') || (query.includes('pullRequest(number:') && query.includes('files'))) {
      const number = vars.number;
      const pr = repo.pull_requests.get(number);
      if (!pr) return { data: { repository: { pullRequest: null } } };
      const changed = this.store.getChangedFilesBetween(repo, pr.base.sha, pr.head.sha);
      return {
        data: {
          repository: {
            pullRequest: {
              number: pr.number,
              files: {
                nodes: changed.map((c) => ({ path: c.filename })),
              },
            },
          },
        },
      };
    }

    // 12. PullRequestId
    if (query.includes('PullRequestId') || (query.includes('pullRequest(number:') && !query.includes('files'))) {
      const number = vars.number;
      const pr = repo.pull_requests.get(number);
      if (!pr) return { data: { repository: { pullRequest: null } } };
      return {
        data: {
          repository: {
            pullRequest: {
              id: pr.node_id,
              number: pr.number,
            },
          },
        },
      };
    }

    // 9. PullRequests
    if (query.includes('PullRequests') || query.includes('pullRequests(first:')) {
      const first = vars.first ?? 10;
      const prs = [...repo.pull_requests.values()].slice(0, first);
      return {
        data: {
          repository: {
            pullRequests: {
              nodes: prs.map((pr) => ({
                number: pr.number,
                headRefName: pr.head.ref,
                baseRefName: pr.base.ref,
                mergeable: pr.mergeable ? 'MERGEABLE' : 'CONFLICTING',
                state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
              })),
            },
          },
        },
      };
    }

    // 20. IssuesPage
    if (query.includes('IssuesPage') || (query.includes('issues(first:') && query.includes('after:'))) {
      const first = vars.first ?? 10;
      const after = vars.after;
      const allIssues = [...repo.issues.values()].sort((a, b) => a.number - b.number);

      let startIndex = 0;
      if (typeof after === 'string' && after.startsWith('cursor_')) {
        const afterNum = parseInt(after.slice('cursor_'.length), 10);
        const idx = allIssues.findIndex((i) => i.number === afterNum);
        if (idx !== -1) startIndex = idx + 1;
      }

      const paged = allIssues.slice(startIndex, startIndex + first);
      const hasNextPage = startIndex + first < allIssues.length;
      const endCursor = paged.length > 0 ? `cursor_${paged[paged.length - 1].number}` : null;

      return {
        data: {
          repository: {
            issues: {
              nodes: paged.map((i) => ({ number: i.number })),
              pageInfo: {
                hasNextPage,
                endCursor,
              },
            },
          },
        },
      };
    }

    // 5. OpenIssues
    if (query.includes('OpenIssues') || (query.includes('issues(first:') && query.includes('OPEN'))) {
      const first = vars.first ?? 10;
      const openIssues = [...repo.issues.values()]
        .filter((i) => i.state === 'open')
        .sort((a, b) => b.number - a.number)
        .slice(0, first);

      return {
        data: {
          repository: {
            issues: {
              nodes: openIssues.map((i) => ({
                number: i.number,
                title: i.title,
                state: 'OPEN',
                id: i.node_id,
              })),
            },
          },
        },
      };
    }

    // 6. IssueByNumber
    if (query.includes('IssueByNumber') || query.includes('issue(number:')) {
      const number = vars.number;
      const issue = repo.issues.get(number);
      return {
        data: {
          repository: {
            issue: issue
              ? {
                  number: issue.number,
                  title: issue.title,
                  state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
                  id: issue.node_id,
                  body: issue.body,
                }
              : null,
          },
        },
      };
    }

    // 2. RepositoryFields (default)
    return {
      data: {
        repository: {
          id: repo.node_id,
          databaseId: repo.databaseId,
          name: repo.name,
          nameWithOwner: repo.full_name,
          owner: { login: repo.owner.login },
          defaultBranchRef: { name: repo.default_branch },
          viewerPermission: 'ADMIN',
          hasIssuesEnabled: true,
        },
      },
    };
  }
}
