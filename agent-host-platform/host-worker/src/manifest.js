// Validates agent.deploy.json (spec section 10). Returns the normalized manifest or throws.
const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export function parseSize(v, field) {
  const m = /^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/i.exec(String(v).trim());
  if (!m) throw new Error(`manifest: ${field} invalid size "${v}"`);
  const mult = { b: 1, k: 1024, kb: 1024, m: 1048576, mb: 1048576, g: 1073741824, gb: 1073741824 }[(m[2] || 'b').toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult);
}
export function validateManifest(raw) {
  let m = raw;
  if (typeof raw === 'string') { try { m = JSON.parse(raw); } catch { throw new Error('manifest: not valid JSON'); } }
  if (!m || typeof m !== 'object') throw new Error('manifest: must be an object');
  if (!NAME.test(String(m.name || ''))) throw new Error('manifest: name must match ' + NAME);
  if (m.runtime !== 'docker') throw new Error('manifest: runtime must be "docker"');
  const dockerfile = (m.build && m.build.dockerfile) || 'Dockerfile';
  if (typeof dockerfile !== 'string' || dockerfile.includes('..') || dockerfile.startsWith('/')) throw new Error('manifest: build.dockerfile must be a relative path inside the artifact');
  const port = m.service && m.service.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('manifest: service.port must be 1-65535');
  const healthcheck = (m.service && m.service.healthcheck) || '/health';
  if (!String(healthcheck).startsWith('/')) throw new Error('manifest: service.healthcheck must start with /');
  const memory = parseSize((m.resources && m.resources.memory) || '512m', 'resources.memory');
  const cpu = Number((m.resources && m.resources.cpu) ?? 1);
  if (!(cpu > 0 && cpu <= 64)) throw new Error('manifest: resources.cpu must be > 0');
  const restart = m.restart || 'unless-stopped';
  if (!['no', 'on-failure', 'always', 'unless-stopped'].includes(restart)) throw new Error('manifest: restart invalid');
  const disk = m.requirements && m.requirements.disk ? parseSize(m.requirements.disk, 'requirements.disk') : 0;
  return { name: m.name, runtime: 'docker', dockerfile, port, healthcheck, memory, cpu, restart, disk, domains: Array.isArray(m.domains) ? m.domains.map(String) : [] };
}
