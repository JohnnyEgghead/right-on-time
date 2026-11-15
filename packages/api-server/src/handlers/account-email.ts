// SPDX-License-Identifier: AGPL-3.0-or-later
// The words of the invite and reset emails (FR-AUTH-8: an email is written in its recipient's language, en or es; OI-39: an
// invited user's language is the inviting person's). The email is a stored record, shown as written (SCR-EML-01), so its
// words live here with the writer, not in the page catalog. A paragraph that is exactly LINK_SLOT is where the email's
// button stands (API-166 `body`). The invite of a technician carries the employee number (SD-29, OI-26).
export type EmailLanguage = 'en' | 'es';
export type AccountRole = 'office' | 'manager' | 'technician';

export const LINK_SLOT = '{link}';
export const EMAIL_FROM = 'Right On Time <no-reply@brightwater.example>';
const SIGNATURE = 'Brightwater Heating & Air';

const BRANCH_NAMES: Readonly<Record<string, string>> = { columbus: 'Columbus', dayton: 'Dayton', springfield: 'Springfield' };
export const branchName = (id: string): string => BRANCH_NAMES[id] ?? id;
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

const ROLE_WORDS: Readonly<Record<EmailLanguage, Record<AccountRole, string>>> = {
  en: { technician: 'a technician', office: 'office staff', manager: 'a manager' },
  es: { technician: 'técnico', office: 'personal de oficina', manager: 'gerente' },
};

export interface EmailWords {
  subject: string;
  body: string;
}

const paragraphs = (...p: string[]) => p.join('\n\n');

export function inviteEmail(lang: EmailLanguage, o: { name: string; role: AccountRole; branch: string; employeeNumber: string | null }): EmailWords {
  const first = firstName(o.name);
  const where = branchName(o.branch);
  if (lang === 'es') {
    return {
      subject: 'Bienvenido a Right On Time',
      body: paragraphs(
        `Hola ${first}:`,
        `Lo agregaron a Right On Time como ${ROLE_WORDS.es[o.role]} en la sucursal de ${where}. Elija su contraseña con el botón de abajo. El enlace sirve durante 7 días.`,
        ...(o.employeeNumber ? [`Su número de empleado es ${o.employeeNumber}. Puede iniciar sesión en la app de técnicos con ese número o con este correo.`] : []),
        LINK_SLOT,
        SIGNATURE,
      ),
    };
  }
  return {
    subject: 'Welcome to Right On Time',
    body: paragraphs(
      `Hi ${first},`,
      `You were added to Right On Time as ${ROLE_WORDS.en[o.role]} at the ${where} branch. Set your password with the button below. The link works for 7 days.`,
      ...(o.employeeNumber ? [`Your employee number is ${o.employeeNumber}. You can sign in to the technician app with it or with this email address.`] : []),
      LINK_SLOT,
      SIGNATURE,
    ),
  };
}

export function resetEmail(lang: EmailLanguage, o: { name: string }): EmailWords {
  const first = firstName(o.name);
  if (lang === 'es') {
    return {
      subject: 'Elija una contraseña nueva',
      body: paragraphs(
        `Hola ${first}:`,
        'Alguien pidió restablecer la contraseña de su cuenta de Right On Time. Elija una contraseña nueva con el botón de abajo. El enlace sirve durante 60 minutos.',
        LINK_SLOT,
        'Si usted no lo pidió, puede ignorar este correo. Su contraseña no cambia.',
        SIGNATURE,
      ),
    };
  }
  return {
    subject: 'Choose a new password',
    body: paragraphs(
      `Hi ${first},`,
      'Someone asked to reset the password for your Right On Time account. Choose a new password with the button below. The link works for 60 minutes.',
      LINK_SLOT,
      'If you did not ask for this, you can ignore this email. Your password stays the same.',
      SIGNATURE,
    ),
  };
}
