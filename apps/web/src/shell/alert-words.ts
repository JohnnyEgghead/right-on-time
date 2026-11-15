// SPDX-License-Identifier: AGPL-3.0-or-later
// The words of an office alert, for the bell's list (SCR-OFC-28) and the System health list (SCR-OFC-16): the API rows carry the
// alert's message key (alert.<type>) and its values (ids and numbers, plus the names the server joined), and the page words them from
// the catalog (F-432: the UI catalog holds the list words; the alert emails' words stay in apps/worker/src/alerts/copy.ts so the
// worker image carries no React). Pure: the caller passes its formatter.
import type { MessageKey } from '@bw/i18n';

type T = (key: MessageKey, values?: Record<string, string | number>) => string;

export interface AlertWords {
  type: string;
  messageKey: string;
  messageValues: Record<string, string | number>;
}

/** A value the catalog line needs but the alert did not carry reads as empty, never as a thrown formatter. */
const DEFAULTS: Record<string, string | number> = { customer: '', kind: 'office', jobNumber: '', typicalMs: '', minutes: '' };

/** The alert's sentence: "The confirmation to Linh Pham was not sent after 5 tries. It is on the call list." */
export function alertText(t: T, a: AlertWords): string {
  const values: Record<string, string | number> = { ...DEFAULTS, ...a.messageValues };
  if (typeof values['kind'] === 'string') values['kind'] = t(`health.kind.${values['kind']}` as MessageKey);
  return t(wordsKey(a), values);
}

/**
 * An office text about no visit has no call list row (SPECIFICATIONS 753), so its alert follows the kit 0.9 frame ("The office text to Rosa
 * Castillo was not sent after 5 tries." / "Open the text"); an alert for a text about a visit keeps "It is on the call list." (F-1277).
 */
const noVisitText = (a: AlertWords): boolean => a.type === 'text_gave_up' && a.messageValues['jobNumber'] === undefined;
const wordsKey = (a: AlertWords): MessageKey => (noVisitText(a) ? 'alert.text_gave_up_office' : a.messageKey) as MessageKey;

/** The list's bold title: "Text could not be sent". */
export const alertTitle = (t: T, a: AlertWords): string => t(`${a.messageKey}.title` as MessageKey);

/** The link's name, by its target: "Open the call list". */
export const alertOpenLabel = (t: T, a: AlertWords): string => t(`${noVisitText(a) ? 'alert.text_gave_up_office' : `alert.${a.type}`}.open` as MessageKey);

/** The Alert settings row's name for a type. */
export const alertTypeName = (t: T, type: string): string => t(`alert.${type}.type` as MessageKey);
