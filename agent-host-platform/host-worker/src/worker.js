// Host worker main loop: register, heartbeat, claim, execute allowlisted task types, report. Outbound only.
import { deploy, rollback, safeId } from './deploy.js';
import { systemMetrics } from './metrics.js';

export const TASK_ALLOWLIST = ['deploy', 'update', 'restart', 'stop', 'start', 'remove', 'rollback', 'logs', 'status', 'healthcheck', 'system-info'];

export function makeWorker({ api, docker, cfg, state, save, version, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), health, metrics = systemMetrics }) {
  let hostId = state.host_id || null, running = true;
  const appOf = (t) => { const a = state.apps[safeId(t.payload?.project || '')]; if (!a?.current) throw new Error('unknown app: ' + t.payload?.project); return a; };

  async function execute(task) {
    const emit = (type, data) => api.event(task.id, type, data, task.lease_token).catch(() => {});
    const ctx = { api, docker, cfg, state, save, emit, health, metrics };
    switch (task.type) {
      case 'deploy': case 'update': return deploy(task, ctx);
      case 'rollback': return rollback(task, ctx);
      case 'restart': { const a = appOf(task); await docker.restart(a.current.container); await emit('service.restarted', { project: task.payload.project }); return { status: 'running' }; }
      case 'stop': { const a = appOf(task); await docker.stop(a.current.container); await emit('service.stopped', { project: task.payload.project }); return { status: 'stopped' }; }
      case 'start': { const a = appOf(task); await docker.start(a.current.container); await emit('service.started', { project: task.payload.project }); return { status: 'running' }; }
      case 'remove': { const p = safeId(task.payload.project); const a = appOf(task); await docker.rm(a.current.container); for (const o of a.previous || []) await docker.rm(o.container).catch(() => {}); delete state.apps[p]; await save(); return { status: 'removed' }; }
      case 'logs': { const a = appOf(task); return { logs: await docker.logs(a.current.container, Math.min(Number(task.payload.tail) || 200, 2000)) }; }
      case 'status': { const a = appOf(task); const s = await docker.state(a.current.container); return { version: a.current.version, running: !!s?.Running, status: s?.Status || 'missing' }; }
      case 'healthcheck': { const a = appOf(task); const h = await (health || (await import('./deploy.js')).httpHealth)(a.current.hostPort, a.current.manifest.healthcheck, { timeoutMs: 5000 }); await emit(h.ok ? 'healthcheck.passed' : 'healthcheck.failed', {}); return { healthy: h.ok, reason: h.reason }; }
      case 'system-info': return { metrics: await metrics(), apps: Object.keys(state.apps) };
      default: throw new Error('task type not allowed: ' + task.type);
    }
  }

  async function tick() {
    if (!hostId) {
      const r = await api.register({ name: cfg.hostName, host_type: cfg.hostType, worker_version: version, capabilities: TASK_ALLOWLIST, enrollment_token: cfg.enrollmentToken });
      hostId = r.host_id; state.host_id = hostId; cfg.setToken(r.host_token); state.host_token = r.host_token; await save();
    }
    const apps = await docker.list().catch(() => []);
    await api.heartbeat(hostId, { status: 'online', worker_version: version, metrics: await metrics(), docker: await docker.available(), running_apps: apps.length });
    const { tasks = [] } = await api.claim(hostId, 2);
    for (const t of tasks) {
      if (state.seen_tasks.includes(t.id)) continue; // idempotent after worker restart
      await api.start(t.id, t.lease_token).catch(() => {});
      try { const result = await execute(t); await api.complete(t.id, result, t.lease_token); }
      catch (e) { await api.fail(t.id, { message: e.message, logs: e.logs }, t.lease_token).catch(() => {}); }
      state.seen_tasks = [...state.seen_tasks, t.id].slice(-200); await save();
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
