// SPDX-License-Identifier: AGPL-3.0-or-later
// The words of an alert email (FR-AUTH-8: an email is written in its recipient's language, en or es). The alert list's
// own words are the page's (message_key `alert.<type>` in the UI catalog, P4-HEALTH); this is the email's subject and
// body, with `{slot}` placeholders filled from the alert's message_values (ids and numbers only).
import type { AlertType } from '@bw/domain';

export type CopyLanguage = 'en' | 'es';

interface Words {
  subject: string;
  body: string;
}

const COPY: Readonly<Record<AlertType, Record<CopyLanguage, Words>>> = {
  text_gave_up: {
    en: { subject: 'A text could not be sent', body: 'A text gave up after its 5th failed try and is on the call list. Open the alert to reach the call list.' },
    es: { subject: 'No se pudo enviar un mensaje de texto', body: 'Un mensaje de texto se rindió después de su 5.º intento fallido y está en la lista de llamadas. Abra la alerta para ir a la lista de llamadas.' },
  },
  billing_waiting_person: {
    en: { subject: 'A billing item waits for a person', body: 'Job {jobNumber} was refused as a data error and waits for a person on the billing list.' },
    es: { subject: 'Un cobro espera a una persona', body: 'El trabajo {jobNumber} fue rechazado por un error de datos y espera a una persona en la lista de cobros.' },
  },
  billing_retrying_long: {
    en: { subject: 'A billing item has retried for an hour', body: 'Job {jobNumber} has retried for 60 demo minutes and is still on the billing list.' },
    es: { subject: 'Un cobro lleva una hora reintentándose', body: 'El trabajo {jobNumber} lleva 60 minutos de demostración reintentándose y sigue en la lista de cobros.' },
  },
  offline_conflict: {
    en: { subject: 'A phone item needs attention', body: 'An item from a phone was flagged on job {jobNumber}. Open the alert to reach Needs attention on the board.' },
    es: { subject: 'Un elemento del teléfono necesita atención', body: 'Se marcó un elemento de un teléfono en el trabajo {jobNumber}. Abra la alerta para ir a Necesita atención en el tablero.' },
  },
  backup_failed: {
    en: { subject: 'The backup failed', body: 'The last backup failed, or no backup finished in the last 26 hours. Open System health.' },
    es: { subject: 'La copia de seguridad falló', body: 'La última copia de seguridad falló, o ninguna terminó en las últimas 26 horas. Abra Estado del sistema.' },
  },
  restore_test_failed: {
    en: { subject: 'The weekly restore test failed', body: 'The weekly restore test failed. Open System health.' },
    es: { subject: 'La prueba semanal de restauración falló', body: 'La prueba semanal de restauración falló. Abra Estado del sistema.' },
  },
  board_delay_over_goal: {
    en: { subject: 'The board is slow to update', body: 'The typical board delay over the last 60 minutes is {typicalMs} ms, over the 5 second goal.' },
    es: { subject: 'El tablero tarda en actualizarse', body: 'La demora típica del tablero en los últimos 60 minutos es de {typicalMs} ms, por encima de la meta de 5 segundos.' },
  },
  restore_test_passed: {
    en: { subject: 'The restore test passed', body: 'A restore test passed in {minutes} minutes.' },
    es: { subject: 'La prueba de restauración pasó', body: 'Una prueba de restauración pasó en {minutes} minutos.' },
  },
  world_reset: {
    en: { subject: 'The world was reset', body: 'The demo world was reset to its starting state.' },
    es: { subject: 'Se reinició el mundo de demostración', body: 'El mundo de demostración volvió a su estado inicial.' },
  },
  billing_reset_waiting: {
    en: { subject: 'The billing service has not confirmed a reset', body: 'A reset is still unconfirmed by the billing service. Open System health.' },
    es: { subject: 'El servicio de cobros no ha confirmado un reinicio', body: 'Un reinicio sigue sin confirmarse por el servicio de cobros. Abra Estado del sistema.' },
  },
};

/**
 * An office text about no visit has no call list row (SPECIFICATIONS 753), so its email says neither; its alert opens the text log
 * (F-1277). Chosen the way the page chooses its words (apps/web/src/shell/alert-words.ts): a text_gave_up alert with no jobNumber.
 */
const TEXT_GAVE_UP_NO_VISIT: Readonly<Record<CopyLanguage, Words>> = {
  en: { subject: 'A text could not be sent', body: 'An office text gave up after its 5th failed try. Open the alert to reach the text log.' },
  es: { subject: 'No se pudo enviar un mensaje de texto', body: 'Un mensaje de texto de la oficina se rindió después de su 5.º intento fallido. Abra la alerta para ir al registro de mensajes.' },
};

const SLOT = /\{([A-Za-z]+)\}/g;

export function alertEmailWords(type: AlertType, language: CopyLanguage, values: Record<string, string | number>): Words {
  const w = type === 'text_gave_up' && values['jobNumber'] === undefined ? TEXT_GAVE_UP_NO_VISIT[language] : COPY[type][language];
  const fill = (s: string): string => s.replace(SLOT, (_, k: string) => String(values[k] ?? ''));
  return { subject: fill(w.subject), body: fill(w.body) };
}
