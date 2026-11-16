// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1679 (Directions opened from a later job said Next stop, which that job is not)
import { createBwIntl, type MessageKey } from '@bw/i18n';
import { describe, expect, it } from 'vitest';

const ADDRESS = '412 Oak St';

describe('the words Directions shows for its destination, from any job (F-1679)', () => {
  // why: F-1679 the destination label of TechDirectionsScreen (CTL-TEC-08-02, its 2 places) reads Destination or Destino, never Next stop, as the job's own Directions button means its own job
  it.each([['en', 'Destination', 'Next stop'], ['es', 'Destino', 'Siguiente parada']] as const)('%s: the label reads %s and never %s', (lang, word, banned) => {
    const t = (key: MessageKey, values?: Record<string, string>) => createBwIntl(lang).formatMessage({ id: key }, values);
    expect(t('tech.dir.next')).toBe(word);
    expect(t('tech.dir.needSignal', { address: ADDRESS })).toContain(ADDRESS);
    expect(t('tech.dir.needSignal', { address: ADDRESS })).not.toContain(banned);
    expect(t('tech.dir.needSignal', { address: ADDRESS }).toLowerCase()).not.toContain('next stop');
  });
});
