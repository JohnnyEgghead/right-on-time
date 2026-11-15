// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1037: the forms a page draws in its first answer (SCR-GATE-01's access code, SCR-TEC-01's and SCR-OFC-01's sign-in, SCR-EML-03's
// Forgot password) are typed into and sent as soon as the page shows, which on a phone can be before React has hydrated it, or while
// it still is. Each of them keeps 2 rules, so the first tap signs in:
//   1. Its fields are uncontrolled: the typed text lives in the field and is read from it, never only from React state. A controlled
//      field lost it on WebKit (F-1037, .build/evidence/W29-F1037/exp1-webkit.txt): text typed while the page hydrated never reached
//      the state, and the next render wrote the state's '' back over it.
//   2. It submits through its action (`<form action={fn}>`), never onSubmit: React's server render then sends its form-replaying
//      script, which holds a submit made before hydration, with the fields as they were at the tap, and runs the action on it once
//      the form is hydrated. With onSubmit, that tap was the browser's own GET submit: the fields in the address, the page reloaded empty.
// The action reads each field from its FormData (fieldText) and first of all keeps what it read as the fields' default values:
// React resets a form after its action, and the reset must give the fields back as they were sent, not empty.

/** The text of the named field in a form action's FormData; '' when it is not there. */
export function fieldText(data: FormData, name: string): string {
  const v = data.get(name);
  return typeof v === 'string' ? v : '';
}
