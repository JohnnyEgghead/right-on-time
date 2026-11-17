// SPDX-License-Identifier: AGPL-3.0-or-later
// P3-BACKUP static checks (SPECIFICATIONS sections 4.8 and 11.7): the timers, the deploy wiring, the hosted settings
// and the FR-IMP-6 numbers the restore test compares. The scripts' behavior is proved on a real stack by
// infra/backup/tests/backup.stack.test.ts; these keep a later edit from unwiring them.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTargets } from '../../ci/gates/import-target-counts/targets.ts';

const root = path.resolve(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
// F-1852: docs/build/ and docs/REQUIREMENTS.md are private paths (scripts/private-paths.txt), so in a public copy the tests that
// read them skip with a note naming the path; the private checkout has both and they run.
const absent = (p: string): string => (existsSync(path.join(root, p)) ? '' : `${p} is not in this copy (a private path the public export leaves out)`);
const noHostRecord = absent('docs/build/spikes/G-S5-HOST.md');
const noRequirements = absent('docs/REQUIREMENTS.md');
const unit = (name: string) => {
  const out: Record<string, string> = {};
  for (const l of read(`infra/hosted/systemd/${name}`).split('\n')) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(l);
    if (m) out[m[1] as string] = m[1] === 'OnCalendar' && out.OnCalendar ? `${out.OnCalendar}\n${m[2]}` : (m[2] as string);
  }
  return out;
};
const envFile = (p: string) => Object.fromEntries(read(p).split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const SCRIPTS = ['lib.sh', 'backup.sh', 'restore-test.sh', 'retention.sh', 'hosted-check.sh', 'hosted-check-server.sh'];

const hasSystemdAnalyze = (() => {
  try {
    execFileSync('systemd-analyze', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('the backup timers and units (section 11.7)', () => {
  // why: NFR-07
  it('runs the backup nightly at 2:30 AM and the restore test on Sunday at 4:00 AM, America/New_York', () => {
    expect(unit('brightwater-backup.timer').OnCalendar).toBe('*-*-* 02:30:00 America/New_York\nSun *-03-08..14 03:30:00 America/New_York');
    expect(unit('brightwater-restore-test.timer').OnCalendar).toBe('Sun *-*-* 04:00:00 America/New_York');
    for (const t of ['brightwater-backup.timer', 'brightwater-restore-test.timer']) {
      expect(unit(t).Persistent, t).toBe('true');
      expect(unit(t).WantedBy, t).toBe('timers.target');
    }
  });

  // why: F-489 (the F-389 test must run in the wave container; a missing systemd-analyze there is a failure, not a skip)
  it.runIf(process.env.BW_WAVE_CONTAINER === '1')('the wave container has systemd-analyze, so the F-389 timer test cannot skip', () => {
    expect(hasSystemdAnalyze).toBe(true);
  });

  // why: F-389; F-489 (TZ=UTC: the test reads the local-zone Next elapse line, so it must not depend on the runner zone)
  it.skipIf(!hasSystemdAnalyze)('has a backup elapse on the spring-forward night, Mar 14, 2027, when 02:30 America/New_York does not exist', () => {
    const next = (from: string) => {
      const exprs = unit('brightwater-backup.timer').OnCalendar!.split('\n');
      const out = exprs.map((e) => execFileSync('systemd-analyze', ['calendar', `--base-time=${from}`, e], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }));
      return out.flatMap((o) => [...o.matchAll(/Next elapse: \w{3} (\S+ \S+)/g)].map((m) => m[1]));
    };
    // Base: Sat Mar 13, 2027 12:00 UTC (after the Saturday-night run). The earliest next elapse must be Sun Mar 14.
    expect(next('2027-03-13 12:00:00 UTC').sort()[0]).toBe('2027-03-14 07:30:00');
  });

  // why: NFR-07
  it('each unit is a one-shot that runs its deployed script with the server .env', () => {
    for (const [u, script] of [['brightwater-backup.service', 'backup.sh'], ['brightwater-restore-test.service', 'restore-test.sh']] as const) {
      expect(unit(u)).toMatchObject({ Type: 'oneshot', EnvironmentFile: '/opt/brightwater/.env', ExecStart: `/usr/bin/bash /opt/brightwater/backup/${script}`, Requires: 'docker.service' });
    }
  });
});

describe('the deploy ships the backup (infra/deploy)', () => {
  const deploy = read('infra/deploy/deploy.sh');
  const server = read('infra/deploy/server-deploy.sh');

  // why: NFR-07
  it('stages infra/backup without its local proofs, and the server installs it and enables both timers only when the deploy asks (F-388)', () => {
    expect(deploy).toMatch(/^cp -R infra\/backup "\$stage\/"$/m);
    expect(deploy).toMatch(/^rm -rf "\$stage\/backup\/tests"$/m);
    expect(server).toMatch(/^MANAGED=\(.* systemd backup\)$/m);
    expect(server).toMatch(/^TIMERS=\(brightwater-certbot-renew brightwater-backup brightwater-restore-test\)$/m);
    expect(server).toContain('systemctl enable --now "$t.timer"');
    // The units are installed only after the new release is healthy (step 5), never on a rollback.
    expect(server.indexOf('\n  install_timers\n')).toBeGreaterThan(server.indexOf('if wait_healthy new && confirm_image new'));
    expect(server.indexOf('\n  install_timers\n')).toBeLessThan(server.indexOf('== 6. ROLLBACK'));
  });
});

describe('the hosted settings (sections 4.8 and 11.1)', () => {
  // why: NFR-10, OQ-12
  it('turns backups on to the S5 Lightsail bucket in the server Region, a US Region, with no key', (ctx) => {
    if (noHostRecord) ctx.skip(noHostRecord);
    const hosted = envFile('infra/hosted/hosted.env');
    expect(hosted).toMatchObject({ BACKUP_TARGET: 'lightsail', BACKUP_BUCKET: 'brightwater-backup-use1', BACKUP_REGION: 'us-east-1' });
    expect(read('docs/build/spikes/G-S5-HOST.md')).toMatch(/\| Bucket \| brightwater-backup-use1 .*\| us-east-1 \|/);
    expect(Object.keys(hosted).filter((k) => /KEY|SECRET|TOKEN|PASSWORD/.test(k))).toEqual([]);
    expect(read('infra/backup/lib.sh')).toContain('[[ "$BACKUP_REGION" =~ ^us-(east|west)-[0-9]+$ ]] || die');
  });
});

describe('the restore test compares the FR-IMP-6 targets (section 11.7)', () => {
  // why: NFR-07, FR-IMP-6
  it('import-check.sql holds exactly the numbers of the REQUIREMENTS import target table', (ctx) => {
    if (noRequirements) ctx.skip(noRequirements);
    const t = parseTargets(read('docs/REQUIREMENTS.md'));
    const rows = Object.fromEntries([...read('infra/backup/import-check.sql').matchAll(/\('([^']+)', (\d+), /g)].map((m) => [m[1], Number(m[2])]));
    expect(rows).toEqual({
      'real import runs': 1,
      'customers imported': t.customers.total,
      'customers imported and flagged': t.customers.flagged,
      'service visits imported': t.visits.imported,
      'equipment imported': t.equipment.imported,
      'problem rows': t.problems.total,
      'problem rows: visit with no customer': t.problems.byReason.visit_no_customer,
      'problem rows: missing ZIP code': t.problems.byReason.missing_zip,
      'problem rows: bad phone number': t.problems.byReason.bad_phone,
      'problem rows: visit date not readable': t.problems.byReason.visit_date_unreadable,
      'problem rows: equipment with no address': t.problems.byReason.equipment_no_address,
      'problem rows: customer name blank': t.problems.byReason.customer_name_blank,
      'likely duplicates': t.duplicates.total,
      'likely duplicates: exact': t.duplicates.exact,
      'likely duplicates: listed for the office': t.duplicates.likely,
    });
  });
});

describe('the backup scripts', () => {
  // why: tooling
  it('parse as bash', () => {
    for (const s of SCRIPTS) expect(() => execFileSync('bash', ['-n', path.join(root, 'infra/backup', s)]), s).not.toThrow();
  });
});
