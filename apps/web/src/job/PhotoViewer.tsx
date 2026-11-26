// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The job page's photos and signature image (SCR-OFC-03; F-707, F-727; UI-SPECIFICATION CTL-OFC-03-14 to -16, CTL-OFC-03-30): each stored file
// is read from the app's own origin by its item key (API-175), and one that fails to load says so ("Photo could not load",
// "Signature could not load") instead of a broken image. The viewer is a dialog with the full image, alt text naming who took
// it and when, Previous, Next and Close.
import { useState, type ReactNode } from 'react';
import { Dialog } from '../board/Dialogs.tsx';
import { timeText } from '../board/model.ts';
import { useT } from '../shell/intl.tsx';

/** The served path of a stored photo or signature (API-175): the full file, which only the viewers read (UD-55). */
export const fileSrc = (key: string): string => `/api/v1/files/${key}`;
/** A photo tile's small copy (API-175 size thumb; SD-32, UD-55, F-1235); a signature answers its PNG whatever the size. */
export const thumbSrc = (key: string): string => `/api/v1/files/${key}?size=thumb`;

/** 1 stored image; `failed` shows in its place when the file does not load. */
export function StoredImage({ fileKey, className, alt, failed }: { fileKey: string; className: string; alt: string; failed: ReactNode }) {
  const [bad, setBad] = useState(false);
  if (bad) return <>{failed}</>;
  return <img className={className} src={fileSrc(fileKey)} alt={alt} onError={() => setBad(true)} />;
}

export function PhotoViewer({ photos, at, onMove, onClose }: {
  photos: readonly { key: string; by: string | null; at: string }[]; at: number; onMove: (i: number) => void; onClose: () => void;
}) {
  const t = useT();
  const p = photos[at];
  if (!p) return null;
  const alt = t('job.photo.alt', { by: p.by ?? '', at: timeText(p.at) });
  return (
    <Dialog title={t('job.photo.title', { n: at + 1, of: photos.length })} closeCtl="CTL-OFC-03-16" screen="SCR-OFC-03" onClose={onClose} wide
      foot={(
        <>
          <button type="button" className="btn" disabled={at === 0} onClick={() => onMove(at - 1)}>{t('job.photo.previous')}</button>
          <button type="button" className="btn" disabled={at === photos.length - 1} onClick={() => onMove(at + 1)}>{t('job.photo.next')}</button>
          <button type="button" className="btn primary" onClick={onClose}>{t('job.photo.close')}</button>
        </>
      )}>
      <div className="bw-photo-full" data-ctl="CTL-OFC-03-16">
        <StoredImage key={p.key} fileKey={p.key} className="bw-photo-img" alt={alt} failed={<p className="r1-note" role="status">{t('job.photo.failed')}</p>} />
        <p className="r1-note">{alt}</p>
      </div>
    </Dialog>
  );
}
