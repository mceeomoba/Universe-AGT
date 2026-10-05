import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os'; import path from 'node:path';
export function makeArtifact(manifest, extra = {}) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'art-'));
  writeFileSync(path.join(d, 'agent.deploy.json'), JSON.stringify(manifest)); writeFileSync(path.join(d, 'Dockerfile'), 'FROM scratch\n');
  for (const [k, v] of Object.entries(extra)) writeFileSync(path.join(d, k), v);
  const tgz = path.join(os.tmpdir(), 'a-' + Math.random().toString(36).slice(2) + '.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', d, '.']); const buf = readFileSync(tgz);
  return { buf, checksum: createHash('sha256').update(buf).digest('hex') };
}
export const goodManifest = (name = 'demo') => ({ name, runtime: 'docker', build: { dockerfile: 'Dockerfile' }, service: { port: 8080, healthcheck: '/health' }, resources: { memory: '64m', cpu: '0.5' }, restart: 'unless-stopped' });
// Fake control plane implementing Worker protocol v1 (leased tasks, strict results).
export function fakePlane(artifacts) {
  const log = [], tasks = [], srvState = { failStart: false, failComplete: 0 };
  const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    const body = b ? JSON.parse(b) : {}; const u = req.url; log.push({ m: req.method, u, body, auth: req.headers.authorization });
    const j = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const P = srvState;
    if (/\/start$/.test(u) && P.failStart) return j({ error: 'lease' }, 409);
    if (/\/complete$/.test(u) && P.failComplete > 0) { P.failComplete--; return j({ error: 'down' }, 503); }
    if (u.endsWith('/heartbeat')) return j({ ok: true });
    if (u.endsWith('/tasks/claim')) { const t = tasks.shift(); return t ? j({ task: { ...t, lease_token: 'lease-' + t.id }, lease_token: 'lease-' + t.id, lease_expires_at: new Date(Date.now() + 90000).toISOString() }) : j({ task: null }); }
    let m = /^\/dl\/(\w+)$/.exec(u); if (m) { res.writeHead(200); return res.end(artifacts[m[1]].buf); }
    m = /^\/v1\/artifacts\/(\w+)$/.exec(u); if (m) return j({ artifact: { id: m[1], checksum: artifacts[m[1]].checksum, size: artifacts[m[1]].buf.length, version: '1' }, download_url: `http://127.0.0.1:${srv.address().port}/dl/${m[1]}`, expires_in: 120 });
    return j({ ok: true });
  }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: 'http://127.0.0.1:' + srv.address().port, log, tasks, close: () => srv.close(), set failStart(v) { srvState.failStart = v; }, set failComplete(v) { srvState.failComplete = v; } })));
}
export function fakeDocker() {
  const c = new Map(), calls = [];
  return { c, calls, available: async () => true, list: async () => [...c.keys()].map((n) => ({ Names: n })),
    build: async (t) => { calls.push(['build', t]); }, run: async (o) => { calls.push(['run', o.name]); c.set(o.name, { running: true, o }); },
    stop: async (n) => { calls.push(['stop', n]); if (c.has(n)) c.get(n).running = false; }, start: async (n) => { c.get(n).running = true; }, restart: async (n) => { c.get(n).running = true; },
    rm: async (n) => { calls.push(['rm', n]); c.delete(n); }, rmi: async () => {}, logs: async () => 'log line', state: async (n) => c.has(n) ? { Running: c.get(n).running, Status: c.get(n).running ? 'running' : 'exited' } : null };
}
