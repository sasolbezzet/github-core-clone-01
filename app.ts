import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ForgeStore } from './store.ts';
import { GitServer } from './git-server.ts';
import { RestServer } from './rest-server.ts';
import { GraphQLServer } from './graphql-server.ts';
import { McpServer } from './mcp-server.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

let requestIdCounter = 0;

export function createApp(): Server {
  const store = new ForgeStore();
  const gitServer = new GitServer(store);
  const restServer = new RestServer(store);
  const graphqlServer = new GraphQLServer(store);
  const mcpServer = new McpServer(store);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // Non-empty X-GitHub-Request-Id header on every response
    const reqId = randomUUID().replace(/-/g, '') || `req_${++requestIdCounter}`;
    res.setHeader('x-github-request-id', reqId);

    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // Health probe: GET /healthz
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Accumulate request body
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });

    req.on('end', () => {
      const bodyBuffer = Buffer.concat(chunks);
      let url: URL;
      try {
        url = new URL(req.url ?? '/', `http://${req.headers.host || '127.0.0.1'}`);
      } catch {
        sendJson(res, 400, { message: 'Bad request URL' });
        return;
      }

      // Smart HTTP git surface: /:owner/:repo.git/...
      const gitMatch = path.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repo = decodeURIComponent(gitMatch[2]);
        const sub = gitMatch[3];

        if (sub === 'info/refs') {
          const service = url.searchParams.get('service') ?? '';
          gitServer.handleInfoRefs(req, res, owner, repo, service);
          return;
        }

        if (sub === 'git-upload-pack') {
          gitServer.handleUploadPack(req, res, owner, repo, bodyBuffer);
          return;
        }

        if (sub === 'git-receive-pack') {
          gitServer.handleReceivePack(req, res, owner, repo, bodyBuffer);
          return;
        }
      }

      // REST v3 surface: /api/v3/...
      if (path.startsWith('/api/v3')) {
        restServer.handle(req, res, url, bodyBuffer);
        return;
      }

      // GraphQL v4 surface: /api/graphql
      if (path === '/api/graphql') {
        graphqlServer.handle(req, res, bodyBuffer);
        return;
      }

      // MCP surface: /mcp
      if (path === '/mcp') {
        mcpServer.handle(req, res, bodyBuffer);
        return;
      }

      // Everything else: GitHub's 404
      sendJson(res, 404, { message: 'Not Found' });
    });
  });
}
