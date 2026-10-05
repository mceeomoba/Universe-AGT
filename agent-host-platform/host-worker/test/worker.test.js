import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
const require_fs = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }; import os from 'node:os'; import path from 'node:path';
import { makeWorker } from '../src/worker.js'; import { makeApi } from '../src/api.js'; import { validateManifest } from '../src/manifest.js';
import { loadState, saveState } from '../src/state.js';
import { makeArtifact, goodManifest, fakePlane, fakeDocker } from './helpers.js';

async function setup(artifacts, healthFn = async () => ({ ok: true })) {
  const plane = await fakePlane(artifacts), docker = fakeDocker(), root = mkdtempSync(path.join(os.tmpdir(), 'w-'));
   const cfg = { hostName: 'h', hostType: 'vm', pollMs: 1, appsDir: root + '/apps', cacheDir: root + '/cache', stateFile: root + '/state.json' };
  const state = await loadState(cfg.stateFile), save = () => saveState(cfg.stateFile, state);
  const api = makeApi({ baseUrl: plane.url, hostId: 'h1', getToken: () => 'tok', sleep: async () => {} });
  const mk = (st = state) => makeWorker({ api, docker, cfg, state: st, save, version: 't', health: healthFn, metrics: async () => ({ mem_free: 8e9, disk_free: 50e9 }) });
  return { plane, docker, state, cfg, mk, worker: mk() };
}
const PID = (n) => ({ demo: 'aaaaaaaa-0000-4000-8000-000000000001', one: 'aaaaaaaa-0000-4000-8000-000000000002', two: 'aaaaaaaa-0000-4000-8000-000000000003' }[n]);
const dep = (id, project, version, art) => ({ id, type: 'deploy', payload: { project_id: PID(project), version, artifact_id: art, deployment_id: 'bbbbbbbb-0000-4000-8000-0000000000' + id.padStart(2, '0') } });
const result = (plane, id) => plane.log.find((l) => l.u === `/v1/tasks/${id}/complete`) || plane.log.find((l) => l.u === `/v1/tasks/${id}/fail`);

test('manifest validation', () => {
  assert.equal(validateManifest(goodManifest()).port, 8080);
  assert.throws(() => validateManifest({ ...goodManifest(), runtime: 'bash' }), /runtime/);
  assert.throws(() => validateManifest({ ...goodManifest(), build: { dockerfile: '../x' } }), /dockerfile/);
});
test('auto deploy: outbound-only flow, lease token on mutations, bearer auth', async () => {
  const a = makeArtifact(goodManifest()); const { plane, docker, worker } = await setup({ a1: a });
  plane.tasks.push(dep('t1', 'demo', '1.0.0', 'a1')); await worker.tick();
  const r = result(plane, 't1'); assert.equal(r.u, '/v1/tasks/t1/complete'); assert.equal(r.body.lease_token, 'lease-t1'); assert.equal(r.body.result.health, 'healthy'); assert.equal(r.body.result.status, 'running'); assert.ok(r.body.result.container_ids.length === 1);
  assert.equal(r.auth, 'Bearer tok'); assert.equal(docker.c.size, 1); plane.close();
});
test('checksum mismatch is rejected before any build', async () => {
  const a = makeArtifact(goodManifest()); a.checksum = '0'.repeat(64); const { plane, docker, worker } = await setup({ a1: a });
  plane.tasks.push(dep('t1', 'demo', '1', 'a1')); await worker.tick();
  assert.equal(result(plane, 't1').u, '/v1/tasks/t1/fail'); assert.equal(result(plane, 't1').body.code, 'ARTIFACT_INVALID'); assert.equal(docker.calls.filter((c) => c[0] === 'build').length, 0); plane.close();
});
test('second app does not disturb the first (isolation)', async () => {
  const { plane, docker, worker } = await setup({ a: makeArtifact(goodManifest('one')), b: makeArtifact(goodManifest('two')) });
  plane.tasks.push(dep('t1', 'one', '1', 'a')); await worker.tick(); plane.tasks.push(dep('t2', 'two', '1', 'b')); await worker.tick();
  assert.equal(docker.c.size, 2); assert.ok([...docker.c.values()].every((x) => x.running)); plane.close();
});
test('failed health check rolls back: previous version keeps running, broken one removed', async () => {
  let ok = true; const { plane, docker, worker, state } = await setup({ a: makeArtifact(goodManifest()), b: makeArtifact(goodManifest()) }, async () => ok ? { ok: true } : { ok: false, reason: 'HTTP 500' });
  plane.tasks.push(dep('t1', 'demo', '1', 'a')); await worker.tick(); const good = state.apps[PID('demo')].current.container;
  ok = false; plane.tasks.push(dep('t2', 'demo', '2', 'b')); await worker.tick();
  assert.equal(result(plane, 't2').u, '/v1/tasks/t2/fail'); assert.equal(result(plane, 't2').body.code, 'HEALTH_FAILED'); assert.equal(result(plane, 't2').body.rolled_back, true); assert.equal(state.apps[PID('demo')].current.version, '1');
  assert.equal(docker.c.get(good).running, true); assert.equal(docker.c.size, 1); plane.close();
});
test('worker restart does not destroy apps or re-run seen tasks; state persists', async () => {
  const { plane, docker, worker, cfg, mk } = await setup({ a: makeArtifact(goodManifest()) });
  plane.tasks.push(dep('t1', 'demo', '1', 'a')); await worker.tick();
  const st2 = await loadState(cfg.stateFile); const w2 = mk(st2);
  assert.equal(docker.c.size, 1); assert.equal(st2.apps[PID('demo')].current.version, '1');
  plane.tasks.push(dep('t1', 'demo', '1', 'a')); await w2.tick(); assert.equal(docker.calls.filter((c) => c[0] === 'run').length, 1); plane.close();
});
test('insufficient resources are rejected, disallowed task types refused', async () => {
  const m = goodManifest(); m.resources.memory = '900g'; const { plane, worker } = await setup({ a: makeArtifact(m) });
  plane.tasks.push(dep('t1', 'demo', '1', 'a'), { id: 't2', type: 'shell', payload: {} }); await worker.tick();
  assert.equal(result(plane, 't1').body.code, 'INSUFFICIENT_RESOURCES'); assert.equal(result(plane, 't2').body.code, 'EXECUTION_FAILED'); assert.equal(result(plane, 't2').body.error, undefined); plane.close();
});
test('manual rollback task restores previous version', async () => {
  const { plane, docker, worker, state } = await setup({ a: makeArtifact(goodManifest()), b: makeArtifact(goodManifest()) });
  plane.tasks.push(dep('t1', 'demo', '1', 'a')); await worker.tick(); plane.tasks.push(dep('t2', 'demo', '2', 'b')); await worker.tick();
  plane.tasks.push({ id: 't3', type: 'rollback', payload: { project_id: PID('demo') } }); await worker.tick();
  assert.equal(state.apps[PID('demo')].current.version, '1'); assert.equal(result(plane, 't3').u, '/v1/tasks/t3/complete'); plane.close();
});
test('failed start acknowledgement: task is NOT executed', async () => {
  const { plane, docker, worker } = await setup({ a: makeArtifact(goodManifest()) });
  plane.failStart = true; plane.tasks.push(dep('t1', 'demo', '1', 'a')); await worker.tick();
  assert.equal(docker.calls.filter((c) => c[0] === 'build').length, 0); plane.close();
});
test('unacknowledged complete stays pending, is retried, never re-executed', async () => {
  const { plane, docker, worker, state } = await setup({ a: makeArtifact(goodManifest()) });
  plane.failComplete = 20; plane.tasks.push(dep('t1', 'demo', '1', 'a')); await worker.tick();
  assert.ok(state.pending.t1); assert.ok(!state.seen_tasks.includes('t1'));
  plane.failComplete = 0; await worker.tick();
  assert.ok(!state.pending.t1); assert.ok(state.seen_tasks.includes('t1')); assert.equal(docker.calls.filter((c) => c[0] === 'run').length, 1); plane.close();
});
test('lease renewal is called during a long build', async () => {
  const { plane, docker, cfg, worker } = await setup({ a: makeArtifact(goodManifest()) });
  cfg.leaseRenewMs = 20; const ob = docker.build; docker.build = async (...a) => { await new Promise((r) => setTimeout(r, 120)); return ob(...a); };
  plane.tasks.push(dep('t1', 'demo', '1', 'a')); await worker.tick();
  assert.ok(plane.log.filter((l) => l.u === '/v1/tasks/t1/renew').length >= 2); plane.close();
});

test('strict fail body: only lease_token, code, rolled_back (no logs or freeform text)', async () => {
  const a = makeArtifact(goodManifest()); a.checksum = '0'.repeat(64); const { plane, worker } = await setup({ a1: a });
  plane.tasks.push(dep('t1', 'demo', '1', 'a1')); await worker.tick();
  assert.deepEqual(Object.keys(result(plane, 't1').body).sort(), ['code', 'lease_token', 'rolled_back']); plane.close();
});
test('archives with symlinks are rejected before extraction', async () => {
  const { execFileSync } = await import('node:child_process'); const fs = await import('node:fs');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-')); fs.writeFileSync(path.join(d, 'agent.deploy.json'), JSON.stringify(goodManifest())); fs.symlinkSync('/etc/passwd', path.join(d, 'evil'));
  const tgz = path.join(os.tmpdir(), 'ln-' + Math.random().toString(36).slice(2) + '.tgz'); execFileSync('tar', ['-czf', tgz, '-C', d, '.']);
  const { inspectArchive } = await import('../src/deploy.js'); await assert.rejects(inspectArchive(tgz), /links or special/);
});
test('heartbeat body matches protocol v1 (flat, advertised capabilities)', async () => {
  const { plane, worker } = await setup({}); await worker.tick(); const hb = plane.log.find((l) => l.u === '/v1/hosts/h1/heartbeat').body;
  for (const k of ['worker_version', 'capabilities', 'cpu_percent', 'memory_free_bytes', 'disk_free_bytes', 'uptime_seconds', 'docker', 'applications']) assert.ok(k in hb, k);
  assert.ok(!hb.capabilities.includes('shell')); plane.close();
});
test('secrets: fetched via fenced endpoint, passed to docker, never in results or state', async () => {
  const a = makeArtifact(goodManifest()); const { plane, docker, worker, state, cfg } = await setup({ a1: a });
  const orig = fetch; let secretCalls = 0;
  plane.secretEnv = { API_KEY: 'sup3r-secret-value' };
  const t = dep('t1', 'demo', '1', 'a1'); t.payload.secret_refs = ['API_KEY']; plane.tasks.push(t); await worker.tick();
  const call = plane.log.find((l) => l.u === '/v1/tasks/t1/secrets'); assert.equal(call.body.lease_token, 'lease-t1');
  assert.equal([...docker.c.values()][0].o.env.API_KEY, 'sup3r-secret-value');
  const dump = JSON.stringify(plane.log.filter((l) => l.u.endsWith('/complete') || l.u.endsWith('/fail'))) + JSON.stringify(state) + require_fs(cfg.stateFile);
  assert.ok(!dump.includes('sup3r-secret-value')); plane.close();
});
test('secrets fail closed when the endpoint denies them', async () => {
  const a = makeArtifact(goodManifest()); const { plane, docker, worker } = await setup({ a1: a });
  plane.secretEnv = null; const t = dep('t1', 'demo', '1', 'a1'); t.payload.secret_refs = ['API_KEY']; plane.tasks.push(t); await worker.tick();
  assert.equal(result(plane, 't1').body.code, 'EXECUTION_FAILED'); assert.equal(docker.c.size, 0); plane.close();
});
test('prolonged renew outage marks the lease lost: no further side effects, LEASE_EXPIRED reported', async () => {
  const { plane, docker, cfg, worker } = await setup({ a: makeArtifact(goodManifest()) });
  cfg.leaseRenewMs = 10; cfg.leaseSafeMs = 40; plane.failRenew = true; const ob = docker.build; docker.build = async (...a) => { await new Promise((r) => setTimeout(r, 150)); return ob(...a); };
  plane.tasks.push(dep('t1', 'demo', '1', 'a')); await worker.tick();
  assert.equal(docker.calls.filter((c) => c[0] === 'run').length, 0); assert.equal(result(plane, 't1').body.code, 'LEASE_EXPIRED'); plane.close();
});
test('rollback restarts the retained previous container and aborts safely if health fails', async () => {
  let ok = true; const { plane, docker, worker, state } = await setup({ a: makeArtifact(goodManifest()), b: makeArtifact(goodManifest()) }, async () => ok ? { ok: true } : { ok: false, reason: 'x' });
  plane.tasks.push(dep('t1', 'demo', '1', 'a')); await worker.tick(); plane.tasks.push(dep('t2', 'demo', '2', 'b')); await worker.tick();
  const v2 = state.apps[PID('demo')].current.container; ok = false;
  plane.tasks.push({ id: 't3', type: 'rollback', payload: { project_id: PID('demo') } }); await worker.tick();
  assert.equal(result(plane, 't3').body.code, 'HEALTH_FAILED'); assert.equal(state.apps[PID('demo')].current.container, v2); assert.equal(docker.c.get(v2).running, true); plane.close();
});
