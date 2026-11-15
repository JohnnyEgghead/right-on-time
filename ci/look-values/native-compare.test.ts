// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-IOS-1, FR-IOS-3
// The native look comparator's reading of a dump (native-compare.ts): what UIKit drew and the style Yoga used become the frame's computed
// value strings, each kind compares its own values, and a real difference is reported (the comparator is not vacuous). The browser half
// and the real dumps run in apps/tech-native/xcuitest/run.sh.
import { describe, expect, it } from 'vitest';
import { casesNamed, comparePair, css, KIND_PROPERTIES, NATIVE_CASES, NATIVE_STATES, nativeValues, px, styleColor, type DumpView } from './native-compare.ts';

const okBox: DumpView = {
  native: { width: 354, height: 41.59375, background: [217, 243, 227, 1], borderWidth: 1, borderColor: [31, 157, 85, 1] },
  style: { paddingVertical: 10, paddingHorizontal: 12, rowGap: 9, columnGap: 9, borderRadius: 11 },
};
const frameOkBox = {
  width: '354px', height: '41.5938px', 'background-color': 'rgb(217, 243, 227)', 'background-image': 'none',
  'border-top-width': '1px', 'border-right-width': '1px', 'border-bottom-width': '1px', 'border-left-width': '1px',
  ...Object.fromEntries(['top', 'right', 'bottom', 'left'].flatMap((x) => [[`border-${x}-style`, 'solid'], [`border-${x}-color`, 'rgb(31, 157, 85)']])),
  'padding-top': '10px', 'padding-right': '12px', 'padding-bottom': '10px',
  'padding-left': '12px', 'row-gap': '9px', 'column-gap': '9px',
};

describe('native look values', () => {
  it('prints numbers and colors as Chromium\'s computed values do', () => {
    expect(px(18.899999618530273)).toBe('18.9px');
    expect(px(16.875)).toBe('16.875px');
    expect(css([15.0000001, 94.4, 114.6, 1])).toBe('rgb(15, 94, 115)');
    expect(css(undefined)).toBe('rgba(0, 0, 0, 0)');
    expect(css([0, 0, 0, 0])).toBe('rgba(0, 0, 0, 0)');
    expect(styleColor('#f07a26')).toEqual([240, 122, 38, 1]);
    expect(styleColor('transparent')).toEqual([0, 0, 0, 0]);
  });

  it('reads a box: UIKit size, background and layer border; Yoga padding and gaps; matches the frame\'s .okmsg', () => {
    const v = nativeValues(okBox);
    expect(comparePair({ frame: '.okmsg', native: 'srv.ok', kind: 'box' }, v, frameOkBox, 'ok')).toEqual([]);
  });

  it('reports a box that differs: a wrong background and a missing padding (the comparator is not vacuous)', () => {
    const v = nativeValues({ ...okBox, native: { ...okBox.native, background: [253, 225, 225, 1] }, style: { ...okBox.style, paddingVertical: 0 } });
    const d = comparePair({ frame: '.okmsg', native: 'srv.ok', kind: 'box' }, v, frameOkBox, 'ok');
    expect(d.map((x) => x.property).sort()).toEqual(['background-color', 'padding-bottom', 'padding-top']);
    const noBorder = nativeValues({ ...okBox, native: { ...okBox.native, borderWidth: undefined as never, borderColor: undefined as never } });
    expect(comparePair({ frame: '.okmsg', native: 'srv.ok', kind: 'box' }, noBorder, frameOkBox, 'ok').map((x) => x.property)).toContain('border-left-color');
  });

  it('reads a 1-sided top border drawn as a band child, and counts the band in the padding (the tab bar)', () => {
    const bar: DumpView = { native: { width: 390, height: 82, background: [255, 255, 255, 1] }, style: { paddingTop: 8, paddingHorizontal: 8 } };
    const band: DumpView = { native: { width: 390, height: 1, background: [229, 231, 235, 1] }, style: {} };
    const v = nativeValues(bar, band);
    expect(v).toMatchObject({ 'border-top-width': '1px', 'border-top-color': 'rgb(229, 231, 235)', 'padding-top': '7px', 'border-bottom-width': '0px' });
  });

  it('reads a text face from its font tables: a fallback face fails on family and weight', () => {
    const text: DumpView = {
      native: { width: 132.28, height: 18, font: { size: 15, family: 'Inter', weight: 650, postScript: 'Inter-W650' }, color: [31, 41, 55, 1], minLineHeight: 18 },
      style: {},
    };
    const frame = { 'font-family': '"Inter", system-ui, -apple-system, sans-serif', 'font-size': '15px', 'font-weight': '650', 'line-height': '18px', color: 'rgb(31, 41, 55)', width: '132.281px', height: '18px' };
    expect(comparePair({ frame: 'span', native: 't', kind: 'text' }, nativeValues(text), frame, 't')).toEqual([]);
    const fallback = { ...text, native: { ...text.native, font: { size: 15, family: 'SF Pro', weight: 400, postScript: '.SFUI-Regular' } } };
    expect(comparePair({ frame: 'span', native: 't', kind: 'text' }, nativeValues(fallback), frame, 't').map((d) => d.property)).toEqual(['font-family', 'font-weight']);
  });

  it('skips a width the case marks fill or data, and a height it marks sum, never another value', () => {
    const v = nativeValues({ native: { width: 300, height: 21, font: { size: 15, family: 'Inter', weight: 400, postScript: 'Inter-W400' }, color: [75, 85, 99, 1], minLineHeight: 21 }, style: {} });
    const frame = { 'font-family': 'Inter', 'font-size': '15px', 'font-weight': '400', 'line-height': '21px', color: 'rgb(75, 85, 99)', width: '125.8px', height: '21px' };
    expect(comparePair({ frame: '.v', native: 'v', kind: 'text', data: 'the saved address' }, v, frame, 'v')).toEqual([]);
    expect(comparePair({ frame: '.v', native: 'v', kind: 'text' }, v, frame, 'v').map((d) => d.property)).toEqual(['width']);
    const tall = { ...frame, height: '30px' };
    expect(comparePair({ frame: '.v', native: 'v', kind: 'text', data: 'x', sum: 'children' }, v, tall, 'v')).toEqual([]);
    expect(comparePair({ frame: '.v', native: 'v', kind: 'text', data: 'x' }, v, tall, 'v').map((d) => d.property)).toEqual(['height']);
  });

  it('covers SCR-TEC-12 in each state its frames show, and the tab bar', () => {
    expect(NATIVE_STATES.slice(0, 8)).toEqual(['reachable', 'default', 'checking', 'unreachable', 'not-product', 'not-address', 'saved', 'today']); // later tasks' states follow
    // F-1075: each set pins its states and the whole list is pinned exactly, so a case dropped or renamed fails here, not in a run
    expect([...new Set((casesNamed('mapme') ?? []).map((c) => c.state))]).toEqual(['map', 'parts', 'me']);
    expect(NATIVE_STATES).toEqual([
      'reachable', 'default', 'checking', 'unreachable', 'not-product', 'not-address', 'saved', 'today',
      'map', 'parts', 'me', 'directions',
      'job', 'job-draft', 'note-typing', 'photo-preview', 'photo-none', 'photo-denied', 'finish-editing', 'finish-part', 'finish-signed', 'finish-confirm', 'finish-invalid', 'waiting-offline',
      'today-loading', 'today-offline-saved', 'today-offline-none', 'today-pending', 'today-no-jobs', 'today-all-done', 'today-new-day', 'sheet-omw', 'sheet-arrived', 'sheet-noh',
      'signin', 'signin-busy', 'signin-wrong', 'signin-off', 'signin-waiting', 'forgot', 'forgot-sent', 'forgot-not-available', 'signin-unreachable',
    ]);
    for (const c of NATIVE_CASES) {
      expect(c.pairs.length, c.name).toBeGreaterThan(0);
      for (const p of c.pairs) expect(KIND_PROPERTIES[p.kind].length).toBeGreaterThan(0);
    }
  });

  // why: G-LOOK-PARITY the native job screens (SCR-TEC-04 to -07, -09) are compared in each state their frames show, as their own case set
  it('covers SCR-TEC-04 to -07 and -09 in each state their frames show, and a run can name the job set alone', () => {
    const job = casesNamed('job')!;
    expect([...new Set(job.map((c) => c.state))]).toEqual([
      'job', 'job-draft', 'note-typing', 'photo-preview', 'photo-none', 'photo-denied',
      'finish-editing', 'finish-part', 'finish-signed', 'finish-confirm', 'finish-invalid', 'waiting-offline',
    ]);
    expect(casesNamed('all')).toEqual(NATIVE_CASES);
    expect(casesNamed('nothing')).toBeNull();
    for (const c of job) for (const p of c.pairs) expect(p.native.split('.')[0], c.name).toMatch(/^(job|note|photo|fin|wait)$/);
  });

  // why: G-LOOK-PARITY a dashed border React Native draws itself (the signature pad) is compared by its declared style, a solid one by UIKit's layer
  it('reads a dashed border by the style it was given', () => {
    const pad: DumpView = { native: { width: 366, height: 92, background: [255, 255, 255, 1] }, style: { borderWidth: 1, borderStyle: 'dashed', borderColor: '#d1d5db' } };
    expect(nativeValues(pad)).toMatchObject({ 'border-top-style': 'dashed', 'border-top-width': '1px', 'border-top-color': 'rgb(209, 213, 219)' });
    expect(nativeValues({ ...pad, style: { borderWidth: 1, borderColor: '#d1d5db' } })['border-top-style']).toBe('solid');
  });

  // why: F-1071 the shell's own default run must compare the shell's cases alone, and a mixed run the union, so no run fails for another task's missing dumps
  it('names the shell, mapme, job and today sets and their union, with no case in 2 sets and no unknown name accepted', () => {
    const shell = casesNamed('shell') ?? [];
    const mapme = casesNamed('mapme') ?? [];
    expect(shell.length).toBeGreaterThan(0);
    expect(mapme.length).toBeGreaterThan(0);
    const job = casesNamed('job') ?? [];
    expect(shell.filter((c) => mapme.includes(c) || job.includes(c))).toEqual([]);
    expect(mapme.filter((c) => job.includes(c))).toEqual([]);
    const today = casesNamed('today') ?? [];
    expect(today.length).toBeGreaterThan(0);
    expect(today.filter((c) => shell.includes(c) || mapme.includes(c) || job.includes(c))).toEqual([]);
    expect(new Set(shell.map((c) => c.state)).has('today')).toBe(true);
    expect(shell.some((c) => c.state === 'map')).toBe(false); // the Map state is dumped by MapMeUITests only
    expect(casesNamed('shell,mapme,steps,job,today')).toEqual(NATIVE_CASES);
    expect(casesNamed('shell,mapme')).toEqual([...shell, ...mapme]);
    expect(casesNamed('all')).toEqual(NATIVE_CASES);
    expect(casesNamed('shell,nothing')).toBeNull();
  });

  // why: FR-TECH-5, FR-TECH-3 the StepsUITests run compares SCR-TEC-08 Route and SCR-TEC-04 Success (Photos (3)), the 2 states it dumps; Directions is in no other set
  it('names the steps set: the Directions and job Success cases, the same objects as in the whole list', () => {
    const steps = casesNamed('steps') ?? [];
    expect(steps.map((c) => c.state)).toEqual(['directions', 'job']);
    for (const c of steps) expect(NATIVE_CASES).toContain(c);
    expect((casesNamed('mapme') ?? []).some((c) => c.state === 'directions')).toBe(false);
    const dir = steps[0]!;
    for (const id of ['dir.next', 'dir.steps', 'dir.step.0.now', 'dir.step.arrive', 'dir.fit']) expect(dir.pairs.map((p) => p.native), id).toContain(id);
    expect(steps[1]!.pairs.map((p) => p.native)).toEqual(expect.arrayContaining(['job.phs', 'job.phs.count', 'job.thumb']));
  });
});
