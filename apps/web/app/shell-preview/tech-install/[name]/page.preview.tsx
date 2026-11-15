// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-TEC-11 in each state its frames show (mockups/pages/r1-techweb-install.html), for the look comparator
// (ci/look-values/tech-map.pw.test.ts) and the page walkers. Never a release route; every state is fixed and no read is made.
import { notFound } from 'next/navigation';
import { APP_INFO } from '../../../../src/shell/preview-fixtures.ts';
import { INSTALL_KINDS } from '../../../../src/tech/install.ts';
import { TechInstallScreen } from '../../../../src/tech/TechInstallScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function TechInstallPreview({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const kind = INSTALL_KINDS.find((k) => k === name);
  if (!kind) notFound();
  return <TechInstallScreen fixedKind={kind} fixedInfo={APP_INFO} />;
}
