#!/usr/bin/env bash
# Installs the Agent Host Worker as a systemd service. Outbound HTTPS only; nothing listens publicly.
# Usage: AGENT_HOST_CONTROL_PLANE=https://... AGENT_HOST_ID=... AGENT_HOST_TOKEN=... AGENT_HOST_WORKER_SRC=<url|dir> ./install-host.sh
# The credential is read from the environment, never passed on a command line or logged.
set -euo pipefail
: "${AGENT_HOST_CONTROL_PLANE:?set AGENT_HOST_CONTROL_PLANE}"
: "${AGENT_HOST_ID:?set AGENT_HOST_ID (host id registered by the operator)}"
: "${AGENT_HOST_TOKEN:?set AGENT_HOST_TOKEN (operator-issued host credential)}"
SRC="${AGENT_HOST_WORKER_SRC:-}"; SHA="${AGENT_HOST_WORKER_SHA256:-}"
ROOT=/opt/agent-host; APPS=/srv/agent-apps; USER_NAME=agent-host
log() { printf '[install] %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }
[ "$(uname -s)" = Linux ] || { echo "Linux only"; exit 1; }
case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) echo "unsupported arch $(uname -m)"; exit 1;; esac
. /etc/os-release 2>/dev/null || true
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) PKG="apt-get install -y"; apt-get update -y >/dev/null;;
  *) echo "distro ${ID:-unknown} not yet supported (Debian/Ubuntu only); see docs/install.md"; exit 1;;
esac
need() { command -v "$1" >/dev/null 2>&1; }
need curl || $PKG curl ca-certificates
need tar || $PKG tar
need node || { log "installing Node.js"; $PKG nodejs npm; }
need docker || { log "installing Docker"; $PKG docker.io; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "Node >= 20 required"; exit 1; }
id "$USER_NAME" >/dev/null 2>&1 || useradd --system --home "$ROOT" --shell /usr/sbin/nologin "$USER_NAME"
usermod -aG docker "$USER_NAME"
mkdir -p "$ROOT"/{worker,config,logs,cache,runtime} "$APPS"
if [ -d "$SRC" ]; then cp -a "$SRC"/. "$ROOT/worker/"
elif [ -n "$SRC" ]; then
  curl -fsSL "$SRC" -o /tmp/worker.tgz
  [ -n "$SHA" ] && echo "$SHA  /tmp/worker.tgz" | sha256sum -c - || { [ -z "$SHA" ] && echo "warning: no AGENT_HOST_WORKER_SHA256 given, checksum not verified" >&2 || exit 1; }
  tar -xzf /tmp/worker.tgz -C "$ROOT/worker"
else echo "set AGENT_HOST_WORKER_SRC to a worker tarball URL or directory"; exit 1; fi
umask 077
cat > "$ROOT/config/worker.env" <<ENV
AGENT_HOST_CONTROL_PLANE=$AGENT_HOST_CONTROL_PLANE
AGENT_HOST_ID=$AGENT_HOST_ID
AGENT_HOST_TOKEN=$AGENT_HOST_TOKEN
AGENT_HOST_NAME=${AGENT_HOST_NAME:-$(hostname)}
AGENT_HOST_ROOT=$ROOT
AGENT_APPS_DIR=$APPS
ENV
chown -R "$USER_NAME:$USER_NAME" "$ROOT" "$APPS"; chmod 600 "$ROOT/config/worker.env"
install -m 644 "$ROOT/worker/systemd/agent-host-worker.service" /etc/systemd/system/agent-host-worker.service
systemctl daemon-reload; systemctl enable --now agent-host-worker.service
sleep 5
systemctl is-active --quiet agent-host-worker.service && log "worker running; it will heartbeat with its operator-issued credential" || { journalctl -u agent-host-worker -n 30 --no-pager; exit 1; }
