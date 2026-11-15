// SPDX-License-Identifier: AGPL-3.0-or-later
// P1-DEPLOY rollback drill only: the planted web process. Copied over apps/web/server.js (the web entry) in
// the "plant" target of infra/image/Dockerfile (plain JavaScript is valid input to Node's type
// stripping). /healthz answers PLANT_STATUS (500 by default; 503 tests the full 120 s wait);
// every other path answers a short text, so the drill can see the planted image is live.
import { createServer } from 'node:http';

const status = Number(process.env.PLANT_STATUS ?? 500);
const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?', 1)[0];
  res.writeHead(path === '/healthz' ? status : 200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  res.end(path === '/healthz' ? `planted ${status}\n` : 'planted image\n');
});
server.listen(Number(process.env.PORT ?? 3000));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
