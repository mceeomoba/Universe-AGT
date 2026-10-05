// Host worker main loop for Worker protocol v1. Credentials are operator-issued (AGENT_HOST_ID / AGENT_HOST_TOKEN); no anonymous enrollment.
import { deploy, rollback, safeId, httpHealth } from './deploy.js';
import { systemMetrics } from './metrics.js';

// Exactly what is advertised in the heartbeat. Tasks outside this set are never claimed by the server; refused here too.
export const CAPABILITIES = ['deploy', 'update', 'start', 'stop', 'restart', 'rollback', 'status', 'healthcheck', 'system-info'];

export function makeWorker({ api, docker, cfg, state, save, version, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), health = httpHealth, metrics = systemMetrics }) {
  let running = true;
  state.pending = state.pending || {};
  const appOf = (t) => { const a = state.apps[safeId(t.payload?.project_id || '')]; if (!a?.current) throw Object.assign(new Error('unknown app'), { code: 'EXECUTION_FAILED' }); return a; };
  const ok = (a, status, h = 'healthy') => ({ health: h, container_ids: [a.current.container], status });

  async function execute(task, leaseLost) {
    const ctx = { api, docker, cfg, state, save, health, metrics, leaseLost };
    const guard = () => { if (leaseLost()) throw Object.assign(new Error('lease lost'), { code: 'LEASE_EXPIRED' }); };
    switch (task.type) {
      case 'deploy': case 'update': return deploy(task, ctx);
      case 'rollback': return rollback(task, ctx);
      case 'restart': { const a = appOf(task); guard(); await docker.restart(a.current.container); return ok(a, 'running'); }
      case 'stop': { const a = appOf(task); guard(); await docker.stop(a.current.container); return ok(a, 'stopped'); }
      case 'start': { const a = appOf(task); guard(); await docker.start(a.current.container); return ok(a, 'running'); }
      case 'status': { const a = appOf(task); const s = await docker.state(a.current.container); return ok(a, s?.Running ? 'running' : 'stopped', s?.Running ? 'healthy' : 'unhealthy'); }
      case 'healthcheck': { const a = appOf(task); const h = await health(a.current.hostPort, a.current.manifest.healthcheck, { timeoutMs: 5000 }); return ok(a, 'running', h.ok ? 'healthy' : 'unhealthy'); }
      case 'system-info': return { health: 'healthy', container_ids: [], status: 'running' };
      default: throw Object.assign(new Error('task type not allowed: ' + task.type), { code: 'EXECUTION_FAILED' });
    }
  }

  async function applications() {
    return (await Promise.all(Object.entries(state.apps).map(async ([id, a]) => {
      if (!a.current) return null; const s = await docker.state(a.current.container);
      const status = !s ? 'unhealthy' : s.Restarting ? 'crash_loop' : s.Running ? 'running' : 'stopped';
      return { project_id: id, status };
    }))).filter(Boolean);
  }
  async function heartbeat() {
    const m = await metrics();
    await api.heartbeat({ worker_version: version, capabilities: CAPABILITIES, cpu_percent: m.cpu_load_pct ?? 0, memory_free_bytes: m.mem_free, disk_free_bytes: m.disk_free, uptime_seconds: m.uptime_s ?? 0, docker: await docker.available(), applications: await applications() });
  }

  // Report a finished task. Only a server acknowledgement marks it done; otherwise the result stays pending and is retried (never re-executed).
  async function flush(id) {
    const p = state.pending[id]; if (!p) return;
    try { await (p.kind === 'complete' ? api.complete(id, p.lease, p.result) : api.fail(id, p.lease, p.code, p.rolled_back)); }
    catch (e) { if (!(e.status === 409 || e.status === 403 || e.status === 404)) return; /* network/5xx: keep pending. Fenced 4xx: lease is gone, drop */ }
    delete state.pending[id]; state.seen_tasks = [...state.seen_tasks, id].slice(-200); await save();
  }

  async function runOne(t, lease) {
    // Never execute unless start was acknowledged.
    try { await api.start(t.id, lease); } catch (e) { console.error(JSON.stringify({ level: 'warn', msg: 'start not acknowledged, task skipped', task: t.id, error: e.message })); return; }
    // Lease lost = server fenced us (403/409/410) OR no successful renewal for longer than the safe window (prolonged outage: the 90s lease may have expired and been re-claimed).
    let fenced = false, lastOk = Date.now(); const ttl = cfg.leaseSafeMs || 75000;
    const isLost = () => fenced || Date.now() - lastOk > ttl;
    const timer = setInterval(() => { api.renew(t.id, lease).then(() => { lastOk = Date.now(); }).catch((e) => { if (e.status === 403 || e.status === 409 || e.status === 410) fenced = true; }); }, cfg.leaseRenewMs || 30000);
    let out;
    try { out = { kind: 'complete', result: await execute(t, isLost) }; }
    catch (e) { out = { kind: 'fail', code: e.code || 'EXECUTION_FAILED', rolled_back: !!e.rolledBack }; console.error(JSON.stringify({ level: 'warn', msg: 'task failed', task: t.id, code: out.code, error: String(e.message).slice(0, 300) })); }
    finally { clearInterval(timer); }
    if (isLost()) out = { kind: 'fail', code: 'LEASE_EXPIRED', rolled_back: false };
    state.pending[t.id] = { ...out, lease }; await save(); // persist the outcome BEFORE reporting
    await flush(t.id);
  }

  async function tick() {
    for (const id of Object.keys(state.pending)) await flush(id);
    await heartbeat();
    for (let i = 0; i < (cfg.maxPerTick || 3); i++) { // one task per claim request
      const r = await api.claim(); const t = r && r.task; if (!t) break;
      if (state.seen_tasks.includes(t.id) || state.pending[t.id]) break;
      await runOne(t, r.lease_token || t.lease_token);
    }
  }

  async function loop() {
    let backoff = 1000;
    while (running) {
      try { await tick(); backoff = 1000; await sleep(cfg.pollMs); }
      catch (e) { console.error(JSON.stringify({ level: 'warn', msg: 'tick failed', error: e.message })); await sleep(backoff); backoff = Math.min(backoff * 2, 60000); }
    }
  }
  return { tick, loop, execute, stop: () => { running = false; } };
}
