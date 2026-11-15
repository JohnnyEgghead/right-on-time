// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The branch an office screen shows (CTL-CMP-07-04: the top bar keeps it in the URL and in the browser, else the user's own branch):
// the URL's ?branch= first, then the stored choice, then API-07's branch. null until it is known, so a screen reads nothing for a
// branch it is not going to show. A choice in the top bar replaces ?branch=, and the answer follows it without a reload. Hoisted from
// the week board (P4-WEEK) for the billing list (F-594): 1 reader for every screen that shows 1 branch.
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BRANCH_STORAGE_KEY, branchById } from './branches.ts';
import { createReader } from './reads.ts';

export function useBranch(): string | null {
  const params = useSearchParams();
  const fromUrl = params.get('branch');
  const [branch, setBranch] = useState<string | null>(fromUrl ? branchById(fromUrl).id : null);
  useEffect(() => {
    if (fromUrl) {
      setBranch(branchById(fromUrl).id);
      return;
    }
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(BRANCH_STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (stored) {
      setBranch(branchById(stored).id);
      return;
    }
    let live = true;
    void createReader({ baseUrl: window.location.origin }).read<{ branch?: string }>('API-07').then((r) => {
      if (live) setBranch(branchById(r.ok ? r.data.branch : undefined).id);
    });
    return () => {
      live = false;
    };
  }, [fromUrl]);
  return branch;
}
