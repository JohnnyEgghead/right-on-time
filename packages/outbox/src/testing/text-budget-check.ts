// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI8 (inv8-one-message): text-budget-check over the 5 REAL templates x both languages x every REAL slot value
// (SPECIFICATIONS section 6.4, SD-17), after the must-fail arms (@bw/sms runCli). `--require-templates` makes an empty
// template set exit 2 (F-162 item 1). Run: node packages/outbox/src/testing/text-budget-check.ts --require-templates
import { runCli } from '@bw/sms/src/cli.ts';
import { catalogs } from '../../../i18n/src/catalog.ts';
import { realSlotValues } from './real-slots.ts';

const host = process.env.TEXT_LINK_HOST ?? 'bw.j7l.io';
const r = runCli(catalogs.en, catalogs.es, { requireTemplates: process.argv.includes('--require-templates'), slots: realSlotValues(catalogs, host) });
console.log(r.lines.join('\n'));
process.exit(r.exit);
