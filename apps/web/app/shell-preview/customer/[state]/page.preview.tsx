// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-06, SCR-OFC-39 and SCR-OFC-40 in each state their frame shows, for the look comparator
// (ci/look-values/customers.pw.test.ts) and the page walkers. Every state is fixed; the release route is /office/customers/{customerId}.
import '../../../../src/shell/css/office.ts';
import { notFound } from 'next/navigation';
import { CustomerPreview, type CustomerPreviewState } from '../../../../src/customers/customer-previews.tsx';
import { HOSTED_STATES } from '../../../../src/customers/hosted.ts';
import { OfficeFrame } from '../../../../src/shell/Frames.tsx';
import { APP_INFO, CLOCK_RUNNING, MANAGER } from '../../../../src/shell/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

const STATES: readonly CustomerPreviewState[] = ['success', 'loading', 'zone-edit', 'zone-saving', 'edit-editing', 'edit-saving', 'map', ...HOSTED_STATES];

export default async function CustomerPagePreview({ params }: { params: Promise<{ state: string }> }) {
  const { state: asked } = await params;
  // `solo-<state>`: a dialog alone in a frame named for it (the page walkers' host-page rows).
  const solo = asked.startsWith('solo-');
  const state = solo ? asked.slice(5) : asked;
  if (!(STATES as readonly string[]).includes(state)) notFound();
  const screen = !solo ? 'SCR-OFC-06' : state === 'map' ? 'SCR-OFC-40' : 'SCR-OFC-39';
  return (
    <OfficeFrame screen={screen} me={MANAGER} clock={CLOCK_RUNNING} appInfo={APP_INFO} reader={false}>
      <CustomerPreview state={state as CustomerPreviewState} solo={solo} />
    </OfficeFrame>
  );
}
