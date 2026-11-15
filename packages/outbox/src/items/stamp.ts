// SPDX-License-Identifier: AGPL-3.0-or-later
// Section 5.1 steps 1 and 2: the clock offset saved at each read of API-10 with signal, and the stamp every item gets at
// entry from that offset and the phone's own real time. The server re-bases each item on its own clock (step 4), so the
// stamp only has to be internally consistent: offsetSavedReal and sinceSaveMs each come from 1 clock.
import { fromWire, Temporal, toWire, type Instant } from '@bw/time';
import type { ClockOffset, ItemStamp } from './model.ts';

const DEFAULT_ZONE = 'UTC';

/** The offset from 1 API-10 answer and the phone's own real time when the answer arrived. */
export function offsetFromClock(read: { demoNow: string; realNow: string; worldEpoch: number }, deviceAtRead: Instant): ClockOffset {
  // API-10's realNow field: the server's real time at the read, a value of the answer and no reading of any clock here (the realNow
  // listing, ci/gates/G-CI4/realnow-sites.ts, passes a destructured field read: F-939).
  const { demoNow, realNow: serverReal } = read;
  const demo = fromWire(demoNow);
  return {
    demoMinusRealMs: demo.epochMilliseconds - deviceAtRead.epochMilliseconds,
    worldEpoch: read.worldEpoch,
    savedServerReal: fromWire(serverReal).toInstant(),
    savedDeviceReal: deviceAtRead,
    zone: demo.timeZoneId,
  };
}

/** The stamp of an item entered at `deviceNow` (the phone's realNow('device_stamp')) under the stored offset. */
export function stampEntry(offset: ClockOffset, deviceNow: Instant, key: string): ItemStamp {
  const zone = offset.zone ?? DEFAULT_ZONE;
  const demo = Temporal.Instant.fromEpochMilliseconds(deviceNow.epochMilliseconds + offset.demoMinusRealMs);
  return {
    key,
    worldEpoch: offset.worldEpoch,
    deviceTime: toWire(deviceNow, zone),
    offsetSavedReal: toWire(offset.savedServerReal, zone),
    sinceSaveMs: deviceNow.epochMilliseconds - offset.savedDeviceReal.epochMilliseconds,
    demoTime: toWire(demo, zone),
    enteredRealMs: deviceNow.epochMilliseconds,
  };
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A fresh item key: a UUID v4 from the platform's cryptographic generator (section 3 Identifiers). */
export function newItemKey(gen: () => string = () => globalThis.crypto.randomUUID()): string {
  const k = gen().toLowerCase();
  if (!UUID_V4.test(k)) throw new Error(`item key is not a UUID v4: ${k}`);
  return k;
}
