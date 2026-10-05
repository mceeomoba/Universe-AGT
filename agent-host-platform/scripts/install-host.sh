#!/usr/bin/env bash
# Agent Host Worker installer. Outbound HTTPS only; nothing listens publicly.
#   sudo bash install-host.sh diagnose [--control-plane URL]
#   sudo bash install-host.sh install --control-plane URL --host-id ID --ref COMMIT_SHA [--name NAME] [--token-file PATH] [--worker-src-dir DIR]
#   sudo bash install-host.sh status
# The host credential never appears in arguments, environment, logs or output. It lives in a 0600 file; only its SHA-256 digest is printed.
set -euo pipefail
set +x
ROOT=/opt/agent-host; APPS=/srv/agent-apps; SVC_USER=agent-host; REPO=mceeomoba/Universe-AGT
log() { printf '[agent-host] %s\n' "$*"; }
die() { printf '[agent-host] ERROR: %s\n' "$*" >&2; exit 1; }
redact() { sed -E 's/[0-9a-fA-F]{40,}/<redacted>/g; s/(Bearer )[^ "]+/\1<redacted>/g'; }
need_root() { [ "$(id -u)" -eq 0 ] || die "run with sudo, for example: sudo bash $0 ${CMD:-install} ..."; }
nodearch() { case "$(uname -m)" in x86_64) echo x64;; aarch64|arm64) echo arm64;; *) die "unsupported CPU $(uname -m)";; esac; }

CMD="${1:-}"; [ -n "$CMD" ] && shift || true
CP=""; HOST_ID=""; REF=""; NAME="$(hostname)"; TOKEN_SRC=""; SRC_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --control-plane) CP="${2:-}"; shift 2;; --host-id) HOST_ID="${2:-}"; shift 2;; --ref) REF="${2:-}"; shift 2;;
    --name) NAME="${2:-}"; shift 2;; --token-file) TOKEN_SRC="${2:-}"; shift 2;; --worker-src-dir) SRC_DIR="${2:-}"; shift 2;;
    *) die "unknown option $1";;
  esac
done

diagnose() {
  local bad=0; log "Diagnostic (no changes are made, nothing secret is read)"
  . /etc/os-release 2>/dev/null || true
  log "OS: ${PRETTY_NAME:-unknown}   CPU: $(uname -m)   kernel: $(uname -r)"
  case "${ID:-}${ID_LIKE:-}" in *debian*|*ubuntu*) log "distro: supported (Debian/Ubuntu family)";; *) log "distro: NOT supported yet"; bad=1;; esac
  case "$(uname -m)" in x86_64|aarch64|arm64) log "CPU: supported";; *) log "CPU: NOT supported"; bad=1;; esac
  if [ "$(id -u)" -eq 0 ]; then log "privileges: root"; elif sudo -n true 2>/dev/null; then log "privileges: sudo works"; else log "privileges: need root (run with sudo)"; bad=1; fi
  if [ -d /run/systemd/system ]; then log "systemd: yes"; else log "systemd: NOT running (required)"; bad=1; fi
  if command -v docker >/dev/null 2>&1; then if docker info >/dev/null 2>&1; then log "docker: installed and running"; else log "docker: installed but not reachable (installer will try to start it)"; fi; else log "docker: not installed (installer will install docker.io)"; fi
  command -v node >/dev/null 2>&1 && log "system node: $(node -v) (ignored; the installer uses its own private Node 22)" || log "system node: none (fine)"
  log "free disk /opt: $(df -h /opt 2>/dev/null | awk 'NR==2{print $4}')   RAM: $(awk '/MemTotal/{printf "%.1f GB", $2/1048576}' /proc/meminfo)"
  command -v curl >/dev/null 2>&1 && { for u in https://nodejs.org ${CP:+"$CP"}; do c=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$u" 2>/dev/null || echo fail); log "outbound $u: HTTP $c"; [ "$c" = fail ] && bad=1; done; } || log "curl: missing (installer will install it)"
  [ "$bad" -eq 0 ] && log "RESULT: READY to install" || { log "RESULT: NOT READY, fix the items marked above"; return 1; }
}

install_cmd() {
  need_root; [ "$(uname -s)" = Linux ] || die "Linux only"
  [ -n "$CP" ] || die "--control-plane is required"; [ -n "$HOST_ID" ] || die "--host-id is required (the id the operator registered)"
  case "$CP" in https://*|http://127.0.0.1*|http://localhost*) ;; *) die "control plane must be https:// (http only for loopback tests)";; esac
  [[ "$HOST_ID" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die "--host-id has unexpected characters"
  [ -n "$REF" ] || [ -n "$SRC_DIR" ] || die "--ref (commit SHA of the worker source) is required"
  [ -z "$REF" ] || [[ "$REF" =~ ^[0-9a-f]{7,40}$ ]] || die "--ref must be a commit SHA"
  local NA; NA="$(nodearch)"; . /etc/os-release 2>/dev/null || true
  case "${ID:-}${ID_LIKE:-}" in *debian*|*ubuntu*) ;; *) die "only Debian/Ubuntu are supported right now";; esac
  export DEBIAN_FRONTEND=noninteractive
  log "installing base packages"; apt-get update -y >/dev/null; apt-get install -y ca-certificates curl tar xz-utils >/dev/null
  command -v docker >/dev/null 2>&1 || { log "installing Docker"; apt-get install -y docker.io >/dev/null; }
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker info >/dev/null 2>&1 || die "Docker is installed but not running"
  id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$ROOT" --shell /usr/sbin/nologin "$SVC_USER"
  usermod -aG docker "$SVC_USER"
  mkdir -p "$ROOT"/{worker,config,logs,cache,runtime,node} "$APPS"

  # Private Node >= 20 (never the distro package). Checksum verified against nodejs.org's published SHASUMS256.txt.
  if [ -x "$ROOT/node/bin/node" ] && "$ROOT/node/bin/node" -e 'process.exit(+process.versions.node.split(".")[0]>=20?0:1)'; then log "private Node present: $("$ROOT/node/bin/node" -v)"
  else
    local base=https://nodejs.org/dist/latest-v22.x tmp; tmp="$(mktemp -d)"
    curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SUMS" || die "cannot reach nodejs.org"
    local line; line="$(grep "linux-$NA.tar.xz\$" "$tmp/SUMS" | head -1)"; [ -n "$line" ] || die "no Node build for $NA"
    local sum file; sum="${line%% *}"; file="${line##* }"
    log "downloading Node ($file)"; curl -fsSL "$base/$file" -o "$tmp/$file"
    ( cd "$tmp" && echo "$sum  $file" | sha256sum -c - >/dev/null ) || die "Node checksum mismatch, aborting"
    rm -rf "$ROOT/node"; mkdir -p "$ROOT/node"; tar -xJf "$tmp/$file" -C "$ROOT/node" --strip-components=1; rm -rf "$tmp"
    log "installed private Node $("$ROOT/node/bin/node" -v)"
  fi

  # Worker source: a commit-pinned tarball (content-addressed) or a local directory.
  local stage; stage="$(mktemp -d)"
  if [ -n "$SRC_DIR" ]; then [ -d "$SRC_DIR/src" ] || die "--worker-src-dir has no src/"; cp -a "$SRC_DIR"/. "$stage/"
  else
    curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" -o "$stage/src.tgz" || die "cannot download worker source for $REF"
    mkdir "$stage/x"; tar -xzf "$stage/src.tgz" -C "$stage/x"; cp -a "$stage"/x/*/agent-host-platform/host-worker/. "$stage/" ; rm -rf "$stage/x" "$stage/src.tgz"
  fi
  rm -rf "$ROOT/worker"; mkdir -p "$ROOT/worker"; cp -a "$stage"/. "$ROOT/worker/"; rm -rf "$stage"

  # Host credential: generated here, 0600, never printed. Only its SHA-256 digest is shown.
  local TF="$ROOT/config/host.token"
  if [ -n "$TOKEN_SRC" ]; then [ -s "$TOKEN_SRC" ] || die "--token-file is empty or unreadable"; ( umask 077; tr -d '[:space:]' < "$TOKEN_SRC" > "$TF" )
  elif [ ! -s "$TF" ]; then ( umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TF" ); log "generated a new host credential (stored root-readable only)"
  else log "keeping existing host credential"; fi
  chown "$SVC_USER:$SVC_USER" "$TF"; chmod 600 "$TF"
  local DIGEST; DIGEST="$(sha256sum "$TF" | cut -d' ' -f1)"
  cat > "$ROOT/config/worker.env" <<ENV
AGENT_HOST_CONTROL_PLANE=$CP
AGENT_HOST_ID=$HOST_ID
AGENT_HOST_NAME=$NAME
AGENT_HOST_ROOT=$ROOT
AGENT_APPS_DIR=$APPS
AGENT_HOST_TOKEN_FILE=$TF
ENV
  chmod 644 "$ROOT/config/worker.env"; chown -R "$SVC_USER:$SVC_USER" "$ROOT" "$APPS"; chmod 600 "$TF"
  install -m 644 "$ROOT/worker/systemd/agent-host-worker.service" /etc/systemd/system/agent-host-worker.service; systemctl daemon-reload
  echo; log "HOST ID:        $HOST_ID"; log "token sha256:   $DIGEST"
  log "Give the operator the two lines above so the control plane can accept this host. The credential itself never leaves this machine."

  # Real proof before enabling: one authenticated heartbeat as the service user.
  log "checking an authenticated heartbeat against the control plane"
  if ! out="$(runuser -u "$SVC_USER" -- bash -c "set -a; . $ROOT/config/worker.env; set +a; exec $ROOT/node/bin/node $ROOT/worker/src/index.js --check" 2>&1)"; then
    printf '%s\n' "$out" | redact >&2
    die "the control plane did not accept the heartbeat. Once the operator has registered the digest above, run this same install command again."
  fi
  printf '%s\n' "$out" | redact
  systemctl enable --now agent-host-worker.service; sleep 3
  systemctl is-active --quiet agent-host-worker.service || { journalctl -u agent-host-worker -n 30 --no-pager | redact; die "service failed to start"; }
  log "DONE: worker running and authenticated. It restarts on crash and after reboot."
}

status_cmd() {
  need_root; systemctl is-active agent-host-worker.service || true; journalctl -u agent-host-worker -n 15 --no-pager 2>/dev/null | redact || true
  runuser -u "$SVC_USER" -- bash -c "set -a; . $ROOT/config/worker.env; set +a; exec $ROOT/node/bin/node $ROOT/worker/src/index.js --check" 2>&1 | redact || true
}

case "$CMD" in diagnose) diagnose;; install) install_cmd;; status) status_cmd;; *) echo "usage: sudo bash $0 diagnose|install|status (see header for options)"; exit 2;; esac
