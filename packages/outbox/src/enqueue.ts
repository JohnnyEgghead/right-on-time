// SPDX-License-Identifier: AGPL-3.0-or-later
// enqueueText (SPECIFICATIONS section 5.2 steps 1 and 2, SD-18): every text is created here, in the transaction of its
// cause (booking, reminder event, On my way, late sweep, reply, office send). It writes the outbox row and the text.try
// event of try 1 and nothing else; the text leaves only through the worker's try handler and the gateway.
import type { Queryable } from '@bw/db';
import type { Instant } from '@bw/time';
import { scheduleTry } from './events.ts';
import { REASON, type TemplateId, type TemplateKind } from './model.ts';
import { publishTextChanged } from './notify.ts';
import { inQuietHours, releaseTime } from './quiet-hours.ts';
import { countBody, renderTemplate, type CountedBody, type TextCatalog, type TextLanguage } from './render.ts';

interface Common {
  customerId: string;
  /** Null only for an office text about no visit (FR-TEXT-20). */
  jobNumber: number | null;
  /** Demo now: the row's created_at. */
  now: Instant;
  /** The cause's time (FR-TEXT-1: a confirmation is due at once); default `now`. */
  dueAt?: Instant;
  /** The live map or reschedule token the text carries (FR-TEXT-3, FR-TEXT-8). */
  linkToken?: string | null;
}

export type EnqueueInput = Common &
  (
    /** `template`: a variant of the kind's template (F-650: `reminder_today`); default the kind's own. */
    | { kind: TemplateKind; template?: TemplateId; values: Record<string, string>; catalog: TextCatalog }
    | { kind: 'office'; body: string; sentBy: string }
  );

export type EnqueueResult =
  | { ok: true; textId: string; status: 'queued' | 'held'; dueAt: Instant; heldUntil: Instant | null }
  /** No text row: texts off or no mobile (the call list rule of section 6.4 applies; the cause decides), or an office body over 1 message. */
  | { ok: false; reason: 'texts_off' | 'no_mobile' | 'message_too_long' };

interface CustomerRow {
  branch_id: string;
  texts_on: boolean;
  mobile: string | null;
  text_language: TextLanguage;
  zone: string;
}

export async function enqueueText(tx: Queryable, input: EnqueueInput): Promise<EnqueueResult> {
  const { rows } = await tx.query<CustomerRow>(
    `SELECT branch_id, texts_on, mobile, text_language, zone FROM world.customer WHERE id = $1`,
    [input.customerId],
  );
  const c = rows[0];
  if (!c) throw new Error(`enqueueText: no customer ${input.customerId}`);
  if (!c.texts_on) return { ok: false, reason: 'texts_off' };
  if (!c.mobile) return { ok: false, reason: 'no_mobile' };

  let counted: CountedBody;
  let sentBy: string | null = null;
  if (input.kind === 'office') {
    counted = countBody(input.body);
    if (counted.messages !== 1) return { ok: false, reason: 'message_too_long' };
    sentBy = input.sentBy;
  } else {
    counted = renderTemplate(input.catalog, input.template ?? input.kind, c.text_language, input.values);
  }

  const dueAt = input.dueAt ?? input.now;
  const held = inQuietHours(dueAt, c.zone, input.kind);
  const firstTry = releaseTime(dueAt, c.zone, input.kind);
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO world.outbox_text
       (customer_id, job_number, kind, language, encoding, body, characters, status, reason_key,
        held_until, next_try_at, tries, due_at, created_at, sent_by, link_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, $14, $15)
     RETURNING id`,
    [
      input.customerId, input.jobNumber, input.kind, c.text_language, counted.encoding, counted.body, counted.characters,
      held ? 'held' : 'queued', held ? REASON.quietHours : null, held ? firstTry.toString() : null, firstTry.toString(),
      dueAt.toString(), input.now.toString(), sentBy, input.linkToken ?? null,
    ],
  );
  const textId = ins.rows[0]!.id;
  await scheduleTry(tx, firstTry, { textId, number: 1 });
  await publishTextChanged(tx, { textId, customerId: input.customerId, jobNumber: input.jobNumber, branch: c.branch_id });
  return { ok: true, textId, status: held ? 'held' : 'queued', dueAt, heldUntil: held ? firstTry : null };
}
