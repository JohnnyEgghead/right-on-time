// SPDX-License-Identifier: AGPL-3.0-or-later
// The Finish link back to a finish that waits for its signature (owed.ts, today/TodayView.tsx): shown for that job and nobody else.
import type { QueuedItem } from '@bw/outbox/src/items/index.ts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ShellIntl } from '../../shell/intl.tsx';
import { TodayList } from '../today/TodayView.tsx';
import { applyWaiting } from '../today/model.ts';
import { previewState } from '../today/preview-data.ts';
import { owedJobs } from './owed.ts';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

const item = (kind: QueuedItem['kind'], jobNumber: number, extra: Record<string, unknown> = {}) =>
  ({ key: `${kind}-${jobNumber}`, kind, jobNumber, enteredRealMs: 1, baseVersion: 2, userId: 'u', ...extra }) as unknown as QueuedItem;

describe('the jobs that owe a signature', () => {
  // why: F-1985 only a kept finish with no signature waiting and a signature in its kept draft is owed
  it('names the job whose finish waits, whose draft holds a signature and whose signature does not wait', async () => {
    const draft = async (n: number) => n !== 3;
    const waiting = [
      item('finished', 1), // owed
      item('finished', 2), item('signature', 2), // signature already kept
      item('finished', 3), // no signature in the draft
      item('finished', 4, { lastTry: { atRealMs: 1, outcome: 'refused', code: 'parts_required' } }), // refused: corrected on the finish screen as before
      item('note', 5), // no finish
    ];
    expect([...(await owedJobs(waiting, draft))]).toEqual([1]);
    expect([...(await owedJobs([], draft))]).toEqual([]);
  });
});

describe('the Finish link on Today for a finish that waits for its signature', () => {
  const day = previewState('success').day!;
  const harold = day.jobs[1]!.jobNumber;
  const jobs = applyWaiting(day.jobs, [item('arrived', harold, { enteredRealMs: 1 }), item('finished', harold, { enteredRealMs: 2 })]);
  const draw = (owed: ReadonlySet<number> | undefined) => renderToStaticMarkup(
    <ShellIntl lang="en"><TodayList day={day} jobs={jobs} loading={false} online savedAt={null} failed={false} notice={null} {...(owed ? { owedSignatures: owed } : {})} /></ShellIntl>,
  );
  // why: F-1985 the owed job's Done row links to its finish screen with the existing control, and no other row does
  it('draws 1 link to the finish screen on the owed job\'s row only', () => {
    const html = draw(new Set([harold]));
    expect(html.match(/data-ctl="CTL-TEC-02-06"/g) ?? []).toHaveLength(2); // the owed link, and the next job's disabled Finish
    expect(html).toContain(`href="/tech/jobs/${harold}/finish"`);
    const none = draw(undefined);
    expect(none).not.toContain(`href="/tech/jobs/${harold}/finish"`);
    expect(draw(new Set([999999]))).not.toContain('/finish"');
  });
});
