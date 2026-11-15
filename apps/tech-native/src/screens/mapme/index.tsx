// SPDX-License-Identifier: AGPL-3.0-or-later
// The Map, Parts and Me tabs and the Directions screen (P6-NATIVE-MAP-ME). The technician's Text size choice (CTL-TEC-10-09) is the app's, set
// once at its root (App.tsx, TextSized; F-1072 item 6), so these screens, Today, the job screens, the sheets and the tab bar all draw it.
import type { ReactNode } from 'react';
import { TextSizeProvider } from '../../ui/text-size.tsx';
import { DirectionsScreen } from './DirectionsScreen.tsx';
import { MapTab } from './MapTab.tsx';
import { MeTab } from './MeTab.tsx';
import { PartsTab } from './PartsTab.tsx';
import { useMapMe } from './use-mapme.ts';

/** The provider at the app's root: the signed-in person's choice, kept on the phone by the reads (Standard signed out). */
export function TextSized(props: { children: ReactNode }) {
  const { data } = useMapMe();
  return <TextSizeProvider value={data.textSize}>{props.children}</TextSizeProvider>;
}

export const MapBody = () => <MapTab />;
export const PartsBody = () => <PartsTab />;
export const MeBody = () => <MeTab />;
export const DirectionsRoute = () => <DirectionsScreen />;
export { openDirections } from './MapTab.tsx';
