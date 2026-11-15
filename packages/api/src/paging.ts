// SPDX-License-Identifier: AGPL-3.0-or-later
// Paging (SPECIFICATIONS section 7.1): cursor lists and the 2 page-numbered lists (API-133, API-149).
import { z } from 'zod';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const PAGE_SIZE = 50;

/** Request side of a cursor list. `cursor` is opaque to callers. */
export const cursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

/** The answer of a cursor list: its items under the row's list key (default `items`) and `next`. */
export function cursorPage<T extends z.ZodType, K extends string = 'items'>(item: T, key: K = 'items' as K) {
  return z.object({ [key]: z.array(item), next: z.string().nullable() } as { [P in K]: z.ZodArray<T> } & { next: z.ZodNullable<z.ZodString> });
}

export const pageQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1) });

/**
 * The answer of a page-numbered list: its items under the row's list key and `pages`. The 2 numbered lists name their
 * key in UI-SPECIFICATION 12.2: API-133 `rows`, API-149 `users` (NUMBERED_LIST_KEYS); the default is `items`.
 */
export function numberedPage<T extends z.ZodType, K extends string = 'items'>(item: T, key: K = 'items' as K) {
  return z.object({ [key]: z.array(item), pages: z.number().int().min(0) } as { [P in K]: z.ZodArray<T> } & { pages: z.ZodNumber });
}

/** The list key of each page-numbered list (UI-SPECIFICATION 12.2 Response cells). */
export const NUMBERED_LIST_KEYS = { 'API-133': 'rows', 'API-149': 'users' } as const;

/** Cursor: opaque base64url of the sort key and id. */
export function encodeCursor(sortKey: string, id: string): string {
  return Buffer.from(JSON.stringify([sortKey, id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { sortKey: string; id: string } | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') return { sortKey: v[0], id: v[1] };
  } catch {
    // fall through: a malformed cursor is a validation_failed for the caller
  }
  return null;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}
