import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeWorker } from '../src/worker.js'; import { makeApi } from '../src/api.js'; import { validateManifest } from '../src/manifest.js';
import { loadState, saveState } from '../src/state.js';
import { makeArtifact, goodManifest, fakePlane, fakeDocker } from './helpers.js';

async function setup(artifacts, healthFn = async () => ({ ok: true })) {
  const plane = await fakePlane(artifacts), docker = fakeDocker(), root = mkdtempSync(path.join(os.tmpdir(), 'w-'));
  let token = ''; const cfg = { hostName: 'h', hostType: 'vm', enrollmentToken: 'e', pollMs: 1, appsDir: root + '/apps', cacheDir: root + '/cache', stateFile: root + '/state.json', setToken: (t) => { token = t; } };
  const state = await loadState(cfg.stateFile), save = () => saveState(cfg.stateFile, state);
  const api = makeApi({ baseUrl: plane.url, getToken: () => token, sleep: async () => {} });
  const mk = (st = state) => makeWorker({ api, docker, cfg, state: st, save, version: 't', health: healthFn, metrics: async () => ({ mem_free: 8e9, disk_free: 50e9 }) });
  return { plane, docker, state, cfg, mk, worker: mk() };
}
const dep = (id, project, version, art) => ({ id, type: 'deploy', payload: { project, version, artifact_id: art, deployment_id: id } });
const result = (plane, id) => plane.log.find((l) => l.u === `/v1/tasks/${id}/complete`) || plane.log.find((l) => l.u === `/v1/tasks/${id}/fail`);

test('manifest validation', () => {
  assert.equal(validateManifest(goodManifest()).port, 8080);
  assert.throws(() => validateManifest({ ...goodManifest(), runtime: 'bash' }), /runtime/);
  assert.throws(() => validateManifest({ ...goodManifest(), build: { dockerfile: '../x' } }), /dockerfile/);
});
test('auto deploy: outbound-only flow, lease token on mutations, bearer auth', async () => {
  const a = makeArtifact(goodManifest()); const { plane, docker, worker } = await setup({ a1: a });
  plane.tasks.push(dep('t1', 'demo', '1.0.0', 'a1')); await worker.tick();
  const r = result(plane, 't1'); assert.equal(r.u, '/v1/tasks/t1/complete'); assert.equal(r.body.lease_token, 'lease-t1'); assert.equal(r.body.result.health, 'healthy');
  assert.equal(r.auth, 'Bearer tok'); assert.equal(docker.c.size, 1); plane.close();
});
test('checksum mismatch is rejected before any build', async () => {
  const a = makeArtifact(goodManifest()); a.checksum = '0'.repeat(64); const { plane, docker, worker } = await setup({ a1: a });
  plane.tasks.push(dep('t1', 'demo', '1', 'a1')); await worker.tick();
  assert.equal(result(plane, 't1').u, '/v1/tasks/t1/fail'); assert.equal(docker.calls.filter((c) => c[0] === 'build').length, 0); plane.close();
});
test('second app does not disturb the first (isolation)', async () => {
  const { plane, docker, worker } = await setup({ a: makeArtifact(goodManifest('one')), b: makeArtifact(goodManifest('two')) });
  plane.tasks.push(dep('t1', 'one', '1', 'a')); await worker.tick(); plane.tasks.push(dep('t2', 'two', '1', 'b')); await worker.tick();
  assert.equal(docker.c.size, 2); assert.ok([...docker.c.values()].every((x) => x.running)); plane.close();
});
test('failed health check rolls back: previous version keeps running, broken one removed', async () => {
  let ok = true; const { plane, docker, worker, state } = await setup({ a: makeArtifact(goodManifest()), b: makeArtifact(goodManifest()) }, async () => ok ? { ok: true } : { ok: false, reason: 'HTTP 500' });
  plane.tasks.push(dep('t1', 'demo', '1', 'a')); await worker.tick(); const good = state.apps.demo.current.container;
  ok = false; plane.tasks.push(dep('t2', 'demo', '2', 'b')); await worker.tick();
  assert.equal(result(plane, 't2').u, '/v1/tasks/t2/fail'); assert.equal(state.apps.demo.current.version, '1');
  assert.equal(docker.c.get(good).running, true); assert.equal(docker.c.size, 1); plane.close();
});
test('worker restart does not destroy apps or re-run seen tasks; state persists', async () => {
  const { plane, docker, worker, cfg, mk } = await setup({ a: makeArtifact(goodManifest()) });
  plane.tasks.push(dep('t1', 'demo', '1', 'a')); await worker.tick();
  const st2 = await loadState(cfg.stateFile); const w2 = mk(st2);
  assert.equal(docker.c.size, 1); assert.equal(st2.apps.demo.current.version, '1');
  plane.tasks.push(dep('t1', 'demo', '1', 'a')); await w2.tick(); assert.equal(docker.calls.filter((c) => c[0] === 'run').length, 1); plane.close();
});
test('insufficient resources are rejected, disallowed task types refused', async () => {
  const m = goodManifest(); m.resources.memory = '900g'; const { plane, worker } = await setup({ a: makeArtifact(m) });
  plane.tasks.push(dep('t1', 'demo', '1', 'a'), { id: 't2', type: 'shell', payload: { cmd: 'rm -rf /' } }); await worker.tick();
  assert.match(result(plane, 't1').body.error.message, /insufficient resources/); assert.match(result(plane, 't2').body.error.message, /not allowed/); plane.close();
});
test('manual rollback task restores previous version', async () => {
  const { plane, docker, worker, state } = await setup({ a: makeArtifact(goodManifest()), b: makeArtifact(goodManifest()) });
  plane.tasks.push(dep('t1', 'demo', '1', 'a')); await worker.tick(); plane.tasks.push(dep('t2', 'demo', '2', 'b')); await worker.tick();
  plane.tasks.push({ id: 't3', type: 'rollback', payload: { project: 'demo' } }); await worker.tick();
  assert.equal(state.apps.demo.current.version, '1'); assert.equal(result(plane, 't3').u, '/v1/tasks/t3/complete'); plane.close();
});
