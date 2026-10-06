#!/usr/bin/env bash
# Generates install-host-standalone.sh: install-host.sh with the host-worker
# source embedded as a sha256-verified base64 tarball, so a host can install
# without any GitHub access. The tarball is built deterministically, so
# re-running this on unchanged source reproduces the same file byte for byte.
#   usage: embed-worker-source.sh [OUTPUT]   (run from agent-host-platform/)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-scripts/install-host-standalone.sh}"
command -v gtar >/dev/null 2>&1 && TAR=gtar || TAR=tar
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
"$TAR" --sort=name --mtime='UTC 2026-01-01' --owner=0 --group=0 --numeric-owner \
  -czf "$tmp/payload.tgz" host-worker
B64="$(base64 -w0 "$tmp/payload.tgz" 2>/dev/null || base64 "$tmp/payload.tgz" | tr -d '\n')"
SHA="$(sha256sum "$tmp/payload.tgz" | cut -d' ' -f1)"
awk -v b64="$B64" -v sha="$SHA" '
  /^EMBEDDED_WORKER_B64=""/      { print "EMBEDDED_WORKER_B64=\x27" b64 "\x27"; next }
  /^EMBEDDED_SHA256=""/          { print "EMBEDDED_SHA256=\x27" sha "\x27"; next }
  { print }
' scripts/install-host.sh > "$OUT"
chmod +x "$OUT"
printf 'generated %s (payload sha256 %s, %s bytes)\n' "$OUT" "$SHA" "$(wc -c < "$OUT")"
