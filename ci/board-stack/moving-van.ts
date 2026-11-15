// SPDX-License-Identifier: AGPL-3.0-or-later
// F-974: the board stack suite needs a van whose position moves between 2 reads of API-21. It used to wait a fixed 2.5 s between the
// reads; it now repeats the second read every `everyMs` until a van has moved, and gives up at the same `withinMs`, so a parked
// van still ends with undefined (the suite's expect(van).toBeDefined() stays red).
export interface Van {
  technicianId: string;
  status: string;
  position: unknown;
}

export async function movingVanWithin<V extends Van>(
  read: () => Promise<V[]>,
  opts: { withinMs: number; everyMs: number; now?: () => number; wait?: (ms: number) => Promise<void> },
): Promise<V | undefined> {
  const now = opts.now ?? (() => performance.now());
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const first = await read();
  const deadline = now() + opts.withinMs;
  for (;;) {
    const later = await read();
    const moved = later.find((v) => v.status === 'on_the_way' && JSON.stringify(v.position) !== JSON.stringify(first.find((x) => x.technicianId === v.technicianId)?.position));
    if (moved !== undefined || now() >= deadline) return moved;
    await wait(opts.everyMs);
  }
}
