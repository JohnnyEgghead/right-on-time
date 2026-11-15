// SPDX-License-Identifier: AGPL-3.0-or-later
// Path templates (`/jobs/{jobNumber}`, `/maps/{branch}.pmtiles`) compiled to matchers.

export interface CompiledPath {
  template: string;
  names: string[];
  match(path: string): Record<string, string> | null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compilePath(template: string): CompiledPath {
  if (!template.startsWith('/')) throw new Error(`path template must start with /: ${template}`);
  const names: string[] = [];
  let re = '';
  let last = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    re += escape(template.slice(last, m.index));
    names.push(m[1]!);
    re += '([^/]+)';
    last = m.index + m[0].length;
  }
  re += escape(template.slice(last));
  const rx = new RegExp(`^${re}$`);
  return {
    template,
    names,
    match(path) {
      const m = rx.exec(path);
      if (!m) return null;
      const out: Record<string, string> = {};
      for (const [i, n] of names.entries()) {
        try {
          out[n] = decodeURIComponent(m[i + 1]!);
        } catch {
          return null;
        }
      }
      return out;
    },
  };
}

/** The token path parameter of a link-token route (`...Token` or `token`), or null. */
export function tokenParam(template: string): string | null {
  return /\{(\w*[tT]oken)\}/.exec(template)?.[1] ?? null;
}

/** Order for matching: a template with fewer parameters first, so /office/jobs/new wins over /office/jobs/{jobNumber}. */
export const specificity = (template: string): number => (template.match(/\{\w+\}/g) ?? []).length;
