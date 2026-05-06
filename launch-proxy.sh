#!/bin/bash
# Launch Kimi MCP Router Proxy + Kimi Web UI (with AFK mode)
#
# Usage:
#   ./launch-proxy.sh
#   ./launch-proxy.sh --port 3456
#   ./launch-proxy.sh --kimi-port 5494

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_PORT="${MCP_PROXY_PORT:-3456}"
KIMI_PORT="${KIMI_PORT:-5494}"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --port)
      PROXY_PORT="$2"
      shift 2
      ;;
    --kimi-port)
      KIMI_PORT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--port PROXY_PORT] [--kimi-port KIMI_PORT]"
      exit 1
      ;;
  esac
done

cd "${SCRIPT_DIR}"

# ── Pre-flight checks ──
if ! command -v node &> /dev/null; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  if ! command -v node &> /dev/null && [ -x "$HOME/.nvm/versions/node/v20.20.2/bin/node" ]; then
    export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
  fi
fi

if ! command -v node &> /dev/null; then
  echo "[Launcher] ERROR: Node.js not found. Please install Node.js 20+ or ensure nvm is loaded."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[Launcher] ERROR: node_modules/ not found."
  echo "[Launcher] Run: npm install"
  exit 1
fi

if [ ! -f "mcp-routes.json" ]; then
  echo "[Launcher] ERROR: mcp-routes.json not found."
  exit 1
fi

if ! command -v kimi &> /dev/null; then
  echo "[Launcher] ERROR: kimi command not found. Please install Kimi Code CLI."
  exit 1
fi

# ── Proxy ──
PROXY_PID=""
if curl -s "http://localhost:${PROXY_PORT}/health" > /dev/null 2>&1; then
  echo "[Launcher] Proxy already running on port ${PROXY_PORT} — reusing it"
else
  echo "[Launcher] Starting MCP Proxy on port ${PROXY_PORT}..."
  MCP_PROXY_PORT="${PROXY_PORT}" node server.js &
  PROXY_PID=$!

  for i in {1..20}; do
    if curl -s "http://localhost:${PROXY_PORT}/health" > /dev/null 2>&1; then
      echo "[Launcher] Proxy is ready"
      break
    fi
    sleep 0.2
  done
fi

# ── Kimi Web (with AFK mode) ──
KIMI_PID=""
if curl -s "http://localhost:${KIMI_PORT}/" > /dev/null 2>&1; then
  echo "[Launcher] Kimi Web already running on port ${KIMI_PORT} — reusing it"
else
  echo "[Launcher] Starting Kimi Web UI on port ${KIMI_PORT} (AFK mode enabled)..."
  kimi --afk web --port "${KIMI_PORT}" --no-open &
  KIMI_PID=$!

  for i in {1..30}; do
    if curl -s "http://localhost:${KIMI_PORT}/" > /dev/null 2>&1; then
      echo "[Launcher] Kimi Web is ready"
      break
    fi
    sleep 1
  done
fi

echo "[Launcher] All services started."
echo "  - Proxy:    http://localhost:${PROXY_PORT}/sse"
echo "  - Kimi Web: http://localhost:${KIMI_PORT}"
echo ""

# Wait for foreground processes (if we started them)
if [ -n "${KIMI_PID}" ]; then
  wait "${KIMI_PID}" || true
fi

# Only kill proxy if we started it as part of a paired launch with kimi.
# If kimi was already running, leave proxy running independently.
if [ -n "${KIMI_PID}" ] && [ -n "${PROXY_PID}" ]; then
  echo "[Launcher] Kimi Web exited. Stopping proxy..."
  kill "${PROXY_PID}" 2>/dev/null || true
  wait "${PROXY_PID}" 2>/dev/null || true
fi
echo "[Launcher] Done"
