// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1786: the time of the last try for a native error box (CTL-CMP-12-01, UI-SPECIFICATION.md:446), as the web's TechErrorPanel draws it
// (F-1777). The box is on the screen while `failed` holds; the time is the device clock when it first failed, and again each time `key`
// changes while it still fails (a Try again press that fails again), in the day's zone. Nothing is kept once the read works.
import { formatTime, realNow, Temporal } from '@bw/time';
import { useRef } from 'react';
import { useIntl } from 'react-intl';

export function useLastTry(failed: boolean, key: unknown, zone = 'America/New_York'): string | undefined {
  const { locale } = useIntl();
  const at = useRef<{ key: unknown; ms: number } | null>(null);
  if (!failed) {
    at.current = null;
    return undefined;
  }
  // 'device_stamp' is the use that names the phone's own clock (assumption, as for the web panels in F-1777).
  if (at.current === null || at.current.key !== key) at.current = { key, ms: realNow('device_stamp').epochMilliseconds };
  return formatTime(Temporal.Instant.fromEpochMilliseconds(at.current.ms), zone, locale === 'es' ? 'es' : 'en');
}
