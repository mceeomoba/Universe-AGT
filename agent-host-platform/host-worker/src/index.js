#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { makeApi } from './api.js';
import { makeDocker } from './docker.js';
import { makeWorker } from './worker.js';
import { loadState, saveState } from './state.js';
const VERSION = '0.1.0';
const env = process.env;
const root = env.AGENT_HOST_ROOT || '/opt/agent-host';
let token = env.AGENT_HOST_TOKEN || '';
const cfg = {
  controlPlane: env.AGENT_HOST_CONTROL_PLANE, hostName: env.AGENT_HOST_NAME || 'persistent-host', hostType: env.AGENT_HOST_TYPE || 'vm',
  enrollmentToken: env.AGENT_HOST_ENROLLMENT_TOKEN, pollMs: Number(env.AGENT_HOST_POLL_MS || 5000),
  appsDir: env.AGENT_APPS_DIR || '/srv/agent-apps', cacheDir: `${root}/cache`, stateFile: `${root}/runtime/state.json`, setToken: (t) => { token = t; },
};
if (!cfg.controlPlane) { console.error('AGENT_HOST_CONTROL_PLANE is required'); process.exit(2); }
const state = await loadState(cfg.stateFile); if (state.host_token && !token) token = state.host_token;
const save = () => saveState(cfg.stateFile, state);
const worker = makeWorker({ api: makeApi({ baseUrl: cfg.controlPlane, getToken: () => token }), docker: makeDocker(), cfg, state, save, version: VERSION });
process.on('SIGTERM', () => worker.stop()); process.on('SIGINT', () => worker.stop());
await worker.loop();
