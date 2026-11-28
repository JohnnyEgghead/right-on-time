// SPDX-License-Identifier: AGPL-3.0-or-later
// F-2066: the Job screen's photo Thumb holds its object URL the way FinishScreen's does (K-08.23). There is no DOM here, so react's
// hooks are stood in for: useState answers its first value and useEffect runs its callback at once and keeps the cleanup it returns.
import { afterEach, describe, expect, it, vi } from 'vitest';

const cleanups: Array<() => void> = [];
let land: (b: Blob) => void = () => undefined;

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (first: unknown) => [typeof first === 'function' ? (first as () => unknown)() : first, vi.fn()],
  useEffect: (run: () => unknown) => {
    const cleanup = run();
    if (typeof cleanup === 'function') cleanups.push(cleanup as () => void);
  },
  useRef: (first: unknown) => ({ current: first }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }), notFound: () => undefined }));
vi.mock('../useOutbox.ts', () => ({
  techOutbox: () => ({ blob: () => new Promise<Blob>((resolve) => (land = resolve)) }),
  useOwnOutbox: () => undefined,
}));

const { Thumb } = await import('./JobScreen.tsx');

afterEach(() => vi.restoreAllMocks());

describe('the Job screen photo thumbnail (F-2066)', () => {
  // why: F-2066 a photo blob that lands after the Job screen closed left its object URL unrevoked, the leak K-08.23 fixed in FinishScreen
  it('revokes a blob that lands after the cleanup at once', async () => {
    const revoked: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test/late');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u));
    Thumb({ p: { key: 'k1', waiting: true } as never, className: 'x', alt: '' });
    expect(cleanups).toHaveLength(1);
    cleanups[0]!();
    land(new Blob(['x']));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revoked).toEqual(['blob:test/late']);
  });
});
