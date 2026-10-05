# Worker protocol v1

All requests use outbound HTTPS and `Authorization: Bearer <host credential>`.
Provisioning is separate from normal operation. An operator registers a host with
`POST /v1/hosts/register` {name,type,capabilities}, then issues its credential using
`POST /v1/credentials` {subject_id,kind:"host",scopes:["worker","read_status"],expires_in_days:30}.
The host installs these private values before starting. No anonymous enrollment.

## Heartbeat
`POST /v1/hosts/:id/heartbeat`:
```
{"worker_version":"0.1.0","capabilities":["deploy","update","start","stop","restart","rollback","status","healthcheck","system-info"],"cpu_percent":0,"memory_free_bytes":1024,"disk_free_bytes":1024,"uptime_seconds":1,"docker":true,"applications":[]}
```
Applications: {project_id: UUID,status:"running"|"stopped"|"unhealthy"|"crash_loop"}.

## Claim, execute, renew, finish
`POST /v1/hosts/:id/tasks/claim` {} returns
{task:null} or {task:{id,type,payload,lease_token,lease_expires_at,...},lease_token,lease_expires_at}.
One task per request. Payload uses project_id UUID, artifact_id UUID, version,
and deployment_id for deployment tasks and service commands. Claimed payload also
includes project (registered project name). Manifests come from the archive. Task types outside the
worker's advertised capabilities are not claimed.

`POST /v1/tasks/:id/start` {lease_token}. Do not execute if rejected.
`POST /v1/tasks/:id/renew` {lease_token} at most every 30 seconds while working.
Lease expires after 90 seconds; stale tokens are rejected. Stop side effects if
renewal fails. A replacement worker must reconcile Docker state before repeating
an uncertain operation. The database alone cannot fence a Docker daemon operation.

`POST /v1/tasks/:id/complete` {lease_token,result}.
Result is strict: optional deployment_id UUID, health "healthy"|"unhealthy",
container_ids string[], status "running"|"stopped"|"removed"|"rolled_back".
`POST /v1/tasks/:id/fail` {lease_token,code,rolled_back:false}.
Code: ARTIFACT_INVALID, MANIFEST_INVALID, BUILD_FAILED, HEALTH_FAILED, INSUFFICIENT_RESOURCES, EXECUTION_FAILED, CRASH_LOOP, LEASE_EXPIRED. No logs or freeform errors.
Only persist local completion after the server acknowledges. General status reads
omit lease tokens. Tasks retry after expired leases, maximum five attempts.

## Artifacts
`GET /v1/artifacts/:id` returns {artifact:{id,checksum,size,version,...},download_url,expires_in:120}.
Only verified artifacts assigned to a live claimed/running host task are readable
by that host. Fetch download_url directly, verify size and SHA-256 locally before
extraction. Reject symlinks, hardlinks, special files and traversal before extracting.
Do not follow archive links during builds. Artifact upload/finalize is agent-scoped.

## State and secrets
Deployment rows update atomically with the fenced complete/fail transition.
Events are append-only and emitted by the API. Worker event/report endpoints are
not implemented; do not depend on them. Secret delivery is optional and requires a private encryption key; domains remain
disabled until private scoped configuration is authorized. No credentials in artifacts or logs.
A worker with a claimed task may not claim success for another host or tenant.

## Runtime secrets
Operator-only PUT /v1/projects/:id/secrets {name,value} stores AES-256-GCM ciphertext
using a server-only 32-byte key supplied privately as SECRETS_ENCRYPTION_KEY (hex).
Secret names only appear in task secret_refs. Duplicate references are rejected.
POST /v1/tasks/:id/secrets {lease_token} returns {env} only to the assigned host of
a running, unexpired fenced task, and only for explicitly requested references.
No deployment-secret GET. Do not log, persist or include returned values in events,
results, error traces or artifact files. Missing key or secret fails closed.

## Cancellation
Queued or awaiting-approval tasks may be cancelled. Claimed/running tasks return
409; coordinated in-flight cancellation is not implemented. Clients must display
that conflict, not imply a running deployment was stopped.
