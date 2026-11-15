// SPDX-License-Identifier: AGPL-3.0-or-later
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs rule module without types
import rule from './no-inline-strings.mjs';

const linter = new Linter();
const run = (code: string) =>
  linter.verify(
    code,
    [
      {
        files: ['**/*.tsx'],
        languageOptions: { parser: tseslint.parser },
        plugins: { bw: { rules: { 'no-inline-strings': rule } } },
        rules: { 'bw/no-inline-strings': 'error' },
      },
    ],
    'planted.tsx',
  );

describe('no-inline-strings', () => {
  // why: FR-LANG-2
  it('fails a planted JSX text literal', () => {
    const messages = run('export const A = () => <button>Save changes</button>;');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe('bw/no-inline-strings');
  });

  // why: FR-LANG-2
  it('fails a planted string literal in a JSX expression and in a visible attribute', () => {
    expect(run("export const A = () => <p>{'Hello there'}</p>;")).toHaveLength(1);
    expect(run('export const A = () => <input placeholder="Search jobs" />;')).toHaveLength(1);
    expect(run('export const A = () => <img alt={`Map`} />;')).toHaveLength(1);
  });

  // why: FR-LANG-2
  it('passes catalog-driven JSX, punctuation, and non-visible attributes', () => {
    expect(run('export const A = ({ t }: { t: (k: string) => string }) => <p>{t("common.save")}</p>;')).toEqual([]);
    expect(run('export const A = () => <span> / </span>;')).toEqual([]);
    expect(run('export const A = () => <div className="row wide" data-kind="x" />;')).toEqual([]);
  });

  // why: F-135
  it('fails the React Native accessibility props, custom text props, literal branches and literal-bound identifiers', () => {
    expect(run('export const A = () => <View accessibilityLabel="Close dialog" />;')).toHaveLength(1);
    expect(run('export const A = () => <View accessibilityHint={`Closes the dialog`} />;')).toHaveLength(1);
    expect(run('export const A = () => <Banner message="Saved" text="Hello" hint="Try again" />;')).toHaveLength(3);
    expect(run("export const A = ({ ok }: { ok: boolean }) => <p>{ok ? 'Saved' : 'Failed'}</p>;")).toHaveLength(2);
    expect(run("export const A = ({ ok }: { ok: boolean }) => <p>{ok && 'Saved'}</p>;")).toHaveLength(1);
    expect(run("export const A = ({ ok }: { ok: boolean }) => <View accessibilityLabel={ok ? 'Open' : 'Close'} />;")).toHaveLength(2);
    expect(run("const label = 'Save changes'; export const A = () => <p>{label}</p>;")).toHaveLength(1);
  });

  // why: F-135
  it('control: catalog-driven props, branches and identifiers still pass', () => {
    expect(run('export const A = ({ t }: { t: (k: string) => string }) => <View accessibilityLabel={t("common.close")} />;')).toEqual([]);
    expect(run('export const A = ({ ok, t }: { ok: boolean; t: (k: string) => string }) => <p>{ok ? t("a.b") : t("a.c")}</p>;')).toEqual([]);
    expect(run("export const A = ({ ok }: { ok: boolean }) => <p>{ok ? '/' : '|'}</p>;")).toEqual([]);
    expect(run("const key = 'common.save'; export const A = ({ t }: { t: (k: string) => string }) => <p>{t(key)}</p>;")).toEqual([]);
    expect(run('export const A = ({ label }: { label: string }) => <p>{label}</p>;')).toEqual([]);
  });
});
