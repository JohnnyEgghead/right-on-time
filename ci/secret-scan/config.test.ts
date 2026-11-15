// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isText, parseSkipped, plantedSecret, sampleSeedShape } from './scan.ts';

const cfg = readFileSync(path.join(import.meta.dirname, 'gitleaks.toml'), 'utf8');
const blocks = cfg.split('[[allowlists]]').slice(1);

describe('secret-scan allowances (F-341, W-43)', () => {
  // why: NFR-14 the default rules stay on and there are exactly 2 allowances, each a rule id plus a path with a written reason
  it('has the default rules on and 2 allowances, each with a reason, a rule id and a path', () => {
    expect(cfg).toMatch(/\[extend\]\s+useDefault = true/);
    expect(blocks).toHaveLength(2);
    for (const b of blocks) {
      expect(b).toMatch(/description = ".{40,}"/);
      expect(b).toMatch(/targetRules = \["generic-api-key"\]/);
      expect(b).toMatch(/paths = \[/);
    }
  });

  // why: NFR-14 the .env.example allowance is the root file only, and no allowance names a secret string
  it('allows .env.example by an anchored root path and never by a string or a stopword', () => {
    expect(blocks[0]).toContain(String.raw`paths = ['''^\.env\.example$''']`);
    expect(blocks[0]).not.toMatch(/regexes|stopwords/);
    expect(cfg).not.toMatch(/stopwords/);
    // the only value pattern is the shape of a UUID, not a literal
    const regexes = [...cfg.matchAll(/^regexes = \[(.*)\]$/gm)].map((m) => m[1]);
    expect(regexes).toHaveLength(1);
    expect(regexes[0]).toContain('[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-');
  });

  // why: NFR-14 planted test values are made at run time, so this repository's own publish set never carries one
  it('makes the planted values fresh each call', () => {
    expect(plantedSecret()).toMatch(/^AKIA[A-Z2-7]{16}$/);
    expect(plantedSecret()).not.toBe(plantedSecret());
    expect(sampleSeedShape()).toHaveLength(32);
  });
});

describe('files the built-in allowlist skips (F-1528)', () => {
  // why: F-1528 the second pass scans exactly the files the trace says were skipped, colored or not, paths with spaces kept whole
  it('reads the skipped paths from a trace, and nothing else', () => {
    const trace = [
      '3:01PM DBG skipping file: global allowlist path=pnpm-lock.yaml',
      '\x1b[90m3:01PM\x1b[0m \x1b[33mDBG\x1b[0m skipping file: global allowlist path=sub/my file.lock',
      '3:01PM TRC scanning path=apps/web/src/main.ts',
      '3:01PM DBG skipping file: rule allowlist path=x.test.ts',
    ].join('\n');
    expect(parseSkipped(trace)).toEqual(['pnpm-lock.yaml', 'sub/my file.lock']);
    expect(parseSkipped('')).toEqual([]);
  });
  // why: F-1528 only text files are scanned again (a NUL byte in the first 8 KB marks a font or an image, which gitleaks cannot read)
  it('tells a text file from a binary one by a NUL byte in the first 8 KB', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'bw-f1528-'));
    try {
      writeFileSync(path.join(d, 'a.yaml'), 'lockfileVersion: 9\n');
      writeFileSync(path.join(d, 'b.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]));
      writeFileSync(path.join(d, 'c.txt'), Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]));
      expect(isText(path.join(d, 'a.yaml'))).toBe(true);
      expect(isText(path.join(d, 'b.woff2'))).toBe(false);
      expect(isText(path.join(d, 'c.txt'))).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
