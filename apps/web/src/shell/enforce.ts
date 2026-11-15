// SPDX-License-Identifier: AGPL-3.0-or-later
// A page's server render acts on its read's outcome (outcome.ts): the shared pages by Next's own interrupts, so the
// status code is the page's (403, 404, 500) and nothing of the page is sent.
import { forbidden, notFound, redirect } from 'next/navigation';
import { pageOutcome, type PageOutcome } from './outcome.ts';

export class PageFailed extends Error {
  constructor(code?: string) {
    super(`page read failed${code ? `: ${code}` : ''}`);
    this.name = 'PageFailed';
  }
}

/**
 * Throws for the 4 outcomes that replace the whole page; returns the outcome otherwise ('code-needed' is shown by the
 * access-code gate P2-AUTH builds; 'region-error' leaves the page up with CMP-12 in the failed region).
 */
export function enforce(problem: { code?: string; status?: number }, returnPath: string): PageOutcome {
  const outcome = pageOutcome(problem);
  switch (outcome) {
    case 'no-access':
      forbidden();
    case 'not-found':
      notFound();
    case 'signed-out':
      redirect(`/sign-in?return=${encodeURIComponent(returnPath)}`);
    case 'failed':
      throw new PageFailed(problem.code);
    default:
      return outcome;
  }
}
