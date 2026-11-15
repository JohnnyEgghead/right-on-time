// SPDX-License-Identifier: AGPL-3.0-or-later
// The shared response type (SPECIFICATIONS SD-5, section 7.2): Envelope<T> and Problem as Zod schemas.
import { z } from 'zod';
import { ERROR_CODES, ERROR_STATUS, PROBLEM_TYPE_PREFIX, type ErrorCode } from './errors.ts';

export const LABELS = ['simulated_pilot_data', 'fictional_addresses', 'entered_offline', 'demo_mode'] as const;
export type Label = (typeof LABELS)[number];
export const labelSchema = z.enum(LABELS);

export const ROLES = ['office', 'manager', 'technician'] as const;
export const TOKEN_KINDS = ['inbox', 'live_map', 'reschedule', 'booking', 'email', 'password'] as const;

export const viewerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('staff'), userId: z.string(), role: z.enum(ROLES) }),
  z.object({ kind: z.literal('token'), tokenKind: z.enum(TOKEN_KINDS) }),
  z.object({ kind: z.literal('public') }),
]);

export const contractIdSchema = z.string().regex(/^API-\d+$/);

export const metaSchema = z.object({
  contract: contractIdSchema,
  worldEpoch: z.number().int().nonnegative(),
  demoNow: z.string().min(1), // RFC 9557; Temporal parsing is @bw/time's concern
  viewer: viewerSchema,
  labels: z.array(labelSchema),
});
export type Meta = z.infer<typeof metaSchema>;

export function envelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: metaSchema });
}
export type Envelope<T> = { data: T; meta: Meta };

export const problemFieldSchema = z.object({ field: z.string(), problem: z.string() });

export const problemSchema = z
  .object({
    type: z.string().startsWith(PROBLEM_TYPE_PREFIX),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    code: z.enum(ERROR_CODES),
    fields: z.array(problemFieldSchema).optional(),
    meta: z.object({ contract: z.string(), worldEpoch: z.number().int().nonnegative(), demoNow: z.string() }),
  })
  .loose(); // extension members (by, change, at, currentVersion, ...) are allowed by RFC 9457
export type Problem = z.infer<typeof problemSchema> & { code: ErrorCode };

/** A Problem body is well formed when its type URL names its code and its status is the catalog's. */
export function problemConsistent(p: z.infer<typeof problemSchema>): string | null {
  if (p.type !== `${PROBLEM_TYPE_PREFIX}${p.code}`) return `type ${p.type} does not name code ${p.code}`;
  // UI-SPECIFICATION 4.3 defines server_error as any 5xx: the health check's 503 (SPECIFICATIONS 7.4) is one (F-128, F-215).
  if (p.code === 'server_error' ? p.status < 500 || p.status > 599 : p.status !== ERROR_STATUS[p.code]) return `status ${p.status} is not the catalog status ${ERROR_STATUS[p.code]} for ${p.code}`;
  return null;
}
