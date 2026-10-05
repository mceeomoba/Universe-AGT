// Deployment engine (spec sections 7, 9, 14, 19). Never leaves a broken partial deploy: on any failure the previous version keeps running.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { validateManifest } from './manifest.js';
import { checkCapacity } from './metrics.js';

const sh = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (e, o, er) => e ? rej(new Error((er || e.message).toString().slice(-2000))) : res(o.toString())));
export const safeId = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);

export async function sha256File(file) {
  const h = createHash('sha256'); const { createReadStream } = await import('node:fs');
  for await (const c of createReadStream(file)) h.update(c); return h.digest('hex');
}
export function pickPort(state, lo = 20000, hi = 29999) {
  const used = new Set(Object.values(state.apps).flatMap((a) => [a.current?.hostPort, ...(a.previous || []).map((p) => p.hostPort)]).filter(Boolean));
  for (let p = lo; p <= hi; p++) if (!used.has(p)) return p;
  throw new Error('no free host port');
}
export async function httpHealth(port, hcPath, { timeoutMs = 60000, intervalMs = 2000, fetchImpl = fetch } = {}) {
  const end = Date.now() + timeoutMs; let last = 'no response';
  while (Date.now() < end) {
    try { const r = await fetchImpl(`http://127.0.0.1:${port}${hcPath}`, { signal: AbortSignal.timeout(5000) }); if (r.ok) return { ok: true }; last = 'HTTP ' + r.status; } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, reason: last };
}

export async function deploy(task, ctx) {
  const { api, docker, cfg, state, save, emit, health = httpHealth, metrics } = ctx;
  const p = task.payload || {};
  const project = safeId(p.project || ''), version = String(p.version || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!project || !version || !p.artifact_id) throw new Error('deploy payload needs project, version, artifact_id');
  const deployId = safeId(p.deployment_id || task.id);
  const dir = path.join(cfg.appsDir, project, version);
  const tarball = path.join(cfg.cacheDir, `${project}-${version}-${deployId}.tgz`);
  const image = `agent-app/${project}:${version}`;
  const name = `app-${project}-${deployId.slice(0, 12)}`;
  let started = false;
  try {
    await emit('deployment.started', { project, version });
    const meta = await api.artifactMeta(p.artifact_id);
    await mkdir(cfg.cacheDir, { recursive: true });
    const res = await api.artifactDownload(p.artifact_id);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tarball));
    const sum = await sha256File(tarball);
    if (!meta.checksum || sum !== String(meta.checksum).toLowerCase()) throw new Error('checksum mismatch: artifact rejected');
    const names = (await sh('tar', ['-tzf', tarball])).split('\n').filter(Boolean);
    if (names.some((n) => n.startsWith('/') || n.split('/').includes('..'))) throw new Error('artifact contains unsafe paths');
    await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
    await sh('tar', ['-xzf', tarball, '-C', dir, '--no-same-owner']);
    const manifest = validateManifest(await readFile(path.join(dir, 'agent.deploy.json'), 'utf8'));
    if (manifest.name !== project) throw new Error('manifest name does not match project');
    const cap = checkCapacity(await metrics(), { memory: manifest.memory, disk: manifest.disk });
    if (cap) throw new Error(cap);
    const secrets = p.has_secrets ? (await api.secrets(deployId)).env || {} : {};
    await docker.build(image, dir, path.join(dir, manifest.dockerfile));
    const hostPort = pickPort(state);
    await docker.run({ name, image, project, deployment: deployId, version, hostPort, port: manifest.port, memory: manifest.memory, cpu: manifest.cpu, restart: manifest.restart, env: secrets });
    started = true;
    const h = await health(hostPort, manifest.healthcheck);
    if (!h.ok) { await emit('healthcheck.failed', { reason: h.reason }); throw new Error('health check failed: ' + h.reason); }
    await emit('healthcheck.passed', { project, version });
    const app = state.apps[project] || { previous: [] };
    const old = app.current;
    app.current = { version, container: name, image, hostPort, deployment: deployId, manifest, at: new Date().toISOString() };
    app.previous = [...(old ? [old] : []), ...(app.previous || [])].slice(0, 3);
    state.apps[project] = app; await save();
    if (old) { await docker.stop(old.container).catch(() => {}); } // old kept stopped (not removed) so rollback is instant
    await emit('deployment.completed', { project, version, container: name });
    return { project, version, status: 'running', health: 'healthy', container: name, host_port: hostPort, domains: manifest.domains };
  } catch (e) {
    let logs = ''; if (started) { logs = await docker.logs(name, 100).catch(() => ''); await docker.rm(name).catch(() => {}); }
    await docker.rmi(image).catch(() => {});
    await emit('deployment.failed', { project, version, error: e.message, rolled_back: !!state.apps[project]?.current, previous_still_running: !!state.apps[project]?.current });
    e.logs = logs.slice(-2000); throw e;
  } finally { await rm(tarball, { force: true }); }
}

export async function rollback(task, ctx) {
  const { docker, state, save, emit, health = httpHealth } = ctx; const project = safeId(task.payload?.project || '');
  const app = state.apps[project]; if (!app || !app.previous?.length) throw new Error('no previous version to roll back to');
  const prev = app.previous[0], cur = app.current;
  const name = `app-${project}-rb${Date.now().toString(36)}`;
  await docker.run({ name, image: prev.image, project, deployment: prev.deployment, version: prev.version, hostPort: prev.hostPort, port: prev.manifest.port, memory: prev.manifest.memory, cpu: prev.manifest.cpu, restart: prev.manifest.restart, env: {} });
  const h = await health(prev.hostPort, prev.manifest.healthcheck);
  if (!h.ok) { await docker.rm(name).catch(() => {}); throw new Error('rollback target unhealthy: ' + h.reason); }
  if (cur) await docker.rm(cur.container).catch(() => {});
  await docker.rm(prev.container).catch(() => {});
  app.current = { ...prev, container: name }; app.previous = app.previous.slice(1); await save();
  await emit('deployment.completed', { project, version: prev.version, rollback: true });
  return { project, version: prev.version, status: 'running', rolled_back_from: cur?.version };
}
