// SPDX-License-Identifier: AGPL-3.0-or-later
// Mounting and versioning (SPECIFICATIONS SD-4, section 7.1).
export const API_BASE = '/api/v1';
export const API_VERSIONS = ['v1'] as const;
/** v1 stays served this many days after the native app version that needs v2 is released. */
export const V1_SUNSET_DAYS = 180;

/**
 * Rows served at the origin root, not under the API base (SPECIFICATIONS 7.1): the live map and reschedule routes of
 * SD-17 (a text prints them), the map files nginx serves at /maps/ (API-106) and the health check (section 7.4).
 */
export const ROOT_CONTRACTS: ReadonlySet<string> = new Set(['API-106', 'API-115', 'API-116', 'API-117', 'API-118', 'API-164', 'API-171']);

export function contractNumber(id: string): number {
  const m = /^API-(\d+)$/.exec(id);
  if (!m) throw new Error(`not a contract id: ${id}`);
  return Number(m[1]);
}

/** The served path of a row: its row path under the API base, or at the origin root for the exceptions. */
export function mountedPath(id: string, path: string, version: (typeof API_VERSIONS)[number] = 'v1'): string {
  if (!path.startsWith('/')) throw new Error(`${id}: path must start with /: ${path}`);
  return ROOT_CONTRACTS.has(id) ? path : `/api/${version}${path}`;
}

/** The version a served path belongs to, or null for a root route or a non-API path. */
export function versionOfPath(path: string): string | null {
  const m = /^\/api\/(v\d+)(\/|$)/.exec(path);
  return m ? (m[1] ?? null) : null;
}

/** Expand `{name}` segments of a row path. Values are URL-encoded. */
export function fillPath(path: string, params: Record<string, string | number> = {}): string {
  return path.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`missing path parameter ${k} for ${path}`);
    return encodeURIComponent(String(v));
  });
}
