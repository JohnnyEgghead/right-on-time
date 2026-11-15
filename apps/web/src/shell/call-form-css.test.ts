// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-20 (UD-56, F-1192: the server-drawn Call control shows 1 form by the SD-33 phone test, before the page's scripts run)
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PHONE_QUERY } from './keys.ts';

const css = readFileSync(new URL('../../styles/app/shell.css', import.meta.url), 'utf8');
const src = readFileSync(new URL('./CallButton.tsx', import.meta.url), 'utf8');

describe('the Call control before the page\'s scripts run', () => {
  // why: FR-DISP-20
  it('hides the button on a phone and the telephone link everywhere else, by the same query the scripts read', () => {
    expect(css).toContain(`@media ${PHONE_QUERY} { [data-callform='reveal'] { display: none !important; } }`);
    expect(css).toContain(`@media not all and ${PHONE_QUERY} { [data-callform='tel'] { display: none !important; } }`);
  });

  // why: FR-DISP-20
  it('draws both forms on the server and never reads the browser name', () => {
    expect(src).toContain("serverMode = (): DrawnMode => 'both'");
    expect(src).toContain("'data-callform': 'tel'");
    expect(src).toContain("'data-callform': 'reveal'");
    expect(src).not.toMatch(/userAgent|headers\(\)/);
  });
});
