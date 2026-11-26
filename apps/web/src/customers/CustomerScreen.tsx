// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-06 Customer page at `/office/customers/{customerId}` (UI-SPECIFICATION 2.3; FR-DISP-5, FR-DISP-30 to FR-DISP-32, UC-17): reads
// API-35, saves the time zone in place (API-36), opens SCR-OFC-39 (Edit customer) and SCR-OFC-40 (Address on the map), and re-reads after
// a dialog saves. It hosts the job page's 3 dialogs for the customer (SCR-OFC-35 Text, SCR-OFC-36 Add note, SCR-OFC-37 Add or edit equipment; F-671)
// and opens the customer's text inbox in a new tab (API-37). An unknown or merged customer is the Page not found page (SCR-SHR-02).
import { customerDetail, editCustomer } from '@bw/api';
import { notFound, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MessageKey } from '@bw/i18n';
import { jobApi, type JobApi } from '../job/api.ts';
import { EquipmentDialog, NoteDialog, TextDialog } from '../job/Dialogs.tsx';
import type { Shown } from '../job/model.ts';
import { OfficeFrame } from '../shell/Frames.tsx';
import { useMe } from '../shell/me.ts';
import { useAnnounce } from '../shell/Announcer.tsx';
import { useT } from '../shell/intl.tsx';
import { CustomerFormDialog } from './CustomerFormDialog.tsx';
import { CustomerView, type CustomerState, type ZoneUi } from './CustomerView.tsx';
import { MapDialog } from './MapDialog.tsx';
import { dialogCustomer } from './hosted.ts';
import { zoneText, type CustomerForm } from './model.ts';
import type { Detail } from './types.ts';
import { call } from './ui.tsx';

/** The edit dialog's starting values from the page's read (CTL-OFC-39-01 to -05). */
function formOf(d: Detail): CustomerForm {
  return {
    name: d.name,
    mobile: d.contact.mobile ?? '',
    street: { streetId: d.address.streetId, name: d.address.street, city: d.address.city, zip: d.address.zip, branch: d.branch },
    streetText: `${d.address.street}, ${d.address.city}, ${d.address.zip}`,
    houseNumber: String(d.address.houseNumber),
    textLanguage: d.language,
    textsOn: d.contact.textsOn,
  };
}

type Modal = 'edit' | 'map' | 'text' | 'note' | 'equipment-add' | { equipment: string };

export function CustomerScreen({ customerId, api: given }: { customerId: string; api?: JobApi }) {
  const t = useT();
  const router = useRouter();
  const announce = useAnnounce();
  const me = useMe();
  const api = useMemo(() => given ?? jobApi(), [given]);
  const [inboxError, setInboxError] = useState(false);
  const [state, setState] = useState<CustomerState>('loading');
  const [data, setData] = useState<Detail | null>(null);
  const [zone, setZone] = useState<ZoneUi>({ kind: 'idle' });
  const [zoneFailed, setZoneFailed] = useState(false);
  const [dialog, setDialog] = useState<Modal | null>(null);
  const [missing, setMissing] = useState(false);

  const read = useCallback(async (): Promise<Detail | null> => {
    const r = await call(customerDetail, { customerId });
    if (r.ok) {
      setData(r.data);
      setState('ready');
      return r.data;
    }
    if (r.status === 404) setMissing(true);
    else setState('error');
    return null;
  }, [customerId]);

  useEffect(() => {
    setState('loading');
    void read();
  }, [read]);
  if (missing) notFound();

  const saveZone = async () => {
    if (zone.kind !== 'editing' || !data) return;
    const pick = zone.pick;
    setZone({ kind: 'saving', pick });
    setZoneFailed(false);
    const r = await call(editCustomer, { customerId, timeZone: pick });
    if (!r.ok) {
      setZone({ kind: 'editing', pick });
      setZoneFailed(true);
      return;
    }
    setZone({ kind: 'idle' });
    await read();
    announce(t('customers.zone.saved', { zone: zoneText(t, pick) }));
  };

  /** A hosted dialog saved: it closes, the page re-reads API-35 and the change is announced (DK-91 Changed). */
  const done = (shown: Shown) => {
    setDialog(null);
    // The customer page words an added note "Note added." (DK-91 Changed); the job page's dialog says "Note saved".
    const key = (shown.key === 'job.note.saved' ? 'customers.note.added' : shown.key) as MessageKey;
    void read().then(() => announce(t(key, shown.values), 'check'));
  };
  const openInbox = () => {
    void api.inboxLink(customerId).then((r) => {
      if (r.ok) {
        setInboxError(false);
        window.open(r.data.url, '_blank', 'noopener');
      } else setInboxError(true);
    });
  };
  const who = data ? dialogCustomer(data) : null;
  const hosted = { api, onClose: () => setDialog(null), onDone: done };

  return (
    <OfficeFrame screen="SCR-OFC-06" {...(me ? { me } : {})}>
      <CustomerView
        state={state} data={data} zone={zone} zoneFailed={zoneFailed} onRetry={() => void read()}
        onEditZone={() => data && setZone({ kind: 'editing', pick: data.zone })}
        onPickZone={(id) => setZone((z) => (z.kind === 'editing' ? { kind: 'editing', pick: id } : z))}
        onSaveZone={() => void saveZone()}
        onCancelZone={() => (setZone({ kind: 'idle' }), setZoneFailed(false))}
        onEdit={() => setDialog('edit')}
        onMap={() => setDialog('map')}
        onNewJob={() => router.push(`/office/jobs/new?customer=${customerId}`)}
        perms={me?.permissions ?? null}
        onText={() => setDialog('text')}
        onAddEquipment={() => setDialog('equipment-add')}
        onEditEquipment={(id) => setDialog({ equipment: id })}
        onAddNote={() => setDialog('note')}
        onInbox={openInbox}
        inboxError={inboxError}
      />
      {dialog === 'edit' && data ? (
        <CustomerFormDialog
          mode="edit" customerId={customerId} initial={formOf(data)} onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void read().then(() => announce(t('customers.edit.saved'), 'check'));
          }}
        />
      ) : null}
      {dialog === 'map' && data ? <MapDialog data={data} onClose={() => setDialog(null)} /> : null}
      {dialog === 'text' && who ? <TextDialog customer={who} {...hosted} /> : null}
      {dialog === 'note' && who ? <NoteDialog customer={who} {...hosted} /> : null}
      {dialog === 'equipment-add' && who ? <EquipmentDialog customer={who} {...hosted} /> : null}
      {typeof dialog === 'object' && dialog !== null && who ? <EquipmentDialog customer={who} equipmentId={dialog.equipment} {...hosted} /> : null}
    </OfficeFrame>
  );
}

