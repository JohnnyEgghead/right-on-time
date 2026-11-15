// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only: a route whose read answers each page-replacing outcome, through the same enforce() a page calls,
// so the walkers and the stack test see the real SCR-SHR pages with their real status codes (403, 404, 500).
// F-129: forbidden is keyed on the code; access_code_required (also 403) does not render SCR-SHR-01.
import { notFound } from 'next/navigation';
import { enforce } from '../../../../src/shell/enforce.ts';

export const dynamic = 'force-dynamic';

const PROBLEMS: Record<string, { code: string; status: number }> = {
  '403': { code: 'forbidden', status: 403 },
  'code-needed': { code: 'access_code_required', status: 403 },
  '404': { code: 'not_found', status: 404 },
  '500': { code: 'server_error', status: 500 },
};

export default async function StatusPreview({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const problem = PROBLEMS[code];
  if (!problem) notFound();
  const outcome = enforce(problem, `/shell-preview/status/${code}`);
  // Only the outcomes that leave the page up reach here (code-needed: the gate is P2-AUTH's).
  return <div className="r1-screen bw-screen" data-screen="PREVIEW-OUTCOME" data-outcome={outcome} />;
}
