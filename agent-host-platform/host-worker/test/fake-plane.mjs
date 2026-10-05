// CI-only fake control plane: records the SHA-256 of each bearer token it sees (never the token itself).
import { createServer } from 'node:http'; import { createHash } from 'node:crypto'; import { appendFileSync } from 'node:fs';
const port = Number(process.argv[2] || 18080), log = process.argv[3] || '/tmp/plane.log';
createServer((req, res) => { req.resume(); req.on('end', () => {
  const b = (req.headers.authorization || '').replace(/^Bearer /, '');
  appendFileSync(log, JSON.stringify({ m: req.method, u: req.url, bearer_sha256: b ? createHash('sha256').update(b).digest('hex') : null }) + '\n');
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url.endsWith('/claim') ? '{"task":null}' : '{"ok":true}');
}); }).listen(port, '127.0.0.1');
