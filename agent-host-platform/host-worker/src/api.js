// Control-plane client for Worker protocol v1 (docs/control-plane-contract.md). Outbound HTTPS only.
export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
export function makeApi({ baseUrl, hostId, getToken, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  async function call(method, path, body, { retries = 4 } = {}) {
    let delay = 500, last;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetchImpl(baseUrl.replace(/\/$/, '') + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + getToken() }, body: body === undefined ? undefined : JSON.stringify(body) });
        if (res.status >= 500 || res.status === 429) throw Object.assign(new ApiError('HTTP ' + res.status, res.status), { retry: true });
        if (!res.ok) throw new ApiError(`HTTP ${res.status} ${path}`, res.status);
        return res.status === 204 ? {} : await res.json();
      } catch (e) {
        last = e; if (e instanceof ApiError && !e.retry) throw e;
        if (i < retries) { await sleep(delay + Math.random() * 250); delay = Math.min(delay * 2, 30000); }
      }
    }
    throw last;
  }
  return {
    heartbeat: (b) => call('POST', `/v1/hosts/${hostId}/heartbeat`, b),
    claim: () => call('POST', `/v1/hosts/${hostId}/tasks/claim`, {}),           // -> {task|null, lease_token, lease_expires_at}
    start: (id, lease) => call('POST', `/v1/tasks/${id}/start`, { lease_token: lease }, { retries: 1 }),
    renew: (id, lease) => call('POST', `/v1/tasks/${id}/renew`, { lease_token: lease }, { retries: 0 }),
    complete: (id, lease, result) => call('POST', `/v1/tasks/${id}/complete`, { lease_token: lease, result }),
    fail: (id, lease, code, rolledBack) => call('POST', `/v1/tasks/${id}/fail`, { lease_token: lease, code, rolled_back: !!rolledBack }),
    // Returns {env}. Never log the response; callers must not persist it.
    secrets: (id, lease) => call('POST', `/v1/tasks/${id}/secrets`, { lease_token: lease }, { retries: 1 }),
    artifact: (id) => call('GET', `/v1/artifacts/${id}`),                       // -> {artifact:{checksum,size,version}, download_url}
    download: async (url) => { const r = await fetchImpl(url); if (!r.ok) throw new ApiError('artifact download HTTP ' + r.status, r.status); return r; },
  };
}
