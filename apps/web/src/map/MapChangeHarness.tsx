// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// Harness build only: CMP-05 with a control that changes the markers after the map is ready (F-451), the way the board's
// event stream and the live map's position polling will. Never a release component.
import { useState } from 'react';
import { useT } from '../shell/intl.tsx';
import { MapView, type MapViewProps } from './MapView.tsx';

export function MapChangeHarness(props: MapViewProps) {
  const t = useT();
  const [moved, setMoved] = useState(false);
  const base = props.markers ?? [];
  const first = base[0];
  const markers = moved && first ? [...base, { ...first, id: `${first.id}-moved`, at: [first.at[0] + 0.01, first.at[1] + 0.01] as const }] : base;
  return (
    <>
      <button type="button" data-test="change-markers" onClick={() => setMoved(true)}>
        {t('map.label')}
      </button>
      <MapView {...props} markers={markers} />
    </>
  );
}
