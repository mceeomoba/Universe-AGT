// Thin docker CLI wrapper. Only allowlisted subcommands; arguments are always passed as an argv array (no shell).
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const ALLOWED = new Set(['build', 'run', 'stop', 'start', 'restart', 'rm', 'rmi', 'ps', 'logs', 'inspect', 'rename', 'info', 'port']);
export function makeDocker(bin = 'docker') {
  const run = (args, { timeout = 600000, input } = {}) => new Promise((resolve, reject) => {
    if (!ALLOWED.has(args[0])) return reject(new Error('docker subcommand not allowed: ' + args[0]));
    const p = execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(Object.assign(new Error((stderr || err.message).toString().slice(-4000)), { code: err.code })) : resolve(stdout.toString()));
    if (input) p.stdin.end(input);
  });
  return {
    available: async () => { try { await run(['info', '--format', '{{.ServerVersion}}'], { timeout: 10000 }); return true; } catch { return false; } },
    build: (tag, dir, dockerfile) => run(['build', '-t', tag, '-f', dockerfile, dir]),
    // Secrets go through a 0600 env-file deleted right after `docker run`, never through argv (visible in ps) or logs.
    run: async (o) => {
      const entries = Object.entries(o.env || {}); let dir, envArgs = [];
      if (entries.length) {
        dir = await mkdtemp(path.join(os.tmpdir(), 'ahw-')); const file = path.join(dir, 'env');
        await writeFile(file, entries.map(([k, v]) => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /[\r\n]/.test(String(v))) throw new Error('invalid secret name or value'); return `${k}=${v}`; }).join('\n') + '\n', { mode: 0o600 });
        envArgs = ['--env-file', file];
      }
      try {
        return await run(['run', '-d', '--name', o.name, '--restart', o.restart, '--memory', String(o.memory), '--cpus', String(o.cpu),
          '--label', 'agent-host.project=' + o.project, '--label', 'agent-host.deployment=' + o.deployment, '--label', 'agent-host.version=' + o.version,
          '-p', `127.0.0.1:${o.hostPort}:${o.port}`, ...envArgs, o.image]);
      } catch (e) { throw new Error(String(e.message).replace(/--env-file \S+/g, '--env-file <redacted>')); }
      finally { if (dir) await rm(dir, { recursive: true, force: true }); }
    },
    stop: (n) => run(['stop', '-t', '15', n]), start: (n) => run(['start', n]), restart: (n) => run(['restart', n]),
    rm: (n) => run(['rm', '-f', n]), rmi: (t) => run(['rmi', t]).catch(() => {}),
    logs: (n, tail = 200) => run(['logs', '--tail', String(tail), n], { timeout: 30000 }),
    state: async (n) => { try { return JSON.parse(await run(['inspect', n], { timeout: 15000 }))[0].State; } catch { return null; } },
    list: async () => (await run(['ps', '-a', '--filter', 'label=agent-host.project', '--format', '{{json .}}'], { timeout: 15000 })).split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}
