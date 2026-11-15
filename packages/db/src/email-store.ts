// SPDX-License-Identifier: AGPL-3.0-or-later
// The on-screen email store (SPECIFICATIONS section 3 `email_message`, `email_link`; SD-29; FR-AUTH-8). Every email is a
// row; no mail transport exists. A message opens only by a one-time link: a 32-byte token stored as its SHA-256, valid
// for 1 opening and at most 24 demo hours. Alerts, invites and resets share this store (invites and resets are
// P4-ACCOUNTS's callers). The caller passes demo now as an ISO instant, so this package reads no clock (FR-DEMO-2).
import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from './client.ts';

export const EMAIL_KINDS = ['invite', 'reset', 'alert'] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/** SD-29: a one-time email link lasts at most this many demo hours. */
export const EMAIL_LINK_HOURS = 24;

export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

/** A fresh 32-byte link token, URL-safe. Only its hash is stored. */
export const newToken = (): string => randomBytes(32).toString('base64url');

export interface NewEmail {
  userId: string;
  toAddress: string;
  kind: EmailKind;
  language: 'en' | 'es';
  subject: string;
  body: string;
  /** Demo now, ISO. */
  now: string;
  /** Whom each one-time link is shown to: the person whose action sent it, or each manager of an alert email. */
  shownTo: readonly string[];
}

export interface SentEmail {
  emailId: string;
  /** 1 per `shownTo` entry, in order. The token is shown once, on screen, and never stored. */
  links: { userId: string; token: string; hash: Buffer }[];
}

/** Write 1 message and its one-time links in the caller's transaction. */
export async function sendEmail(tx: Queryable, email: NewEmail): Promise<SentEmail> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO world.email_message (user_id, to_address, kind, language, subject, body, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [email.userId, email.toAddress, email.kind, email.language, email.subject, email.body, email.now],
  );
  const emailId = r.rows[0]!.id;
  const links: SentEmail['links'] = [];
  for (const userId of email.shownTo) {
    const token = newToken();
    const hash = hashToken(token);
    await tx.query(
      `INSERT INTO world.email_link (token_hash, email_id, shown_to_user, expires_at)
       VALUES ($1, $2, $3, $4::timestamptz + make_interval(hours => $5))`,
      [hash, emailId, userId, email.now, EMAIL_LINK_HOURS],
    );
    links.push({ userId, token, hash });
  }
  return { emailId, links };
}

export interface OpenedEmail {
  emailId: string;
  toAddress: string;
  kind: EmailKind;
  language: 'en' | 'es';
  subject: string;
  body: string;
  sentAt: Date;
}

/**
 * Open a message by its link token: the first call returns it, every later call (and an expired, unknown or malformed
 * token) answers null, which API-166 maps to `gone` (410). The spend is 1 conditional UPDATE, so 2 concurrent opens
 * never both succeed.
 */
export async function openEmailLink(tx: Queryable, token: string, now: string): Promise<OpenedEmail | null> {
  const spent = await tx.query<{ email_id: string }>(
    `UPDATE world.email_link SET used_at = $2
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
      RETURNING email_id`,
    [hashToken(token), now],
  );
  const emailId = spent.rows[0]?.email_id;
  if (!emailId) return null;
  const m = await tx.query<{ to_address: string; kind: EmailKind; language: 'en' | 'es'; subject: string; body: string; sent_at: Date }>(
    `SELECT to_address, kind, language, subject, body, sent_at FROM world.email_message WHERE id = $1`,
    [emailId],
  );
  const row = m.rows[0]!;
  return { emailId, toAddress: row.to_address, kind: row.kind, language: row.language, subject: row.subject, body: row.body, sentAt: row.sent_at };
}
