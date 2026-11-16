// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1625 (FR-DIST-3): the real appInfoHandler, called with SOURCE_REPO_URL set, builds the source link from it; no database is needed.
import { describe, expect, it } from 'vitest';
import { appInfoHandler } from './auth.ts';

type Args = Parameters<typeof appInfoHandler>;
const ask = async (settings: Record<string, unknown>): Promise<{ sourceUrl: string; sourceCommit: string }> => {
  const ctx = { settings: { DEMO_MODE: true, ACCESS_CODE_ON: false, ...settings } } as unknown as Args[2];
  const out = await appInfoHandler({} as Args[0], {} as Args[1], ctx);
  if (!out.ok) throw new Error('app info refused');
  return out.data as { sourceUrl: string; sourceCommit: string };
};

describe('appInfoHandler source link (F-1625)', () => {
  // why: FR-DIST-3 changing SOURCE_REPO_URL changes the link, and a trailing slash does not double up
  it('links the repo SOURCE_REPO_URL names at the release commit, with a trailing slash dropped', async () => {
    expect(await ask({ SOURCE_REPO_URL: 'https://example.org/own/repo/', PUBLIC_COMMIT: 'abc1234' })).toMatchObject({ sourceUrl: 'https://example.org/own/repo/commit/abc1234', sourceCommit: 'abc1234' });
    expect(await ask({ SOURCE_REPO_URL: 'https://example.org/own/repo', PUBLIC_COMMIT: 'abc1234' })).toMatchObject({ sourceUrl: 'https://example.org/own/repo/commit/abc1234' });
  });

  // why: FR-DIST-3 a developer build (commit unknown) links the repo itself
  it('links the repo alone when the commit is unknown', async () => {
    expect(await ask({ SOURCE_REPO_URL: 'https://example.org/own/repo/' })).toMatchObject({ sourceUrl: 'https://example.org/own/repo', sourceCommit: 'unknown' });
  });
});
