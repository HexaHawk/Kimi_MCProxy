# Kimi MCP Router Proxy

Standalone MCP router proxy that enables **project-specific MCP servers** in Kimi Code Web UI.

---

## What This Does

Kimi Code Web loads **one global MCP config** for all sessions. This proxy dynamically switches which MCP servers are available based on the **working directory** of your active session.

| Project | MCP Servers Used |
|---------|-----------------|
| `~/Code/my-project` | Filesystem, custom backends |
| `~/Code/other-project` | Different set of tools |

---

## Project Structure

```
.
├── server.js                  # ⭐ The MCP Router Proxy
├── package.json               # Node dependencies
├── mcp-routes.example.json    # Example routing config
├── launch-proxy.sh            # Quick-start launcher
└── README.md
```

---

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Your Routes

Copy the example and edit it:

```bash
cp mcp-routes.example.json mcp-routes.json
```

Edit `mcp-routes.json`:

```json
[
  {
    "directory": "~/Code/fullstack-app",
    "mcp": {
      "fs": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Code/fullstack-app"]
      },
      "git": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-git"]
      },
      "api": {
        "type": "streamableHttp",
        "url": "http://127.0.0.1:8787",
        "enabled": true,
        "headers": {
          "Authorization": "Bearer YOUR_TOKEN_HERE"
        }
      }
    }
  },
  {
    "directory": "~/Code/static-site",
    "mcp": {
      "fs": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Code/static-site"]
      }
    }
  }
]
```

**Rules:**
- Longest directory prefix wins
- `~` expansion supported
- If directory is not listed → **no MCPs**

### 3. Register Proxy with Kimi (one time)

```bash
kimi mcp add --transport http kcode-proxy http://localhost:3456/sse
```

This makes the proxy Kimi's **only** MCP source. The proxy then delegates to the real backends.

### 4. Launch

```bash
./launch-proxy.sh
```

Or manually:

```bash
MCP_PROXY_PORT=3456 node server.js
```

---

## How It Works

```
┌─────────────┐     SSE      ┌──────────────┐     HTTP/SSE     ┌─────────────┐
│  Kimi Web   │◄────────────►│  Local Proxy │◄───────────────►│ Real MCP    │
│  (Browser)  │   MCP tools  │  :3456       │                │ Servers     |
└─────────────┘              └──────┬───────┘                └─────────────┘
                                    │
                           ┌────────▼────────┐
                           │  Kimi Session   │
                           │  Poller (reads  │
                           │   workDir)      │
                           └─────────────────┘
```

1. **Proxy** polls Kimi Web's `/api/sessions/` to detect the active session's working directory
2. **Proxy** looks up the directory in `mcp-routes.json`
3. **Proxy** connects to the matching backend MCP(s) and exposes their tools
4. **Proxy** sends `tools/list_changed` so Kimi refreshes its tool list

---

## Configuration Reference

### `mcp-routes.json`

```json
[
  {
    "directory": "~/Code/fullstack-app",
    "mcp": {
      "fs": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Code/fullstack-app"]
      },
      "git": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-git"]
      },
      "api": {
        "type": "streamableHttp",
        "url": "http://127.0.0.1:8787",
        "enabled": true,
        "headers": {
          "Authorization": "Bearer YOUR_TOKEN_HERE"
        }
      }
    }
  },
  {
    "directory": "~/Code/static-site",
    "mcp": {
      "fs": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Code/static-site"]
      }
    }
  }
]
```

| Field | Description |
|-------|-------------|
| `directory` | Absolute path or `~`-prefixed path used to match the active session's working directory. The proxy picks the route with the **longest matching prefix**. Example: `~/Code/fullstack-app` |
| `mcp` | Object where each key is a unique backend name and each value is that backend's configuration. You can define **multiple backends per project** — their tools will all be exposed to Kimi with the backend name as a prefix (e.g. `fs__read_file`). |
| `type` | Transport protocol for the backend connection. `"remote"` = legacy SSE, `"streamableHttp"` = modern HTTP streaming (recommended for remote servers), `"stdio"` = spawns a local process and communicates over stdin/stdout. |
| `url` | Backend server endpoint. Required for `remote` and `streamableHttp` types. Must include protocol, host, port, and path. Example: `http://127.0.0.1:8787` or `http://host:port/sse` |
| `command` | Executable to run when using `stdio` type. Can be a binary name on your `$PATH` or an absolute path. Example: `npx`, `node`, `/usr/local/bin/my-mcp-server` |
| `args` | Array of string arguments passed to `command`. Example: `["-y", "@modelcontextprotocol/server-filesystem", "~/Code/fullstack-app"]` |
| `cwd` | Optional working directory for the spawned `stdio` process. If omitted, the process inherits the proxy's working directory. |
| `headers` | Optional key-value object of HTTP headers sent with every request to a `remote` or `streamableHttp` backend. Commonly used for `Authorization` tokens. |
| `enabled` | Optional boolean. `true` (default) connects the backend at startup; `false` keeps the config present but skips the connection. Useful for temporarily disabling a backend without deleting its config. |

---

## Troubleshooting

**Proxy won't start:**
- Make sure Node.js is available: `node --version`
- If using nvm, ensure it's loaded in your shell

**Kimi doesn't see any tools:**
- Check proxy health: `curl http://localhost:3456/health`
- Verify `mcp-routes.json` has a matching directory
- Check proxy logs for backend connection errors

---

## Tech Stack

- **Proxy:** Node.js 20+, `@modelcontextprotocol/sdk`
- **Launcher:** Bash (macOS / Linux)
