# Agent Host Platform

Agent-neutral control plane and persistent Linux host worker. Agents and hosts
use outbound HTTPS; the database holds durable tasks, fenced leases, deployments
and an append-only event journal. No Tailscale or temporary agent VM IP needed.

Vertex owns control-plane, database, SDK and CLI. Apex owns host-worker, installer,
Docker execution and dashboard. This shared source does not combine company data,
workers, ledgers, credentials or databases.

## Local control-plane test
```
npm ci
npm run build
DATABASE_URL=postgresql://localhost/universe npm run migrate
TEST_DATABASE_URL=postgresql://localhost/universe NODE_ENV=test npm test
```
Migrate only into a dedicated empty local database. Bootstrap writes a private
operator token file; keep it outside this repository. Supply DATABASE_URL privately.
LOCAL_HTTP=1 permits localhost test transport only, not production use. Production
TLS termination needs a loopback-only reverse proxy. TRUST_LOOPBACK_PROXY=1 trusts
forwarded protocol only from 127.0.0.1; keep port 8080 bound to localhost. Production
certificate and firewall configuration is not yet live-proven.

Optional storage migration 003 runs separately on an approved Supabase project.
SUPABASE_URL and SUPABASE_STORAGE_KEY are server-only configuration. Uploads are
private, limited to 100 MiB, finalized by server-side byte count and SHA-256.

See docs/control-plane-contract.md and docs/acceptance.md. This is unfinished:
no host installation, live Supabase mutation, live secret delivery, Cloudflare
routing, dashboard, or full shared-worker end-to-end proof has occurred.
