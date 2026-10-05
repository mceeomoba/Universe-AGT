import os from 'node:os';
import { statfs } from 'node:fs/promises';
export async function systemMetrics(path = '/') {
  const load = os.loadavg()[0], cpus = os.cpus().length;
  let diskFree = 0, diskTotal = 0;
  try { const s = await statfs(path); diskFree = s.bavail * s.bsize; diskTotal = s.blocks * s.bsize; } catch {}
  return { cpu_count: cpus, cpu_load_pct: Math.min(100, Math.round((load / cpus) * 100)), mem_total: os.totalmem(), mem_free: os.freemem(), disk_total: diskTotal, disk_free: diskFree, uptime_s: Math.round(os.uptime()), platform: os.platform(), arch: os.arch() };
}
// Spec section 19: check capacity first, never overload the VM.
export function checkCapacity(metrics, need, reserve = { mem: 256 * 1048576, disk: 1073741824 }) {
  if (need.memory && metrics.mem_free - reserve.mem < need.memory) return 'insufficient resources: memory';
  if (need.disk && metrics.disk_free - reserve.disk < need.disk) return 'insufficient resources: disk';
  return null;
}
