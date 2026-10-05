// Real Docker smoke test on a CI runner: deploy a tiny node app through the real docker wrapper and deploy engine, then a failing version.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process'; import { createHash } from 'node:crypto'; import assert from 'node:assert/strict';
import { makeDocker } from '../src/docker.js'; import { deploy } from '../src/deploy.js'; import { systemMetrics } from '../src/metrics.js';
function artifact(name, healthy) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'sm-'));
  writeFileSync(path.join(d, 'agent.deploy.json'), JSON.stringify({ name, runtime: 'docker', build: { dockerfile: 'Dockerfile' }, service: { port: 8080, healthcheck: '/health' }, resources: { memory: '128m', cpu: '0.5' }, restart: 'unless-stopped' }));
  writeFileSync(path.join(d, 'server.js'), `require('http').createServer((q,r)=>{r.statusCode=${healthy ? 200 : 500};r.end('ok')}).listen(8080)`);
  writeFileSync(path.join(d, 'Dockerfile'), 'FROM node:22-alpine\nCOPY server.js /server.js\nCMD ["node","/server.js"]\n');
  const tgz = path.join(os.tmpdir(), name + Math.random().toString(36).slice(2) + '.tgz'); execFileSync('tar', ['-czf', tgz, '-C', d, '.']);
  const buf = readFileSync(tgz); return { buf, checksum: createHash('sha256').update(buf).digest('hex') };
}
const arts = { good: artifact('smoke', true), bad: artifact('smoke', false) };
const api = { artifact: async (id) => ({ artifact: { checksum: arts[id].checksum, size: arts[id].buf.length }, download_url: 'x:' + id }), download: async (u) => new Response(arts[u.slice(2)].buf) };
const PID = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const root = mkdtempSync(path.join(os.tmpdir(), 'root-')); const cfg = { appsDir: root + '/apps', cacheDir: root + '/cache' };
const docker = makeDocker(); const state = { apps: {}, seen_tasks: [] }; const events = [];
const ctx = { api, docker, cfg, state, save: async () => {}, emit: async (t) => events.push(t), metrics: systemMetrics };
try {
  const r1 = await deploy({ id: 'd1', payload: { project_id: PID, version: '1', artifact_id: 'good', deployment_id: 'd1' } }, ctx);
  assert.equal(r1.health, 'healthy'); const c1 = state.apps[PID].current.container;
  const { httpHealth } = await import('../src/deploy.js');
  await assert.rejects(deploy({ id: 'd2', payload: { project_id: PID, version: '2', artifact_id: 'bad', deployment_id: 'd2' } }, { ...ctx, health: (p, h) => httpHealth(p, h, { timeoutMs: 8000, intervalMs: 1000 }) }), /health check failed/);
  const st = await docker.state(c1); assert.equal(st.Running, true, 'v1 must keep running after failed v2');
  console.log('DOCKER SMOKE PASS', events.join(','));
} finally { for (const c of await docker.list()) await docker.rm(c.Names).catch(() => {}); }
