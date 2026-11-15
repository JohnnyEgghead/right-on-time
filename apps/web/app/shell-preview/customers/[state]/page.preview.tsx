// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-05 and SCR-OFC-38 in each state their frame shows, for the look comparator
// (ci/look-values/customers.pw.test.ts) and the page walkers. One route per screen, so each loads only its own frame's sheet.
// Every state is fixed; the release route is /office/customers.
import '../../../../src/shell/css/office.ts';
import { notFound } from 'next/navigation';
import { SearchPreview, type SearchPreviewState } from '../../../../src/customers/search-previews.tsx';
import { OfficeFrame } from '../../../../src/shell/Frames.tsx';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../../../../src/shell/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

const STATES: readonly SearchPreviewState[] = ['results', 'empty', 'searching', 'preview-loading', 'preview-error', 'none', 'error', 'new-empty', 'new-nomatch', 'new-saving'];

export default async function CustomersPreview({ params }: { params: Promise<{ state: string }> }) {
  const { state: asked } = await params;
  // `solo-<state>`: the New customer dialog alone in a frame named for it (the page walkers' host-page rows).
  const solo = asked.startsWith('solo-');
  const state = solo ? asked.slice(5) : asked;
  if (!(STATES as readonly string[]).includes(state)) notFound();
  return (
    <OfficeFrame screen={solo ? 'SCR-OFC-38' : 'SCR-OFC-05'} me={MANAGER} clock={CLOCK_RUNNING} appInfo={APP_INFO} reader={false}>
      <SearchPreview state={state as SearchPreviewState} solo={solo} />
    </OfficeFrame>
  );
}
