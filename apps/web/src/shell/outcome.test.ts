// SPDX-License-Identifier: AGPL-3.0-or-later
import { ERROR_STATUS } from '@bw/api';
import { describe, expect, it } from 'vitest';
import { pageOutcome } from './outcome.ts';

describe('page outcome of a Problem (UI-SPECIFICATION 4.2)', () => {
  // why: F-129 SCR-SHR-01 is keyed on the error code forbidden, not on HTTP 403
  it('shows No access for the code forbidden only, never for another code that shares 403', () => {
    expect(pageOutcome({ code: 'forbidden', status: 403 })).toBe('no-access');
    const shares403 = Object.entries(ERROR_STATUS).filter(([, s]) => s === 403).map(([c]) => c);
    expect(shares403.sort()).toEqual(['access_code_required', 'account_turned_off', 'code_invalid', 'demo_mode_off', 'forbidden']);
    for (const code of shares403.filter((c) => c !== 'forbidden')) expect(pageOutcome({ code, status: 403 }), code).not.toBe('no-access');
    expect(pageOutcome({ status: 403 })).toBe('region-error');
  });

  // why: F-129 access_code_required shows the Code needed state (SCR-GATE-01), not SCR-SHR-01
  it('shows Code needed for access_code_required', () => {
    expect(pageOutcome({ code: 'access_code_required', status: 403 })).toBe('code-needed');
  });

  // why: F-129 every outcome is read from the code; a body-less 5xx is still the server's failure
  it('maps not found, signed out and server failures to their pages', () => {
    expect(pageOutcome({ code: 'not_found', status: 404 })).toBe('not-found');
    expect(pageOutcome({ code: 'gone', status: 410 })).toBe('not-found');
    expect(pageOutcome({ code: 'unauthenticated', status: 401 })).toBe('signed-out');
    expect(pageOutcome({ code: 'server_error', status: 500 })).toBe('failed');
    expect(pageOutcome({ status: 502 })).toBe('failed');
    expect(pageOutcome({ code: 'version_conflict', status: 409 })).toBe('region-error');
  });
});
