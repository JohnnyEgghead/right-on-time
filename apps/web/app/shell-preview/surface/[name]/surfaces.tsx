// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The surface previews' client half: every frame reads through the page's own reads (API-10 for the clock, API-02 for
// the footer). The office frames get a sample user, or with ?me=live read API-07 themselves (the signed-in caller's).
import { BookingFrame } from '../../../../src/shell/BookingFrame.tsx';
import { BRANCHES } from '../../../../src/shell/branches.ts';
import { CallButton } from '../../../../src/shell/CallButton.tsx';
import { AdminFrame, OfficeFrame, PbsFrame } from '../../../../src/shell/Frames.tsx';
import { CALL, MANAGER, OFFICE } from '../../../../src/shell/preview-fixtures.ts';
import { PublicFrame } from '../../../../src/shell/PublicFrame.tsx';
import { TechFrame } from '../../../../src/shell/TechFrame.tsx';

export type SurfaceName = 'office' | 'admin' | 'pbs' | 'booking' | 'public' | 'tech';

export function Surface({ name, liveMe = false, slashOff = false }: { name: SurfaceName; liveMe?: boolean; slashOff?: boolean }) {
  const office = liveMe ? undefined : slashOff ? { ...OFFICE, slashShortcut: 'off' as const } : OFFICE;
  const manager = liveMe ? undefined : MANAGER;
  const columbus = BRANCHES[0]!;
  const call = <CallButton name={CALL.name} fullName={CALL.fullName} number={CALL.number} />;
  switch (name) {
    case 'office':
      return (
        <OfficeFrame screen="PREVIEW-SURF-OFC" {...(office ? { me: office } : {})}>
          <div className="bw-preview-body">
            {call}
            {/* A text field on the page: "/" typed here stays here (FR-DISP-11). */}
            <textarea className="bw-preview-note" data-preview="note" />
          </div>
        </OfficeFrame>
      );
    case 'admin':
      return (
        <AdminFrame screen="PREVIEW-SURF-OFC-ADMIN" {...(manager ? { me: manager } : {})} currentPath="/office/admin/clock">
          <div className="bw-preview-body">{call}</div>
        </AdminFrame>
      );
    case 'pbs':
      return <PbsFrame screen="PREVIEW-SURF-PBS" {...(liveMe ? {} : { me: OFFICE })} />;
    case 'booking':
      return <BookingFrame screen="PREVIEW-SURF-CUS" branch={columbus} />;
    case 'public':
      return <PublicFrame screen="PREVIEW-SURF-INB" surface="SURF-INB" branch={columbus} />;
    case 'tech':
      return (
        <TechFrame screen="PREVIEW-SURF-TWA">
          <div className="bw-preview-body">{call}</div>
        </TechFrame>
      );
  }
}
