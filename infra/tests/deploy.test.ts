// SPDX-License-Identifier: AGPL-3.0-or-later
// Static checks of infra/deploy/deploy.sh. The live proof is the deploy logs in
// .build/evidence/P1-DEPLOY; these tests keep a later edit from bringing back the fault of F-94 (a root-owned stage left on the server, which stopped the next deploy) or adding a shell syntax error.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const script = path.join(root, 'infra/deploy/deploy.sh');
const lines = readFileSync(script, 'utf8').split('\n');
const code = lines.map((l) => l.replace(/^\s*#.*$/, ''));
const lineOf = (re: RegExp) => code.findIndex((l) => re.test(l));

describe('infra/deploy/deploy.sh', () => {
  // why: F-94 - an edit of deploy.sh that does not parse stops every deploy, as the fault of F-94 did
  it('parses as bash', () => {
    expect(() => execFileSync('bash', ['-n', script])).not.toThrow();
  });

  // why: F-94
  it('removes the root-owned server stage as root, before the copy and after the run, never hiding a failure', () => {
    // server-deploy.sh makes the stage root-owned; that is why the removal needs sudo.
    expect(readFileSync(path.join(root, 'infra/deploy/server-deploy.sh'), 'utf8')).toMatch(/^chown -R root:root "\$STAGE"$/m);
    const removals = code.flatMap((l, i) => (/rm -rf \$REMOTE_STAGE/.test(l) ? [i] : []));
    expect(removals).toHaveLength(2);
    for (const i of removals) {
      expect(code[i]).toContain('ssh_ "sudo rm -rf $REMOTE_STAGE"');
      expect(code[i]).not.toMatch(/\|\|\s*true/);
      expect(code[i]).toMatch(/^\s*if ! ssh_/);
    }
    const [opening, closing] = removals as [number, number];
    const copy = lineOf(/^scp .*"\$HOST:\/tmp\/"/);
    const run = lineOf(/ssh_ "sudo bash \$REMOTE_STAGE\/server-deploy\.sh/);
    expect(opening).toBeLessThan(copy);
    expect(closing).toBeGreaterThan(run);
    // The opening removal stops the run (scp would merge into an old stage); the closing one warns.
    expect(code[opening]).toMatch(/log "STOP: .*exit 1; fi$/);
    expect(code.slice(closing, closing + 4).join('\n')).toMatch(/log "WARN: could not remove the stage/);
    // The warning reaches every last line of the log, so it cannot sit unseen above DEPLOY OK.
    for (const word of ['DRILL PASS', 'DRILL FAIL', 'DEPLOY OK', 'DEPLOY FAILED']) {
      expect(code.find((l) => l.includes(`log "${word}`))).toContain('$stage_note"');
    }
  });
});
