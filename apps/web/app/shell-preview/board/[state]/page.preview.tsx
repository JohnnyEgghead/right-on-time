// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (next.config.ts): SCR-OFC-02 and its hosted screens in each state DK-85 draws (src/board/BoardPreview.tsx),
// for the look comparator (ci/look-values/board.pw.test.ts) and the page walkers. Never a release route; every state is fixed.
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { BoardPreview } from '../../../../src/board/BoardPreview.tsx';
import { BOARD_PREVIEW_STATES, type BoardPreviewState } from '../../../../src/board/preview-fixtures.ts';

export const dynamic = 'force-dynamic';

// `solo-<state>`: a hosted screen alone in a frame named for it (the page walkers' host-page rows).
export default async function BoardStatePreview({ params }: { params: Promise<{ state: string }> }) {
  const { state: asked } = await params;
  const solo = asked.startsWith('solo-');
  const state = solo ? asked.slice(5) : asked;
  if (!(BOARD_PREVIEW_STATES as readonly string[]).includes(state)) notFound();
  return (
    <Suspense>
      <BoardPreview state={state as BoardPreviewState} solo={solo} />
    </Suspense>
  );
}
