#!/usr/bin/env bash
# pagent.sh — unified lifecycle manager for the p-agent platform.
#
#   ./pagent.sh --start    start the backend server in the background
#                          (agent loopback + Telegram bot + automations
#                          scheduler all boot with server.js)
#   ./pagent.sh --stop     gracefully stop the server (and remove the PID file)
#   ./pagent.sh --status   show PID / uptime / health
#   ./pagent.sh --models <start|stop|status>
#                           manage the two-stage cascade llama.cpp servers
#                           (llama-router on :8081, llama-primary on :8080)
#   ./pagent.sh --help     this text
#
# State: PID in data/pagent.pid, logs in data/pagent.log (both gitignored).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT="${PORT:-8888}"
DATA_DIR="$ROOT/data"
PID_FILE="$DATA_DIR/pagent.pid"
LOG_FILE="$DATA_DIR/pagent.log"
STARTUP_TIMEOUT=30
STOP_TIMEOUT=10

# ------------------------------------------------------------------ colors
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_CYAN=$'\033[36m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_BOLD=''; C_DIM=''; C_RESET=''
fi

info() { printf "${C_CYAN}%s${C_RESET}\n" "$*"; }
ok()   { printf "${C_GREEN}%s${C_RESET}\n" "$*"; }
warn() { printf "${C_YELLOW}%s${C_RESET}\n" "$*" >&2; }
err()  { printf "${C_RED}%s${C_RESET}\n" "$*" >&2; }

usage() {
  cat <<EOF
${C_BOLD}pagent.sh${C_RESET} — unified lifecycle manager for p-agent (port ${PORT})

  ${C_GREEN}--start${C_RESET}   check dependencies, start the server in the background,
          write data/pagent.pid, wait until /api/health responds
  ${C_GREEN}--stop${C_RESET}    stop the server gracefully (SIGTERM, then SIGKILL if needed),
          clean up the PID file
  ${C_GREEN}--status${C_RESET}  show PID, uptime, port and health status
  ${C_GREEN}--models${C_RESET}  manage the cascade model servers:
          start  — start llama-router (:8081) + llama-primary (:8080) units
                   and wait until both answer /health (up to 120s)
          stop   — stop both model units
          status — unit state + /health per port
  ${C_GREEN}--help${C_RESET}    this help

State: data/pagent.pid · Logs: data/pagent.log
Env:   PORT (default 8888), NO_COLOR=1 to disable colors
EOF
}

ensure_data_dir() { mkdir -p "$DATA_DIR"; }

is_pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

node_server_pids() {
  # Only report processes whose working directory IS the p-agent root. A
  # bare `pgrep -f "node server.js"` name-matches unrelated projects (e.g.
  # skills/trading-dashboard's own server.js) and wrongly blocks --start /
  # wrongly stops the user's other apps.
  local pid cwd
  for pid in $(pgrep -f "node server\.js" 2>/dev/null | grep -v '^\$\$' || true); do
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    if [ "$cwd" = "$ROOT" ]; then echo "$pid"; fi
  done
}

port_has_health() {
  command -v curl >/dev/null 2>&1 && curl -sf -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1
}

fmt_uptime() {
  local s="${1:-0}" d h m
  d=$((s / 86400)); h=$(((s % 86400) / 3600)); m=$(((s % 3600) / 60)); s=$((s % 60))
  local out=""
  [ "$d" -gt 0 ] && out="${d}d "
  [ "$h" -gt 0 ] && out="${out}${h}h "
  [ "$m" -gt 0 ] && out="${out}${m}m "
  printf '%s%ss' "$out" "$s"
}

# --- cascade model servers (systemd user units managed by p-agent) ---------
MODEL_UNITS="llama-router.service llama-primary.service"
MODEL_PORTS="8081 8080"

port_healthy() { curl -sf -m 2 "http://127.0.0.1:${1}/health" >/dev/null 2>&1; }

models_start() {
  local u
  for u in $MODEL_UNITS; do
    if ! systemctl --user status "$u" >/dev/null 2>&1; then
      warn "unit $u not found — skipped (expected $MODEL_UNITS)"
      continue
    fi
    systemctl --user start "$u"
  done
  info "waiting for model servers to answer /health (up to 120s)…"
  local i p all
  for i in $(seq 1 60); do
    all=1
    for p in $MODEL_PORTS; do port_healthy "$p" || { all=0; break; }; done
    [ "$all" -eq 1 ] && break
    sleep 2
  done
  for p in $MODEL_PORTS; do
    if port_healthy "$p"; then ok "  :${p} — online"
    else err "  :${p} — NOT answering after 120s"; fi
  done
}

models_stop() {
  for u in $MODEL_UNITS; do systemctl --user stop "$u" 2>/dev/null || true; done
  ok "model units stopped (router :8081, primary :8080)."
}

models_status() {
  local u act p
  for u in $MODEL_UNITS; do
    act="$(systemctl --user is-active "$u" 2>/dev/null || echo 'missing')"
    info "${u}: ${act}"
  done
  for p in $MODEL_PORTS; do
    if port_healthy "$p"; then ok "  :${p} — /health OK"
    else warn "  :${p} — no /health response"; fi
  done
}

cmd_models() {
  case "${1:-status}" in
    start) models_start ;;
    stop)  models_stop ;;
    status) models_status ;;
    *) err "unknown --models action: ${1:-} (start|stop|status)"; exit 2 ;;
  esac
}

# -------------------------------------------------------------------- start
cmd_start() {
  ensure_data_dir

  # 1. dependency / environment checks -------------------------------------
  if ! command -v node >/dev/null 2>&1; then
    err "node.js is not installed or not on PATH — install Node >= 18 first."
    exit 1
  fi
  if [ ! -d "$ROOT/node_modules" ]; then
    err "dependencies missing: $ROOT/node_modules not found — run 'npm install' first."
    exit 1
  fi
  if [ ! -f "$ROOT/.env" ]; then
    if [ -f "$ROOT/.env-example" ]; then
      cp "$ROOT/.env-example" "$ROOT/.env"
      warn ".env did not exist — created from .env-example. Add LLAMA_API_KEY for remote models (local llama.cpp models work without it)."
    else
      err ".env missing and no .env-example found — create .env with your configuration."
      exit 1
    fi
  fi
  if ! grep -qE '^LLAMA_API_KEY(_[A-Z0-9_]+)?=' "$ROOT/.env" 2>/dev/null; then
    warn "no LLAMA_API_KEY set in .env — remote (OpenRouter) models will not authorize; LOCAL llama.cpp models still work."
  fi

  # 2. already running? ------------------------------------------------------
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if is_pid_alive "$pid"; then
      ok "p-agent is already running (PID ${pid}, port ${PORT}) — nothing to do."
      ok "Use --status for details or --stop to restart."
      exit 0
    fi
    warn "stale PID file found (PID ${pid:-?} is not running) — removing."
    rm -f "$PID_FILE"
  fi
  local existing
  existing="$(node_server_pids)"
  if [ -n "$existing" ]; then
    warn "a server process is already running but was not started via pagent.sh: PID(s) ${existing}"
    warn "Use --status to inspect, or --stop to take it down before starting fresh."
    exit 0
  fi
  if port_has_health; then
    err "something is already answering on port ${PORT} (but not a tracked p-agent process)."
    err "Free the port first, or set PORT=<other> and try again."
    exit 1
  fi

  # 3. launch -----------------------------------------------------------------
  info "starting p-agent backend (agent loopback + Telegram bot + automations scheduler) on :${PORT} …"
  if [ ! -f "$LOG_FILE" ]; then : > "$LOG_FILE"; fi
  nohup node server.js >>"$LOG_FILE" 2>&1 &
  local pid="$!"
  echo "$pid" > "$PID_FILE"

  local i
  for i in $(seq 1 "$STARTUP_TIMEOUT"); do
    if port_has_health; then
      ok "p-agent is up — PID ${pid}, http://localhost:${PORT} (${i}s to first healthy response)"
      ok "PID file: data/pagent.pid · Logs: data/pagent.log"
      info "Telegram channel and automations scheduler confirm via --status."
      # Two-stage cascade model servers: fire the systemd units in the
      # background — p-agent's own boot hook waits for /health and warms the
      # prefixes, so this never blocks --start.
      if command -v systemctl >/dev/null 2>&1; then
        for u in $MODEL_UNITS; do
          systemctl --user status "$u" >/dev/null 2>&1 && systemctl --user start "$u" 2>/dev/null || true
        done
        info "model units started (router :8081, primary :8080) — './pagent.sh --models status' to check."
      fi
      exit 0
    fi
    if ! is_pid_alive "$pid"; then
      err "server exited during startup — last lines of data/pagent.log:"
      tail -n 15 "$LOG_FILE" 2>/dev/null | sed 's/^/    /'
      rm -f "$PID_FILE"
      exit 1
    fi
    sleep 1
  done

  err "server did not answer on :${PORT} within ${STARTUP_TIMEOUT}s (PID ${pid} still starting?) — tail of data/pagent.log:"
  tail -n 15 "$LOG_FILE" 2>/dev/null | sed 's/^/    /'
  exit 1
}

# --------------------------------------------------------------------- stop
cmd_stop() {
  ensure_data_dir
  local pids=""
  local target=""

  if [ -f "$PID_FILE" ]; then
    target="$(cat "$PID_FILE" 2>/dev/null || true)"
    if ! is_pid_alive "$target"; then
      warn "stale PID file (PID ${target:-?} not running) — removing."
      rm -f "$PID_FILE"
      target=""
    fi
  fi

  if [ -z "$target" ]; then
    pids="$(node_server_pids)"
    if [ -n "$pids" ]; then
      warn "no live PID file — found server process(es) PID ${pids} started outside pagent.sh; stopping them."
      target="$pids"
    else
      ok "p-agent is not running."
      rm -f "$PID_FILE"
      exit 0
    fi
  fi

  info "stopping p-agent (PID ${target}) …"
  # shellcheck disable=SC2086 # intentional word-split over multiple PIDs
  kill -TERM $target 2>/dev/null || true

  local i still
  for i in $(seq 1 "$STOP_TIMEOUT"); do
    still=""
    for p in $target; do is_pid_alive "$p" && still="$still $p"; done
    [ -z "$still" ] && break
    sleep 1
  done
  for p in $target; do
    if is_pid_alive "$p"; then
      warn "PID ${p} did not exit after SIGTERM — sending SIGKILL."
      kill -KILL "$p" 2>/dev/null || true
    fi
  done

  rm -f "$PID_FILE"
  if port_has_health; then
    err "port ${PORT} still answers after stop — something else may hold it."
    exit 1
  fi
  ok "p-agent stopped — Telegram poller and automations scheduler shut down with the server."
  exit 0
}

# ------------------------------------------------------------------- status
cmd_status() {
  ensure_data_dir
  local pid="" health="" uptime_s="" tracked=""

  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if ! is_pid_alive "$pid"; then
      warn "PID file exists but PID ${pid:-?} is NOT running (stale) — use --stop to clean it up."
      pid=""
    else
      tracked="yes"
      uptime_s="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"
    fi
  fi

  if [ -z "$pid" ]; then
    local existing
    existing="$(node_server_pids)"
    if [ -n "$existing" ]; then
      warn "server RUNNING but not tracked by pagent.sh (PID ${existing}, started outside the script)."
      pid="$(echo "$existing" | head -n1)"
      uptime_s="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"
    fi
  fi

  if [ -z "$pid" ]; then
    if port_has_health; then
      err "port ${PORT} answers /api/health but no p-agent process was found — check what is listening."
      exit 1
    fi
    ok "p-agent is NOT running (port ${PORT} free)."
    exit 1
  fi

  health="$(port_has_health && echo 'OK' || echo 'ERROR (no /api/health response)')"
  printf '%s\n' \
    "${C_BOLD}status:${C_RESET} ${C_GREEN}RUNNING${C_RESET} (${tracked:-unknown}/tracked)" \
    "  pid:       ${pid}" \
    "  port:      ${PORT} — health: ${health}" \
    "  uptime:    $(fmt_uptime "${uptime_s:-0}")"
  if [ -n "$uptime_s" ] && [ "$uptime_s" -gt 0 ] 2>/dev/null; then
    info "  log:       data/pagent.log"
  fi
  exit 0
}

# ----------------------------------------------------------------- dispatch
case "${1:-}" in
  --start) cmd_start ;;
  --stop)  cmd_stop ;;
  --status) cmd_status ;;
  --models) shift 2>/dev/null || true; cmd_models "${1:-status}" ;;
  --help|-h|"") usage ;;
  *) err "unknown argument: ${1:-}"; usage; exit 2 ;;
esac