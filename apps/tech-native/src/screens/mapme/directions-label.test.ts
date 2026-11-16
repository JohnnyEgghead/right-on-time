// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1679 (Directions opened from a later job said Next stop, which that job is not)
import { createBwIntlFrom } from '@bw/i18n/src/provider-core.tsx';
import { describe, expect, it } from 'vitest';
import { nativeCatalogs } from '../../ui/catalog.ts';

const ADDRESS = '412 Oak St';

describe('the words native Directions shows for its destination, from any job (F-1679)', () => {
  // why: F-1679 the no-signal line of DirectionsScreen (dir.need) names the job's own address and never says Next stop, whichever job Directions opened from
  it.each([['en', 'Head to', 'Next stop'], ['es', 'Diríjase a', 'Siguiente parada']] as const)('%s: reads %s the address and never %s', (lang, lead, banned) => {
    const text = createBwIntlFrom(nativeCatalogs, lang).formatMessage({ id: 'tech.dir.needSignal' }, { address: ADDRESS });
    expect(text).toContain(`${lead} ${ADDRESS}`);
    expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
  });
});
