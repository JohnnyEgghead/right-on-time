// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1689 (the relay's /textsize handler had no try/catch: a failed simctl call ended the relay and the rest of the run)
// Runs the real relay with a fake xcrun that always fails; the answer is 500 and the relay still answers the next call.
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const relayFile = path.resolve(import.meta.dirname, '../../apps/tech-native/xcuitest/signal-relay.mjs');

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

describe('xcuitest/signal-relay.mjs /textsize', () => {
  it('answers 500 when simctl fails and keeps the relay up', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'relay-'));
    const fake = path.join(dir, 'xcrun');
    writeFileSync(fake, '#!/bin/sh\necho boom >&2\nexit 1\n');
    chmodSync(fake, 0o755);
    const [relayPort, controlPort] = [await freePort(), await freePort()];
    const child = spawn(process.execPath, [relayFile, String(relayPort), String(controlPort), 'http://127.0.0.1:9', path.join(dir, 'relay.log')], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, BW_SIM_UDID: 'none' }, stdio: 'ignore',
    });
    try {
      const base = `http://127.0.0.1:${controlPort}`;
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        up = await fetch(`${base}/mark?name=ready`).then(() => true, async () => { await new Promise((r) => setTimeout(r, 50)); return false; });
      }
      expect(up).toBe(true);
      const bad = await fetch(`${base}/textsize?to=large`);
      expect(bad.status).toBe(500);
      const again = await fetch(`${base}/mark?name=after`);
      expect(again.status).toBe(200);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill('SIGTERM');
    }
  });
});
