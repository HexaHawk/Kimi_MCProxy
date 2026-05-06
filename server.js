#!/usr/bin/env node
/**
 * Kimi MCP Router Proxy
 *
 * Routes MCP tool calls to different backend servers based on the
 * active project working directory, polled from Kimi Code Web UI.
 *
 * Usage:
 *   node server.js
 *
 * Env:
 *   MCP_ROUTES_CONFIG  – path to mcp-routes.json (default: ./mcp-routes.json)
 *   MCP_PROXY_PORT     – port to listen on (default: 3456)
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

/* ── Config ── */
const CONFIG_PATH = process.env.MCP_ROUTES_CONFIG || path.join(__dirname, 'mcp-routes.json');
const PORT = parseInt(process.env.MCP_PROXY_PORT || '3456', 10);

let routes = [];

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('Config must be a JSON array');
    }
    routes = parsed;
    console.log(`[Proxy] Loaded ${routes.length} route(s) from ${CONFIG_PATH}`);
  } catch (e) {
    console.error('[Proxy] Failed to load config:', e.message);
  }
}

loadConfig();

// Hot-reload config when file changes
fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
  console.log('[Proxy] Config file changed, reloading...');
  loadConfig();
});

/* ── Utils ── */
function expandPath(p) {
  if (!p) return p;
  if (p.startsWith('~')) {
    p = os.homedir() + p.slice(1);
  }
  return path.resolve(p);
}

function findRoute(workDir) {
  let best = null;
  let bestLen = -1;
  for (const route of routes) {
    const dir = expandPath(route.directory);
    if (workDir && workDir.startsWith(dir) && dir.length > bestLen) {
      bestLen = dir.length;
      best = route;
    }
  }
  return best;
}

/* ── Session state ── */
const sessions = new Map();

async function closeBackends(session) {
  for (const [name, backend] of session.backends) {
    try {
      await backend.client.close();
      console.log(`[Proxy] Disconnected from backend "${name}"`);
    } catch (e) {
      // ignore
    }
  }
  session.backends.clear();
}

async function connectRouteBackends(session, route) {
  for (const [name, cfg] of Object.entries(route.mcp || {})) {
    if (cfg.enabled === false) continue;

    try {
      const client = new Client({ name: 'kcode-proxy-client', version: '1.0.0' });
      let transport;

      if (cfg.type === 'remote') {
        transport = new SSEClientTransport(new URL(cfg.url), {
          requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        });
      } else if (cfg.type === 'streamableHttp') {
        transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        });
      } else if (cfg.type === 'stdio') {
        transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args || [],
          env: cfg.env,
          cwd: cfg.cwd,
        });
      } else {
        console.error(`[Proxy] Unsupported MCP type "${cfg.type}" for backend "${name}". Supported: remote, streamableHttp, stdio`);
        continue;
      }

      await client.connect(transport);
      const toolsResult = await client.listTools();

      session.backends.set(name, {
        client,
        tools: toolsResult.tools || [],
      });
      console.log(
        `[Proxy] Connected to backend "${name}" (${toolsResult.tools?.length || 0} tools)`
      );
    } catch (e) {
      console.error(`[Proxy] Failed to connect to backend "${name}":`, e.message);
    }
  }
}

async function connectAllBackends(session) {
  console.log(`[Proxy] Connecting all fallback backends for session`);
  for (const route of routes) {
    await connectRouteBackends(session, route);
  }
}

async function updateSessionContext(sessionId, workDir) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.log(`[Proxy] No session ${sessionId} to update`);
    return;
  }

  await closeBackends(session);
  session.workDir = workDir;
  session.fallback = false;  // Mark as explicitly set, disable fallback timeout

  const route = findRoute(workDir);
  if (!route) {
    console.log(`[Proxy] No route for "${workDir}" — MCPs disabled`);
    try {
      if (session.server) await session.server.sendToolListChanged();
    } catch (e) {
      // Server may not be connected yet — safe to ignore
    }
    return;
  }

  console.log(`[Proxy] Activating route for "${workDir}"`);
  await connectRouteBackends(session, route);

  try {
    if (session.server) await session.server.sendToolListChanged();
  } catch (e) {
    // Server may not be connected yet — safe to ignore
  }
}

/* ── HTTP Server ── */
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const timestamp = new Date().toISOString();

  console.log(`[${timestamp}] ${req.method} ${url.pathname}${url.search}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  /* Health check */
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }

  /* Manual config reload */
  if (url.pathname === '/reload' && req.method === 'POST') {
    loadConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, routes: routes.length }));
    return;
  }

  /* SSE endpoint — Kimi Web connects here */
  if (url.pathname === '/sse' && req.method === 'GET') {
    console.log('[Proxy] New SSE connection attempt');
    const transport = new SSEServerTransport('/messages', res, {
      enableDnsRebindingProtection: false,
    });
    const sessionId = transport.sessionId;
    console.log(`[Proxy] Session ${sessionId} transport created`);

    const mcpServer = new Server(
      { name: 'kcode-mcp-proxy', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      const session = sessions.get(sessionId);
      if (!session) {
        return { tools: [] };
      }

      // If backends are still connecting, give them a moment
      let waited = 0;
      while (session.backends.size === 0 && waited < 2000) {
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }

      if (session.backends.size === 0) {
        return { tools: [] };
      }

      const allTools = [];
      for (const [backendName, backend] of session.backends) {
        for (const tool of backend.tools) {
          allTools.push({
            ...tool,
            name: `${backendName}__${tool.name}`,
          });
        }
      }
      return { tools: allTools };
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const session = sessions.get(sessionId);
      const fullName = request.params.name;
      const sep = fullName.indexOf('__');
      if (sep === -1) {
        throw new Error(`Invalid tool name format: ${fullName}`);
      }
      const backendName = fullName.slice(0, sep);
      const toolName = fullName.slice(sep + 2);

      const backend = session?.backends.get(backendName);
      if (!backend) {
        throw new Error(`Backend "${backendName}" is not connected`);
      }

      return await backend.client.callTool({
        name: toolName,
        arguments: request.params.arguments,
      });
    });

    const session = {
      transport,
      server: mcpServer,
      workDir: null,
      backends: new Map(),
      fallback: true,
    };

    sessions.set(sessionId, session);

    // Pre-connect all backends as fallback so Kimi sees tools immediately
    // even before the extension sends the workDir.
    await connectAllBackends(session);

    // If we already know the current workDir from polling, apply it immediately
    // so new sessions don't get stuck in fallback mode.
    if (lastPolledWorkDir) {
      await updateSessionContext(sessionId, lastPolledWorkDir);
    }

    // Safety net: if the poller never updates this session, disconnect
    // fallback backends after 8 seconds so tools don't leak to wrong projects.
    setTimeout(() => {
      const s = sessions.get(sessionId);
      if (s && s.fallback && s.backends.size > 0) {
        console.log(`[Proxy] Session ${sessionId} fallback timeout — disconnecting backends`);
        closeBackends(s).then(async () => {
          try {
            if (s.server) await s.server.sendToolListChanged();
          } catch (e) {
            // Server may not be connected — safe to ignore
          }
        });
      }
    }, 8000);

    transport.onclose = () => {
      console.log(`[Proxy] Session ${sessionId} transport onclose fired`);
      const s = sessions.get(sessionId);
      if (s) {
        closeBackends(s).then(() => {
          sessions.delete(sessionId);
          console.log(`[Proxy] Session ${sessionId} cleaned up`);
        });
      }
    };

    try {
      await mcpServer.connect(transport);
      console.log(`[Proxy] Session ${sessionId} mcpServer connected`);
      if (session.backends.size > 0 && session.server) {
        try {
          await session.server.sendToolListChanged();
        } catch (e) {
          // Safe to ignore
        }
      }
    } catch (e) {
      console.error(`[Proxy] Session ${sessionId} mcpServer.connect() failed:`, e.message);
      console.error(e.stack);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
      return;
    }

    console.log(`[Proxy] Session ${sessionId} connected`);
    return;
  }

  /* Message endpoint — Kimi POSTs JSON-RPC here */
  if (url.pathname === '/messages' && req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    console.log(`[Proxy] POST /messages sessionId=${sessionId}`);
    const session = sessions.get(sessionId);
    if (!session) {
      console.error(`[Proxy] Session not found: ${sessionId}`);
      res.writeHead(404);
      res.end('Session not found');
      return;
    }
    try {
      await session.transport.handlePostMessage(req, res);
    } catch (e) {
      console.error(`[Proxy] handlePostMessage error for ${sessionId}:`, e.message);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    }
    return;
  }

  /* Context endpoint — Extension signals project changes here */
  if (url.pathname === '/context' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        console.log(`[Proxy] Context update:`, data);
        const targetSessionId = data.sessionId || sessions.keys().next().value;
        if (!targetSessionId) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, note: 'No active MCP sessions' }));
          return;
        }
        await updateSessionContext(targetSessionId, data.workDir);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('[Proxy] Context update error:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  console.log(`[Proxy] 404 ${req.method} ${url.pathname}`);
  res.writeHead(404);
  res.end('Not found');
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Proxy] Port ${PORT} is already in use. Another proxy instance may be running.`);
    process.exit(1);
  }
  console.error('[Proxy] Server error:', err);
});

/* ── Kimi Web poller (replaces browser extension) ── */
const KIMI_PORT = process.env.KIMI_PORT || '5494';
let lastPolledWorkDir = null;

async function pollKimiSessions() {
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${KIMI_PORT}/api/sessions/?limit=100`, (r) => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
    });

    if (res.status !== 200) return;

    const sessionsList = JSON.parse(res.body);
    const active = sessionsList.find(s => s.is_running === true);
    if (!active) return;

    const workDir = active.work_dir || active.workDir;
    if (!workDir || workDir === lastPolledWorkDir) return;
    lastPolledWorkDir = workDir;

    // Update all active MCP sessions with the current workDir
    for (const [sessionId] of sessions) {
      await updateSessionContext(sessionId, workDir);
    }
  } catch (e) {
    // Kimi Web may not be running yet — that's fine
  }
}

setInterval(pollKimiSessions, 1000);

httpServer.listen(PORT, () => {
  console.log(`[Proxy] MCP Router running on http://localhost:${PORT}/sse`);
  console.log(`[Proxy] Extension context endpoint: POST http://localhost:${PORT}/context`);
  console.log(`[Proxy] Health check: GET http://localhost:${PORT}/health`);
  console.log(`[Proxy] Kimi poller active (http://127.0.0.1:${KIMI_PORT})`);
});
