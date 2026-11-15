// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: G-IPHONE-WEB Acceptance (FR-TECH-4, UC-03, NFR-09): the server-side check of the scripted iPhone run passes only when the
// note and the photo reached the server exactly once (a lost note fails the gate), and the staging copy's script and site file hold
// the shape the manager's commands rely on. The rows below are the shape infra/deploy/staging/ledger.sql printed on the local Compose
// stack (docs/build/spikes/G-IPHONE-WEB.md, "Check script proof").
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicIpv4Lines } from '../../ci/public-files.ts';
import { judge, ledgerLine, parseLedger, type Ledger, type LedgerItem } from '../deploy/staging/ledger-check.ts';

const root = path.resolve(import.meta.dirname, '../..');
const JOB = 24830;

let n = 0;
function item(kind: string, over: Partial<LedgerItem> = {}): LedgerItem {
  n += 1;
  return {
    key: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, kind, jobNumber: JOB, result: 'applied', technician: 'Maria Santos',
    deviceTimeReal: '2026-11-08T20:00:00Z', receivedAtDemo: '2026-09-15T14:00:00Z',
    noteRows: kind === 'note' ? 1 : 0, noteOffline: kind === 'note' ? true : null, noteText: kind === 'note' ? 'Basement test note' : null,
    photoRows: kind === 'photo' ? 1 : 0, photoBytes: kind === 'photo' ? 812 : null, ...over,
  };
}
const clean = (): Ledger => ({ jobs: [JOB], items: ['on_my_way', 'arrived', 'note', 'photo', 'finished'].map((k) => item(k)) });
const without = (l: Ledger, kind: string): Ledger => ({ ...l, items: l.items.filter((i) => i.kind !== kind) });

function cli(input: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [path.join(root, 'infra/deploy/staging/ledger-check.ts')], { input, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('ledger-check: the server ledger of the scripted iPhone run', () => {
  // why: G-IPHONE-WEB Acceptance a clean run (each of the 5 items once, applied; the note judged entered offline) passes and exits 0
  it('passes a clean run and prints 1 ledger line per row', () => {
    const v = judge(clean());
    expect(v.failures).toEqual([]);
    expect(v.pass).toBe(true);
    expect(v.lines.filter((l) => l.startsWith('ledger line: '))).toHaveLength(5);
    const r = cli(JSON.stringify(clean()));
    expect([r.status, r.out.trim().split('\n').at(-1)]).toEqual([0, 'LEDGER CHECK PASS']);
  });

  // why: G-IPHONE-WEB Acceptance "a lost note fails the gate": a planted lost note (no ledger row) fails and exits 1
  it('fails a lost note', () => {
    const v = judge(without(clean(), 'note'));
    expect(v.failures).toEqual(['the note: LOST (no ledger row)']);
    const r = cli(JSON.stringify(without(clean(), 'note')));
    expect(r.status).toBe(1);
    expect(r.out).toContain('FAIL the note: LOST (no ledger row)');
  });

  // why: FR-TECH-4, F-1051 an item sent by another technician is not the owner run's: it fails, and so does a note with other words; the note's text is printed
  it('fails an item sent by another technician and a note whose text is not the script\'s, and prints the note text', () => {
    const other = clean();
    other.items = other.items.map((i) => (i.kind === 'photo' ? { ...i, technician: 'Kevin Doyle' } : i));
    expect(judge(other).failures).toEqual(['the photo: sent by Kevin Doyle, not Maria Santos']);
    const wrongText = clean();
    wrongText.items = wrongText.items.map((i) => (i.kind === 'note' ? { ...i, noteText: 'x' } : i));
    expect(judge(wrongText).failures).toEqual(['the note: the note text is "x", not "Basement test note"']);
    expect(ledgerLine(clean().items[2] as LedgerItem)).toContain('text "Basement test note"');
    const nullSender = clean();
    nullSender.items = nullSender.items.map((i) => (i.kind === 'arrived' ? { ...i, technician: null } : i));
    expect(judge(nullSender).failures).toEqual(['Arrived: sent by unknown, not Maria Santos']);
  });

  // why: FR-TECH-4 a note whose ledger row exists but whose note row is missing never reached the job: it is lost too
  it('fails a note with a ledger row but no note row', () => {
    const l = clean();
    l.items = l.items.map((i) => (i.kind === 'note' ? { ...i, noteRows: 0, noteOffline: null } : i));
    expect(judge(l).failures).toEqual([expect.stringContaining('the note: LOST: no note row under its key')]);
  });

  // why: G-IPHONE-WEB Acceptance a lost photo fails the gate like a lost note
  it('fails a lost photo, and a photo whose photo row is missing', () => {
    expect(judge(without(clean(), 'photo')).failures).toEqual(['the photo: LOST (no ledger row)']);
    const l = clean();
    l.items = l.items.map((i) => (i.kind === 'photo' ? { ...i, photoRows: 0 } : i));
    expect(judge(l).failures).toEqual([expect.stringContaining('the photo: LOST: no photo row under its key')]);
  });

  // why: FR-TECH-4 exactly once: a note or photo that reached the server under 2 keys (sent twice after the reopen) fails
  it('fails a note or a photo that arrived twice', () => {
    const twiceNote = clean();
    twiceNote.items.push(item('note'));
    expect(judge(twiceNote).failures).toEqual([expect.stringMatching(/^the note: ARRIVED 2 TIMES \(2 keys: /)]);
    const twicePhoto = clean();
    twicePhoto.items.push(item('photo'));
    expect(judge(twicePhoto).failures).toEqual([expect.stringMatching(/^the photo: ARRIVED 2 TIMES/)]);
    expect(cli(JSON.stringify(twiceNote)).status).toBe(1);
  });

  // why: FR-DEMO-9 the server's own real-time judgement says whether the note waited on the phone: one sent before the signal went off fails
  it('fails a note the server did not judge entered offline', () => {
    const l = clean();
    l.items = l.items.map((i) => (i.kind === 'note' ? { ...i, noteOffline: false } : i));
    expect(judge(l).failures).toEqual([expect.stringContaining('did not judge it entered offline')]);
  });

  // why: G-IPHONE-WEB Description every step logged with its result: a missing On my way, Arrived or Finish job, or one not applied, fails
  it('fails a missing status step and a result other than applied', () => {
    expect(judge(without(clean(), 'finished')).failures).toEqual(['Finish job: LOST (no ledger row)']);
    const l = clean();
    l.items = l.items.map((i) => (i.kind === 'arrived' ? { ...i, result: 'flagged' } : i));
    expect(judge(l).failures).toEqual(['Arrived: answered flagged, not applied']);
  });

  // why: FR-TECH-14 the signature is optional on Finish job: 0 or 1 passes; a step the script has no place for (No one home) fails
  it('allows 1 optional signature and fails an item kind the script never makes', () => {
    const signed = clean();
    signed.items.push(item('signature'));
    expect(judge(signed).pass).toBe(true);
    const noh = clean();
    noh.items.push(item('no_one_home'));
    expect(judge(noh).failures).toEqual(['No one home: 1 ledger rows, and the script has no such step']);
  });

  // why: G-IPHONE-WEB a check against a world without Harold Jenkins's Sep 15 job, or input that is not the ledger, never passes
  it('fails without the job, and exits 2 on input that is not the ledger', () => {
    expect(judge({ jobs: [], items: [] }).pass).toBe(false);
    expect(cli('').status).toBe(2);
    expect(cli('not json\n').status).toBe(2);
    expect(() => parseLedger('{"jobs":1}')).toThrow(/jobs and items/);
    // psql's output: the JSON line among blank lines is read.
    expect(parseLedger(`\n${JSON.stringify(clean())}\n\n`).jobs).toEqual([JOB]);
  });
});

describe('infra/deploy/staging.sh and its site file', () => {
  const script = readFileSync(path.join(root, 'infra/deploy/staging.sh'), 'utf8');
  const site = readFileSync(path.join(root, 'infra/deploy/staging/staging.conf'), 'utf8').replace(/#.*$/gm, '');

  // why: BUILD_PLAN D-12 the staging copy never names or touches the hosted server: no bw.j7l.io address, key or folder in the script
  it('never names the hosted server', () => {
    const code = script.replace(/^\s*#.*$/gm, '');
    for (const s of ['bw.j7l.io', 'brightwater-lightsail.pem', '/opt/brightwater ', '/opt/brightwater/', 'BW_HOST']) {
      expect(code, s).not.toContain(s);
    }
    // F-1609: and no real IPv4 address, whatever it is (the address itself is never written in a test)
    expect(publicIpv4Lines(code)).toEqual([]);
    expect(script).toContain('case "$name" in bw-staging-*) ;;');
  });

  // why: G-IPHONE-WEB the copy is built from the phase 5 tag only: HEAD must be the tag and the shipped files clean
  it('refuses a deploy whose HEAD is not the tag', () => {
    expect(script).toContain('[ "$(git rev-parse HEAD)" = "$commit" ] || {');
    expect(script).toContain('git status --porcelain -- "${shipped[@]}"');
  });

  // why: G-IPHONE-WEB, F-1053, F-1054, F-1055 the script's guards: the folder is resolved after it is made, the seed is read inside the root shell, a failed ledger read is exit 2
  it('resolves the state folder after making it, reads the seed inside the root shell, tests the certificate before rm -rf, and maps a failed read to exit 2', () => {
    const code = script.replace(/^\s*#.*$/gm, '');
    expect(code.indexOf('mkdir -p "$dir"')).toBeLessThan(code.indexOf('real="$(cd "$dir" && pwd -P)"'));
    expect(code.indexOf('real="$(cd "$dir" && pwd -P)"')).toBeLessThan(code.indexOf('if inside_repo "$real"'));
    expect(code).toContain('real="$(cd "$dir" && pwd -P)"');
    expect(code).not.toMatch(/sudo SAMPLE_PASSWORD_SEED=/);
    expect(code).toContain("sudo sh -c 'read -r s; SAMPLE_PASSWORD_SEED=");
    expect(code.indexOf('held=yes')).toBeLessThan(code.indexOf('rm -rf $OPT/infra'));
    expect(code).toContain('|| { echo "staging: no usable ledger');
    expect(code).toContain('docker image rm');
    const temp = readFileSync(path.join(root, 'infra/load/temp-server.sh'), 'utf8').replace(/^\s*#.*$/gm, '');
    expect(temp).not.toMatch(/sudo SAMPLE_PASSWORD_SEED=/);
  });

  // why: G-IPHONE-WEB, F-1053 a state folder inside the repo is refused even when its parent folder does not exist yet, and nothing is written into it
  it('refuses a state folder inside the repo whose parent is missing, in a relative and an absolute form', () => {
    const rel = '.build/evidence/f1053-probe-a/f1053-probe-b';
    const parent = path.join(root, '.build/evidence/f1053-probe-a');
    try {
      for (const d of [rel, path.join(root, rel)]) {
        const r = spawnSync('bash', [path.join(root, 'infra/deploy/staging.sh'), 'status'], { cwd: root, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', BW_STAGING_DIR: d } });
        expect([r.status, r.stderr]).toEqual([2, expect.stringContaining('BW_STAGING_DIR is inside the repo')]);
        expect(existsSync(path.join(parent, 'f1053-probe-b', 'key.pem'))).toBe(false);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  // why: NFR-14 the sample password seed, Maria Santos's password and the office's stay in the state folder: never echoed, never in a command line here
  it('keeps the password out of every printed line', () => {
    const echoes = script.split('\n').filter((l) => /\becho\b/.test(l));
    for (const l of echoes) expect(l, l).not.toMatch(/\$\(cat "\$dir\/(seed|maria-password\.txt|office-password\.txt)"\)/);
    expect(script).toContain('<"$dir/seed" >"$dir/setup.log"');
    expect(script).toMatch(/BW_STAGING_DIR is inside the repo/);
  });

  // why: G-IPHONE-WEB over HTTPS: the site redirects to the name it was asked for (never to the hosted demo) and serves the staging certificate
  it('redirects port 80 to the request host and uses the staging certificate and the open routes include', () => {
    expect(site).toContain('return 301 https://$host$request_uri;');
    expect(site).not.toContain('bw.j7l.io');
    expect(site).toContain('ssl_certificate     /etc/letsencrypt/live/staging/fullchain.pem;');
    expect(site).toContain('include /etc/nginx/bw/http.conf;');
    expect(site).toContain('include /etc/nginx/bw-routes.conf;');
    expect((site.match(/access_log \/var\/log\/nginx\/access\.log bw;/g) ?? []).length).toBe(2);
    expect(script).toContain('echo "ROUTES=open"');
  });
});
