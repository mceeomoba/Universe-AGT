// Control-plane client. Outbound HTTPS only. Retries with backoff on network/5xx errors.
export function makeApi({ baseUrl, getToken, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  async function call(method, path, body, { retries = 5, raw = false } = {}) {
    let delay = 500, last;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetchImpl(baseUrl.replace(/\/$/, '') + path, { method, headers: { 'content-type': 'application/json', ...(getToken() ? { authorization: 'Bearer ' + getToken() } : {}) }, body: body ? JSON.stringify(body) : undefined });
        if (res.status >= 500 || res.status === 429) throw Object.assign(new Error('HTTP ' + res.status), { retry: true });
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${path}`), { status: res.status });
        return raw ? res : (res.status === 204 ? {} : await res.json());
      } catch (e) {
        last = e; if (e.status && !e.retry) throw e;
        if (i < retries) { await sleep(delay + Math.random() * 250); delay = Math.min(delay * 2, 30000); }
      }
    }
    throw last;
  }
  return {
    register: (b) => call('POST', '/v1/hosts/register', b),
    heartbeat: (id, b) => call('POST', `/v1/hosts/${id}/heartbeat`, b),
    claim: (id, max) => call('POST', `/v1/hosts/${id}/tasks/claim`, { max }),
    start: (taskId, lease) => call('POST', `/v1/tasks/${taskId}/start`, { lease_token: lease }),
    event: (taskId, type, data, lease) => call('POST', `/v1/tasks/${taskId}/events`, { type, data, lease_token: lease }, { retries: 1 }),
    complete: (taskId, result, lease) => call('POST', `/v1/tasks/${taskId}/complete`, { result, lease_token: lease }),
    fail: (taskId, error, lease) => call('POST', `/v1/tasks/${taskId}/fail`, { error, lease_token: lease }),
    artifactMeta: (id) => call('GET', `/v1/artifacts/${id}`),
    artifactDownload: (id) => call('GET', `/v1/artifacts/${id}/download`, null, { raw: true }),
    secrets: (deploymentId) => call('GET', `/v1/deployments/${deploymentId}/secrets`),
    upsertDeployment: (b) => call('POST', '/v1/deployments/report', b),
  };
}
