// Thin docker CLI wrapper. Only allowlisted subcommands; arguments are always passed as an argv array (no shell).
import { execFile } from 'node:child_process';
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
    run: (o) => run(['run', '-d', '--name', o.name, '--restart', o.restart, '--memory', String(o.memory), '--cpus', String(o.cpu),
      '--label', 'agent-host.project=' + o.project, '--label', 'agent-host.deployment=' + o.deployment, '--label', 'agent-host.version=' + o.version,
      '-p', `127.0.0.1:${o.hostPort}:${o.port}`, ...Object.entries(o.env || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]), o.image]),
    stop: (n) => run(['stop', '-t', '15', n]), start: (n) => run(['start', n]), restart: (n) => run(['restart', n]),
    rm: (n) => run(['rm', '-f', n]), rmi: (t) => run(['rmi', t]).catch(() => {}),
    logs: (n, tail = 200) => run(['logs', '--tail', String(tail), n], { timeout: 30000 }),
    state: async (n) => { try { return JSON.parse(await run(['inspect', n], { timeout: 15000 }))[0].State; } catch { return null; } },
    list: async () => (await run(['ps', '-a', '--filter', 'label=agent-host.project', '--format', '{{json .}}'], { timeout: 15000 })).split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}
