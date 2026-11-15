// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-13 Admin: import, dry run (UI-SPECIFICATION 2.3), with SCR-OFC-25 as its confirm dialog. `run` names the dry run whose report
// to show (the History page's See report link, CTL-OFC-15-02).
import { DryRunScreen } from '../../../../src/import/DryRunScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ run?: string | string[] }> }) {
  const raw = (await searchParams).run;
  return <DryRunScreen runId={Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null)} />;
}
