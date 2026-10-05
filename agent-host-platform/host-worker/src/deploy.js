// Deployment engine (spec sections 7, 9, 14, 19). Never leaves a broken partial deploy: on any failure the previous version keeps running.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
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

const fail = (code, msg, extra = {}) => Object.assign(new Error(msg), { code, ...extra });
const UUIDISH = /^[0-9a-fA-F-]{8,64}$/;
// Reject symlinks, hardlinks, special files and traversal BEFORE extracting (contract: artifacts).
export async function inspectArchive(tarball) {
  const verbose = (await sh('tar', ['-tvzf', tarball])).split('\n').filter(Boolean);
  for (const l of verbose) { const t = l[0]; if (t !== '-' && t !== 'd') throw fail('ARTIFACT_INVALID', 'artifact contains links or special files'); }
  const names = (await sh('tar', ['-tzf', tarball])).split('\n').filter(Boolean);
  if (names.some((n) => n.startsWith('/') || n.split('/').includes('..'))) throw fail('ARTIFACT_INVALID', 'artifact contains unsafe paths');
}

export async function deploy(task, ctx) {
  const { api, docker, cfg, state, save, health = httpHealth, metrics, leaseLost = () => false } = ctx;
  const p = task.payload || {};
  const projectId = safeId(p.project_id || ''), version = String(p.version || '').replace(/[^A-Za-z0-9._-]/g, '');
  const deployId = safeId(p.deployment_id || task.id);
  if (!UUIDISH.test(String(p.project_id || '')) || !version || !p.artifact_id) throw fail('EXECUTION_FAILED', 'deploy payload needs project_id, version, artifact_id');
  // Reconcile before repeating an uncertain operation: this deployment already live => report it, do not rebuild.
  const cur = state.apps[projectId]?.current;
  if (cur && cur.deployment === deployId && (await docker.state(cur.container))?.Running) return { deployment_id: p.deployment_id, health: 'healthy', container_ids: [cur.container], status: 'running' };
  const dir = path.join(cfg.appsDir, projectId, version);
  const tarball = path.join(cfg.cacheDir, `${projectId}-${version}-${deployId}.tgz`);
  const image = `agent-app/${projectId}:${version}`;
  const name = `app-${projectId}-${deployId}`;
  let started = false;
  try {
    const meta = await api.artifact(p.artifact_id);
    await mkdir(cfg.cacheDir, { recursive: true });
    try { const res = await api.download(meta.download_url); await pipeline(Readable.fromWeb(res.body), createWriteStream(tarball)); }
    catch (e) { throw fail('ARTIFACT_INVALID', 'artifact download failed: ' + e.message); }
    const { size } = await stat(tarball);
    if (meta.artifact.size != null && Number(meta.artifact.size) !== size) throw fail('ARTIFACT_INVALID', 'artifact size mismatch');
    const sum = await sha256File(tarball);
    if (!meta.artifact.checksum || sum !== String(meta.artifact.checksum).toLowerCase()) throw fail('ARTIFACT_INVALID', 'checksum mismatch: artifact rejected');
    await inspectArchive(tarball);
    await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
    await sh('tar', ['-xzf', tarball, '-C', dir, '--no-same-owner', '--no-same-permissions']);
    let manifest; try { manifest = validateManifest(await readFile(path.join(dir, 'agent.deploy.json'), 'utf8')); } catch (e) { throw fail('MANIFEST_INVALID', e.message); }
    const cap = checkCapacity(await metrics(), { memory: manifest.memory, disk: manifest.disk });
    if (cap) throw fail('INSUFFICIENT_RESOURCES', cap);
    if (leaseLost()) throw fail('LEASE_EXPIRED', 'lease lost before build');
    try { await docker.build(image, dir, path.join(dir, manifest.dockerfile)); } catch (e) { throw fail('BUILD_FAILED', e.message); }
    if (leaseLost()) throw fail('LEASE_EXPIRED', 'lease lost before run');
    const hostPort = pickPort(state);
    await docker.run({ name, image, project: projectId, deployment: deployId, version, hostPort, port: manifest.port, memory: manifest.memory, cpu: manifest.cpu, restart: manifest.restart, env: {} });
    started = true;
    const h = await health(hostPort, manifest.healthcheck);
    if (!h.ok) throw fail('HEALTH_FAILED', 'health check failed: ' + h.reason);
    if (leaseLost()) throw fail('LEASE_EXPIRED', 'lease lost before switch');
    const app = state.apps[projectId] || { previous: [] };
    const old = app.current;
    app.current = { version, container: name, image, hostPort, deployment: deployId, manifest, at: new Date().toISOString() };
    app.previous = [...(old ? [old] : []), ...(app.previous || [])].slice(0, 3);
    state.apps[projectId] = app; await save();
    if (old) await docker.stop(old.container).catch(() => {}); // old kept stopped so rollback is instant
    return { deployment_id: p.deployment_id, health: 'healthy', container_ids: [name], status: 'running' };
  } catch (e) {
    if (started) await docker.rm(name).catch(() => {});
    await docker.rmi(image).catch(() => {});
    e.code = e.code || 'EXECUTION_FAILED'; e.rolledBack = !!state.apps[projectId]?.current; throw e;
  } finally { await rm(tarball, { force: true }); }
}

export async function rollback(task, ctx) {
  const { docker, state, save, health = httpHealth } = ctx; const projectId = safeId(task.payload?.project_id || '');
  const app = state.apps[projectId]; if (!app || !app.previous?.length) throw fail('EXECUTION_FAILED', 'no previous version to roll back to');
  const prev = app.previous[0], cur = app.current;
  const name = `app-${projectId}-rb${Date.now().toString(36)}`;
  await docker.run({ name, image: prev.image, project: projectId, deployment: prev.deployment, version: prev.version, hostPort: prev.hostPort, port: prev.manifest.port, memory: prev.manifest.memory, cpu: prev.manifest.cpu, restart: prev.manifest.restart, env: {} });
  const h = await health(prev.hostPort, prev.manifest.healthcheck);
  if (!h.ok) { await docker.rm(name).catch(() => {}); throw fail('HEALTH_FAILED', 'rollback target unhealthy: ' + h.reason); }
  if (cur) await docker.rm(cur.container).catch(() => {});
  await docker.rm(prev.container).catch(() => {});
  app.current = { ...prev, container: name }; app.previous = app.previous.slice(1); await save();
  return { deployment_id: task.payload?.deployment_id, health: 'healthy', container_ids: [name], status: 'rolled_back' };
}
