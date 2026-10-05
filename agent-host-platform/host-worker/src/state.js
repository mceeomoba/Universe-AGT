// Durable local state (survives worker restarts). Containers are independent of the worker process.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
export async function loadState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return { apps: {}, seen_tasks: [], crashes: [] }; }
}
export async function saveState(file, st) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp'; await writeFile(tmp, JSON.stringify(st, null, 2), { mode: 0o600 }); await rename(tmp, file);
}
