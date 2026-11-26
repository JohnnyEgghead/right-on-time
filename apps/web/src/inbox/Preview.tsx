// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CTL-INB-01-11 Live map preview card (FR-TEXT-21, API-164): the picture of the map the server draws from the app's own map file, with the
// OpenStreetMap credit and the alt text in words, under a live map link. After arrival or an office change that ends the link
// the server answers 410: the card then says "This link has ended" and holds no picture and no position (NFR-04). A picture that
// fails to load leaves the card with its words only.
// API-164 (packages/api/src/contracts/map.ts, liveMapPreview): the 200 envelope's data holds `svg` (the picture's markup), `altKey` and
// `captionKey` (catalog keys) and the technician's first name, the caption's parameter; the 410 is the ended answer.
import { useEffect, useState } from 'react';
import type { MessageKey } from '@bw/i18n';
import { useT } from '../shell/intl.tsx';

export type PreviewAnswer =
  | { status: 'ended' }
  | { status: 'live'; image: string | null; altKey: string; captionKey: string; technician: string }
  | { status: 'failed' };
export type PreviewFetch = (path: string) => Promise<PreviewAnswer>;

export const fetchPreview: PreviewFetch = async (path) => {
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (res.status === 410) return { status: 'ended' };
    if (!res.ok) return { status: 'failed' };
    const body = (await res.json()) as { data?: { svg?: string; altKey?: string; captionKey?: string; technician?: string } };
    const d = body.data ?? {};
    const image = d.svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(d.svg)}` : null;
    return { status: 'live', image, altKey: d.altKey ?? 'inbox.previewAlt', captionKey: d.captionKey ?? 'inbox.previewCaption', technician: d.technician ?? '' };
  } catch {
    return { status: 'failed' };
  }
};

/** The card reads again on the page's own refresh (the thread's 5 s) and when the window is focused, until the answer is the ended one (F-969). */
const PREVIEW_REFRESH_MS = 5_000;

export function LiveMapPreview({ path, host, fetchPreview: load = fetchPreview }: { path: string; host: string; fetchPreview?: PreviewFetch }) {
  const t = useT();
  const [answer, setAnswer] = useState<PreviewAnswer | null>(null);
  const [pictureFailed, setPictureFailed] = useState(false);
  const ended = answer?.status === 'ended';
  useEffect(() => {
    if (ended) return undefined;
    let live = true;
    const read = () => void load(path).then((a) => {
      // F-969: an ended answer replaces the picture and stays; a failed re-read keeps the card it has.
      if (live) setAnswer((was) => (was?.status === 'ended' ? was : a.status === 'failed' && was ? was : a));
    });
    read();
    const every = window.setInterval(read, PREVIEW_REFRESH_MS);
    window.addEventListener('focus', read);
    return () => {
      live = false;
      window.clearInterval(every);
      window.removeEventListener('focus', read);
    };
  }, [path, load, ended]);
  if (answer === null) return null;
  if (answer.status === 'ended') {
    return <div className="preview ended" data-ctl="CTL-INB-01-11"><b>{t('inbox.previewEnded')}</b></div>;
  }
  const live = answer.status === 'live' ? answer : null;
  return (
    <div className="preview" data-ctl="CTL-INB-01-11">
      {live?.image && !pictureFailed ? <img src={live.image} alt={t(live.altKey as MessageKey)} className="bw-pv" onError={() => setPictureFailed(true)} /> : null}
      <div className="pt"><b>{live ? t(live.captionKey as MessageKey, { technician: live.technician }) : ''}</b><span translate="no">{host}</span></div>
      <div className="pt bw-pt-credit"><span>{t('inbox.previewCredit')}</span></div>
    </div>
  );
}
