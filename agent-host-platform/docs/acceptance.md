# Acceptance evidence

Local evidence: foundation SQL and credential-binding migrations applied to
PostgreSQL 14; TypeScript compiles; four validation/security tests and one real
PostgreSQL integration test pass. Integration verifies authentication, tenant RLS,
manual approval, idempotency/conflict, eight simultaneous claims yielding one,
lease recovery, stale-token rejection, and append-only journal.

These do not prove remote host installation, deployment or persistence.

| Test | Requirement | State |
|---|---|---|
| 1 | Register Grok VM host | BLOCKED: host installation approval/credentials |
| 2 | Worker survives VM reboot | NOT PROVEN |
| 3 | Muse registers as agent | NOT PROVEN: simulated API only |
| 4 | Muse creates deployment task | NOT PROVEN |
| 5 | Worker receives outbound task | NOT PROVEN: contracts need integration |
| 6 | Sample automatic deployment | NOT PROVEN |
| 7 | App remains after disconnect | NOT PROVEN |
| 8 | Agent reconnect reads state | NOT PROVEN: local durable read only |
| 9 | Second app isolation | NOT PROVEN |
| 10 | Manual approval | PASS locally; remote end-to-end NOT PROVEN |
| 11 | Failed deployment rolls back | NOT PROVEN |
| 12 | Worker restart preserves apps | NOT PROVEN |
| 13 | VM reboot restores services | NOT PROVEN |
| 14 | Cloudflare domain routing | BLOCKED: optional, off without scoped credentials |
| 15 | No Grok subscription/API, agent IP, Tailscale, routine SSH | NOT PROVEN end-to-end; architecture uses outbound HTTPS |

Publishing source and passing CI do not complete these acceptance tests.
