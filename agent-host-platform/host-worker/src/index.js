#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { makeApi } from './api.js';
import { makeDocker } from './docker.js';
import { makeWorker } from './worker.js';
import { loadState, saveState } from './state.js';
const VERSION = '0.1.0';
const env = process.env;
const root = env.AGENT_HOST_ROOT || '/opt/agent-host';
// Token comes from a root-owned 0600 file (AGENT_HOST_TOKEN_FILE); env is only a dev fallback. It is never printed.
const token = (env.AGENT_HOST_TOKEN_FILE ? await readFile(env.AGENT_HOST_TOKEN_FILE, 'utf8').catch(() => '') : (env.AGENT_HOST_TOKEN || '')).replace(/\s+/g, '');
const cfg = {
  controlPlane: env.AGENT_HOST_CONTROL_PLANE, hostName: env.AGENT_HOST_NAME || 'persistent-host', hostType: env.AGENT_HOST_TYPE || 'vm',
  hostId: env.AGENT_HOST_ID, pollMs: Number(env.AGENT_HOST_POLL_MS || 5000),
  appsDir: env.AGENT_APPS_DIR || '/srv/agent-apps', cacheDir: `${root}/cache`, stateFile: `${root}/runtime/state.json`,
};
if (!cfg.controlPlane || !cfg.hostId || !token) { console.error('AGENT_HOST_CONTROL_PLANE, AGENT_HOST_ID and a readable AGENT_HOST_TOKEN_FILE are required'); process.exit(2); }
const state = await loadState(cfg.stateFile);
const save = () => saveState(cfg.stateFile, state);
const worker = makeWorker({ api: makeApi({ baseUrl: cfg.controlPlane, hostId: cfg.hostId, getToken: () => token }), docker: makeDocker(), cfg, state, save, version: VERSION });
if (process.argv.includes('--check')) { // one authenticated heartbeat, then exit (used by the installer)
  try { await worker.heartbeat(); console.log('authenticated heartbeat OK'); process.exit(0); } catch (e) { console.error('heartbeat failed: ' + (e.status ? 'HTTP ' + e.status : String(e.message).replace(/[0-9a-fA-F]{40,}/g, '<redacted>'))); process.exit(1); }
}
process.on('SIGTERM', () => worker.stop()); process.on('SIGINT', () => worker.stop());
await worker.loop();
