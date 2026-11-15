// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-OFC-40 Address on the map (UI-SPECIFICATION CTL-OFC-40-01 to -03; FR-DISP-31, FR-MAP-1, OA-73): the customer's stored map
// position on the app's own street map (CMP-05, no outside request, no outside maps app), with the address in words as the map's text
// alternative. Escape and Close close it. The map failing leaves the address showing (CMP-05's own message).
import { Icon } from '../shell/Icon.tsx';
import { useT } from '../shell/intl.tsx';
import { MapView } from '../map/MapView.tsx';
import { isBranchId } from '../map/map-model.ts';
import type { Detail } from './types.ts';
import { Dialog } from './ui.tsx';

export function MapDialog({ data, onClose, inline, solo, file, plain }: { data: Detail; onClose: () => void; inline?: boolean; solo?: boolean; file?: string; plain?: boolean }) {
  const t = useT();
  const address = t('customers.address.oneLine', { house: data.address.houseNumber, street: data.address.street, city: data.address.city, zip: data.address.zip });
  const branch = isBranchId(data.branch) ? data.branch : 'columbus';
  return (
    <Dialog
      screen="SCR-OFC-40" title={`${data.address.houseNumber} ${data.address.street}, ${data.address.city}`} closeCtl="CTL-OFC-40-03" onClose={onClose} wide {...(inline ? { inline } : {})} {...(solo ? { hosted: false } : {})}
      body={(
        <>
          <div data-ctl="CTL-OFC-40-01">
            {plain ? (
              <div className="r1-map bw-map" role="application" aria-label={t('map.label')} data-cmp="CMP-05" data-ctl="CTL-CMP-05-01" data-map-state="failed">
                <div className="fail" role="img" aria-label={t('map.failed')}><Icon name="map" />{t('map.failed')}</div>
              </div>
            ) : (
              // The map opens on the stored position, so its marker is in the middle of the card (the frame's pin at 50%, 50%), wherever in the branch the house is.
              <MapView
                branch={branch} center={[data.position.lon, data.position.lat]} variant="card" {...(file ? { file } : {})}
                markers={[{ id: 'home', kind: 'house', at: [data.position.lon, data.position.lat], words: t('customers.map.marker', { address }) }]}
              />
            )}
          </div>
          <p className="bw-cu-addr" data-ctl="CTL-OFC-40-02">{address}</p>
        </>
      )}
      foot={<button type="button" className="btn" data-initial data-ctl="CTL-OFC-40-03" onClick={onClose}>{t('customers.map.close')}</button>}
    />
  );
}
