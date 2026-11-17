// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling (checks ci/page-inventory.ts against UI-SPECIFICATION section 2.3, BUILD_PLAN D-9; no product requirement)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build, compare, parseSpec, type Inventory } from './page-inventory.ts';

const root = path.resolve(import.meta.dirname, '..');
// F-1852: docs/UI-SPECIFICATION.md is a private path (scripts/private-paths.txt), so a public copy has none and every test here skips
// with a note naming it; in the private checkout the file is there and every test runs.
const SPEC_FILE = path.join(root, 'docs', 'UI-SPECIFICATION.md');
const noSpec = existsSync(SPEC_FILE) ? '' : 'docs/UI-SPECIFICATION.md is not in this copy (a private path the public export leaves out)';
const specText = noSpec ? '' : readFileSync(SPEC_FILE, 'utf8');
const spec = noSpec ? [] : parseSpec(specText);
beforeEach((ctx) => {
  if (noSpec) ctx.skip(noSpec);
});

describe('page inventory', () => {
  it('section 2.3 holds 81 screens and SCR-CUS-07 has 5 routes', () => {
    // why: tooling
    expect(spec).toHaveLength(81);
    const inv = build(spec);
    expect(inv.routes.map((r) => r.route)).toEqual(['/book/heating', '/book/cooling', '/book/plumbing', '/book/comfort-club', '/book/about-us']);
  });

  it('the committed manifest is set-equal to section 2.3', () => {
    // why: tooling
    const inv = JSON.parse(readFileSync(path.join(root, 'acceptance', 'page-inventory.json'), 'utf8')) as Inventory;
    expect(compare(spec, inv)).toEqual([]);
  });

  it('every row carries a building task and the phase that task names', () => {
    // why: tooling
    for (const s of build(spec).screens) {
      expect(s.task).toMatch(/^P\d+-/);
      expect(s.phase).toBe(Number(/^P(\d+)/.exec(s.task)![1]));
    }
  });

  it('fails on a planted extra row and on a planted missing row', () => {
    // why: tooling
    const inv = build(spec);
    const extra: Inventory = { ...inv, screens: [...inv.screens, { ...inv.screens[0]!, screen: 'SCR-ZZZ-99' }] };
    expect(compare(spec, extra)).toEqual(['extra in the manifest: SCR-ZZZ-99']);
    const missing: Inventory = { ...inv, screens: inv.screens.filter((s) => s.screen !== 'SCR-OFC-05') };
    expect(compare(spec, missing)).toEqual(['missing from the manifest: SCR-OFC-05']);
  });

  it('fails on a planted extra route and a planted missing route of SCR-CUS-07', () => {
    // why: tooling
    const inv = build(spec);
    const extra: Inventory = { ...inv, routes: [...inv.routes, { ...inv.routes[0]!, route: '/book/roofing' }] };
    expect(compare(spec, extra)).toEqual(['extra SCR-CUS-07 route: /book/roofing']);
    const missing: Inventory = { ...inv, routes: inv.routes.slice(1) };
    expect(compare(spec, missing)).toEqual(['missing SCR-CUS-07 route: /book/heating']);
  });
});

describe('deep compare against the rebuilt manifest', () => {
  it('fails on a hand edit of any field of any row', () => {
    // why: tooling
    const inv = build(spec);
    const edit = (f: (i: Inventory) => void) => {
      const c = structuredClone(inv);
      f(c);
      return compare(spec, c);
    };
    expect(edit((i) => { i.screens[3]!.task = 'P5-INBOX'; i.screens[3]!.phase = 5; })).toHaveLength(1);
    expect(edit((i) => { i.screens[3]!.phase = i.screens[3]!.phase + 1; })).not.toEqual([]);
    expect(edit((i) => { i.screens[3]!.name = 'Renamed'; })).not.toEqual([]);
    expect(edit((i) => { i.screens[3]!.type = 'x'; })).not.toEqual([]);
    expect(edit((i) => { i.screens[3]!.route = '/x'; })).not.toEqual([]);
    expect(edit((i) => { i.routes[1]!.task = 'P5-INBOX'; })).not.toEqual([]);
  });
});

describe('node ci/page-inventory.ts check', () => {
  let tmp: string;
  const check = () =>
    spawnSync('node', [path.join(root, 'ci', 'page-inventory.ts'), 'check'], {
      // Hermetic (F-29, F-31): drop every CI_* and INVENTORY_* variable the caller exported (the script reads CI_ROOT
      // and INVENTORY_SPEC ahead of its defaults), then set the one this test means.
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CI|INVENTORY)_/.test(k))),
        INVENTORY_JSON: path.join(tmp, 'inv.json'),
      },
      encoding: 'utf8',
    });
  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'inventory-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('exits 0 on the good manifest and 1 on a manifest with a row dropped', () => {
    // why: tooling
    const inv = build(spec);
    writeFileSync(path.join(tmp, 'inv.json'), JSON.stringify(inv));
    expect(check().status).toBe(0);
    writeFileSync(path.join(tmp, 'inv.json'), JSON.stringify({ ...inv, screens: inv.screens.slice(1) }));
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('missing from the manifest: SCR-GATE-01');
  });

  it('is not redirected by an exported CI_ROOT or INVENTORY_SPEC', () => {
    // reason: F-31; the test used to spread the caller's whole environment, so an exported CI_ROOT turned it red
    const inv = build(spec);
    writeFileSync(path.join(tmp, 'inv.json'), JSON.stringify(inv));
    const saved = [process.env.CI_ROOT, process.env.INVENTORY_SPEC];
    process.env.CI_ROOT = '/nonexistent';
    process.env.INVENTORY_SPEC = '/nonexistent/spec.md';
    try {
      expect(check().status).toBe(0);
    } finally {
      for (const [k, v] of [['CI_ROOT', saved[0]], ['INVENTORY_SPEC', saved[1]]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
