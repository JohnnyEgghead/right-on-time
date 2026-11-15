// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-CUS-07 at each of its 5 routes with the frame's clock and footer data (the demo strip reads the shared clock
// and the footer the build, which the harness app has no API for), for the look comparator (ci/look-values/bookmenu.pw.test.ts) and the page walkers.
// One page per name (heating, cooling, plumbing, comfort-club, about-us). Never a release route.
import { notFound } from 'next/navigation';
import { MenuPage } from '../../../../src/bookmenu/MenuPage.tsx';
import { menuPageFor } from '../../../../src/bookmenu/model.ts';
import { APP_INFO, CLOCK_RUNNING } from '../../../../src/shell/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

export default async function BookMenuPreview({ params }: { params: Promise<{ name: string }> }) {
  const page = menuPageFor((await params).name);
  if (!page) notFound();
  return <MenuPage page={page} clock={CLOCK_RUNNING} appInfo={APP_INFO} reader={false} />;
}
