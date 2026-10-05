# Host worker (Apex half)

Outbound-only worker for a persistent host. No inbound ports, no Tailscale, no dependency on any agent VM.

## Contract used (Vertex control plane, outbound HTTPS REST)
- `POST /v1/hosts/register` (enrollment token) returns `host_id`, `host_token`.
- `POST /v1/hosts/:id/heartbeat` status, CPU/RAM/disk, Docker state, worker version, running app count.
- `POST /v1/hosts/:id/tasks/claim` returns tasks with a fenced `lease_token` and `lease_expires_at`.
- `POST /v1/tasks/:id/start|complete|fail` every mutation carries `lease_token`.
- `GET /v1/artifacts/:id` (sha256, size) and `GET /v1/artifacts/:id/download` (signed URL). The worker verifies SHA-256 before use.
- `GET /v1/deployments/:id/secrets` returns runtime env only when the task payload sets `has_secrets`. Secrets are never logged.
- Event posts (`POST /v1/tasks/:id/events`) and `POST /v1/deployments/report` are best-effort and still to be agreed with the control plane.

## Task types (allowlist)
deploy, update, restart, stop, start, remove, rollback, logs, status, healthcheck, system-info. Anything else is refused. Docker is called with an argv allowlist, never through a shell.

## Deploy flow
claim, download, verify checksum, safe-extract, validate `agent.deploy.json`, capacity check, build, run on a unique container name bound to 127.0.0.1, health check, switch. On any failure the new container is removed and the previous version keeps running. The previous version is kept stopped so rollback is instant.

## Tests
`cd host-worker && npm test` runs against a fake control plane and fake Docker. Real Docker, reboot survival and the Grok VM are not proven by these tests.
