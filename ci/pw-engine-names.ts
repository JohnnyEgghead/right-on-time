// SPDX-License-Identifier: AGPL-3.0-or-later
// The engine list rule, with no Playwright import so ci/run-gates.ts can record it in ci-verdict.json (F-47).
// ci/pw-engines.ts re-exports it. See that file for the rule.
export const ALL_ENGINE_NAMES = ['chromium', 'webkit'] as const;

export function resolveEngines(
  narrow: string | undefined,
  why: string | undefined,
): { names: string[]; notice: string | null } {
  if (narrow === undefined || narrow.trim() === '') return { names: [...ALL_ENGINE_NAMES], notice: null };
  const names = narrow.split(',').map((n) => n.trim()).filter((n) => n !== '');
  const unknown = names.filter((n) => !(ALL_ENGINE_NAMES as readonly string[]).includes(n));
  if (unknown.length > 0 || names.length === 0) {
    throw new Error(`BW_PW_ENGINES names an unknown or empty engine list: "${narrow}" (known: ${ALL_ENGINE_NAMES.join(', ')})`);
  }
  const dropped = ALL_ENGINE_NAMES.filter((n) => !names.includes(n));
  if (dropped.length === 0) return { names, notice: null };
  if (!why || why.trim() === '') {
    throw new Error(
      `BW_PW_ENGINES drops ${dropped.join(', ')} from the proof set without a reason: set BW_PW_ENGINES_WHY to say why, or unset BW_PW_ENGINES`,
    );
  }
  return { names, notice: `DROPPED ENGINE ${dropped.join(', ')}: ${why.trim()} (the proof set is NOT complete)` };
}
