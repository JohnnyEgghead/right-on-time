// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensure, loadPin, platformKey, sha256Hex, verifyArchive } from './install.ts';

describe('gitleaks pin and install', () => {
  // why: NFR-14 gitleaks is pinned to the exact 8.30.1 of SPECIFICATIONS section 3, with a SHA-256 for every platform the scan runs on
  it('pins 8.30.1 with a checksum for this Mac and for the Linux CI image, both architectures', () => {
    const pin = loadPin();
    expect(pin.version).toBe('8.30.1');
    for (const k of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
      expect(pin.assets[k]?.sha256, k).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.assets[k]?.name, k).toContain('8.30.1');
    }
    expect(pin.urlBase).toContain('/releases/download/v8.30.1/');
    expect(platformKey('linux', 'x64')).toBe('linux-x64');
  });

  // why: NFR-14 the installed version is the spec's: the SPECIFICATIONS tool table and the pin agree
  it('the pin equals the version in the SPECIFICATIONS tool table (when the planning docs are present)', () => {
    let spec = '';
    try {
      spec = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'docs', 'SPECIFICATIONS.md'), 'utf8');
    } catch {
      return; // the publish set has no planning files
    }
    expect(spec).toMatch(/\| Secret scanner \| gitleaks \| 8\.30\.1 \|/);
  });

  // why: NFR-14 an archive whose hash is not the pinned one is refused before anything is unpacked
  it('refuses an archive with the wrong checksum and installs nothing', async () => {
    expect(() => verifyArchive(new Uint8Array([1, 2, 3]), 'a'.repeat(64), 'x.tar.gz')).toThrow(/nothing was installed/);
    expect(() => verifyArchive(new Uint8Array([1, 2, 3]), sha256Hex(new Uint8Array([1, 2, 3])), 'x.tar.gz')).not.toThrow();
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-gl-install-'));
    try {
      await expect(ensure({ dir, fetchBytes: async () => new Uint8Array([9, 9, 9]) })).rejects.toThrow(/SHA-256/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // why: NFR-14 a platform with no pinned archive fails by name, never falls back to another or to a copy on PATH
  it('refuses a platform that has no pinned archive', async () => {
    await expect(ensure({ key: 'freebsd-x64' })).rejects.toThrow(/no pinned archive for freebsd-x64/);
  });
});
