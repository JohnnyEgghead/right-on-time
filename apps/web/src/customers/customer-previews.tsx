// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-06, SCR-OFC-39 and SCR-OFC-40 in each state their frames show, with fixed data and no handlers that do anything: a client wrapper
// for the harness preview routes (a server page cannot pass functions to a client component). One file per page, so a preview route loads
// only its own frame's sheet. Also the 3 dialogs the page hosts (SCR-OFC-35, -36, -37; F-671) in the states DK-87 draws them, drawn in
// place under the page. Harness build only; a release route never imports it.
import { useEffect } from 'react';
import { EquipmentDialog, NoteDialog, TextDialog } from '../job/Dialogs.tsx';
import { previewApi } from '../job/preview-fixtures.ts';
import { CustomerFormDialog } from './CustomerFormDialog.tsx';
import { CustomerView, type ZoneUi } from './CustomerView.tsx';
import { dialogCustomer, HOSTED_STATES, type HostedState } from './hosted.ts';
import { MapDialog } from './MapDialog.tsx';
import { EDIT_FORM, HAROLD_DETAIL } from './preview-data.ts';

const noop = () => undefined;

export type CustomerPreviewState = 'success' | 'loading' | 'zone-edit' | 'zone-saving' | 'edit-editing' | 'edit-saving' | 'map' | HostedState;

const T1 = 'Hi Harold, Maria is running about 10 minutes behind her last job. Thanks for your patience. Brightwater';
const T2 = 'Hi Harold, Maria is running about 10 minutes behind her last job, which took longer than planned because of a stuck valve. She is on her way now and will text when she is close. Brightwater';
const NOTE = 'Gate code changed to 4471.';
/** The permission keys of the frame's signed-in person (Dana R., Manager): every role-gated control of the page (F-565). */
export const CUSTOMER_PERMS = ['API-37', 'API-140', 'API-141', 'API-142', 'API-143'];
const FURNACE = HAROLD_DETAIL.equipment[0]!.id;

function Hosted({ state }: { state: HostedState }) {
  const who = dialogCustomer(HAROLD_DETAIL);
  // DK-87's Adding tile draws Type focused (the kit's .focus class: an inline dialog is not focused).
  useEffect(() => {
    if (state === 'equipment-adding') document.getElementById('bw-eq-type')?.classList.add('focus');
  }, [state]);
  const c = { customer: who, api: previewApi(), onClose: noop, onDone: noop, inline: true };
  switch (state) {
    case 'text-empty': return <TextDialog {...c} />;
    case 'text-typing': return <TextDialog {...c} start={{ body: T1 }} />;
    case 'text-too-long': return <TextDialog {...c} start={{ body: T2 }} />;
    case 'text-sending': return <TextDialog {...c} start={{ body: T1, saving: true }} />;
    case 'text-refused': return <TextDialog {...c} start={{ body: T1, shown: { key: 'job.text.textsOff' } }} />;
    case 'note-empty': return <NoteDialog {...c} />;
    case 'note-typing': return <NoteDialog {...c} start={{ body: NOTE }} />;
    case 'note-saving': return <NoteDialog {...c} start={{ body: NOTE, saving: true }} />;
    case 'equipment-adding': return <EquipmentDialog {...c} />;
    case 'equipment-editing': return <EquipmentDialog {...c} equipmentId={FURNACE} />;
    case 'equipment-saving': return <EquipmentDialog {...c} equipmentId={FURNACE} start={{ details: '80,000 BTU, 96% efficient; filter 16x25x4 MERV 11', saving: true }} />;
  }
}

export function CustomerPreview({ state, solo = false }: { state: CustomerPreviewState; solo?: boolean }) {
  const zone: ZoneUi = state === 'zone-edit' ? { kind: 'editing', pick: 'America/Chicago' } : state === 'zone-saving' ? { kind: 'saving', pick: 'America/Chicago' } : { kind: 'idle' };
  const hosted = (HOSTED_STATES as readonly string[]).includes(state) ? (state as HostedState) : null;
  return (
    <>
      <CustomerView
        state={state === 'loading' ? 'loading' : 'ready'} data={state === 'loading' ? null : HAROLD_DETAIL} zone={zone}
        onRetry={noop} onEditZone={noop} onPickZone={noop} onSaveZone={noop} onCancelZone={noop} onEdit={noop} onMap={noop} onNewJob={noop}
        perms={CUSTOMER_PERMS} onText={noop} onAddEquipment={noop} onEditEquipment={noop} onAddNote={noop} onInbox={noop} inboxError={false}
      />
      {state === 'edit-editing' ? <CustomerFormDialog mode="edit" customerId={HAROLD_DETAIL.id} initial={EDIT_FORM} onClose={noop} onSaved={noop} inline solo={solo} /> : null}
      {state === 'edit-saving' ? <CustomerFormDialog mode="edit" customerId={HAROLD_DETAIL.id} initial={{ ...EDIT_FORM, name: 'Harold B. Jenkins' }} onClose={noop} onSaved={noop} inline frozen="saving" solo={solo} /> : null}
      {state === 'map' ? <MapDialog data={HAROLD_DETAIL} onClose={noop} inline solo={solo} file="none.pmtiles" plain={solo} /> : null}
      {hosted ? <div className="bw-hosted" data-bw-hosted={hosted}><Hosted state={hosted} /></div> : null}
    </>
  );
}
