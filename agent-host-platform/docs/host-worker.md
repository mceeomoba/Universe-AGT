# Host worker (Apex half)

Outbound-only worker for a persistent host. No inbound ports, no Tailscale, no dependency on any agent VM. Implements Worker protocol v1 (`control-plane-contract.md`).

## Provisioning
No anonymous enrollment. The operator registers the host and issues a host credential, then installs `AGENT_HOST_CONTROL_PLANE`, `AGENT_HOST_ID`, `AGENT_HOST_TOKEN` (read from the environment by `scripts/install-host.sh`, written to a 0600 env file, never logged).


## Installing without GitHub access (restricted egress)
`scripts/embed-worker-source.sh` generates `scripts/install-host-standalone.sh`: the same installer with the worker source embedded as a sha256-verified tarball, regenerated deterministically and checked in CI. Install with `sudo bash install-host-standalone.sh install --control-plane URL --host-id ID` (no `--ref`, no GitHub fetch). Everything else is identical, including credential handling and the authenticated pre-flight heartbeat.

Hosts the install and worker actually need (diagnose probes each and labels it):
- Required: the control-plane URL, and nodejs.org (private Node 22 download).
- apt mirrors (archive.ubuntu.com / deb.debian.org) and registry-1.docker.io for packages and app images; any HTTP code, even 401/403, means reachable.
- codeload.github.com / raw.githubusercontent.com: only for the non-standalone installer.
- Worker runtime after install: the control-plane URL only (plus the Docker registry when deploying apps).

## Loop
heartbeat (flat body: version, capabilities, cpu/mem/disk, uptime, docker, applications) then claim (one task per request) then `start` (task is skipped if start is rejected) then execute while renewing the lease every 30s then `complete {lease_token,result}` or `fail {lease_token,code,rolled_back}` (codes only, no logs or free text).

## Safety rules
- Never execute after a failed `start`. If renewal fails, side effects stop (`LEASE_EXPIRED`).
- The outcome is saved locally before it is reported and is only marked done after the server acknowledges. An unacknowledged result is retried, never re-executed.
- Before repeating a deployment, the worker checks Docker for the same deployment already running and reports it instead of rebuilding.
- Only advertised task types run: deploy, update, start, stop, restart, rollback, status, healthcheck, system-info. Docker is called with an argv allowlist, never through a shell.
- Artifacts: download_url fetched directly, size and SHA-256 verified, archives with links, special files or traversal are rejected before extraction.
- Secrets: only when the task lists `secret_refs`; fetched with the fenced `POST /v1/tasks/:id/secrets`, passed to `docker run` through a 0600 env-file deleted immediately (never argv), never logged, persisted or returned. Missing/denied secrets fail closed. Rollback restarts the retained previous container so secrets are not re-fetched or stored. Domains are not implemented.
- Lease loss: a fenced 403/409/410 on renew, or no successful renewal for 75s (prolonged outage), stops further side effects (checked before build, run, switch, rollback and control commands) and reports `LEASE_EXPIRED`.

## Deploy flow
claim, fetch artifact, verify, safe-extract, validate `agent.deploy.json`, capacity check, build, run on a unique container bound to 127.0.0.1, health check, switch. Any failure removes the new container and the previous version keeps running (`rolled_back:true`). The previous version is kept stopped so rollback is instant.

## Tests
`cd host-worker && npm test` (fake control plane, fake Docker) plus a real-Docker smoke test in CI. Not proven: reboot survival and the Grok VM.
