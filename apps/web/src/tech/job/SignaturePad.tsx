// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CTL-TEC-07-14 Customer signature and CTL-TEC-07-15 Clear (FR-TECH-14; SD-32: a signature is a PNG at most 1200 x 400 px).
// A canvas the customer signs with a finger or a pointer; each stroke's end hands the drawing up as a PNG of 1200 x 400, which
// the finish screen keeps on the phone at once. A kept signature is drawn back into the pad when the screen opens again.
import { useEffect, useRef } from 'react';
import { useT } from '../../shell/intl.tsx';

const SIG_W = 1200;
const SIG_H = 400;

export interface SignaturePadProps {
  png: Uint8Array | null;
  /** "Harold Jenkins signed 12:49 PM" once signed. */
  signedLine: string | null;
  onSigned: (png: Uint8Array) => void;
  onClear: () => void;
}

export function SignaturePad({ png, signedLine, onSigned, onClear }: SignaturePadProps) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(false);

  // The kept PNG, drawn back (Restored); an empty pad when there is none.
  useEffect(() => {
    const c = canvas.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    g.clearRect(0, 0, SIG_W, SIG_H);
    inked.current = false;
    if (!png) return;
    const url = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }));
    const img = new Image();
    img.onload = () => {
      g.drawImage(img, 0, 0, SIG_W, SIG_H);
      inked.current = true;
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }, [png]);

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * SIG_W, y: ((e.clientY - r.top) / r.height) * SIG_H };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = e.currentTarget.getContext('2d');
    if (!g) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = at(e);
    g.strokeStyle = '#1f2a44';
    g.lineWidth = 7;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(p.x + 0.1, p.y + 0.1);
    g.stroke();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const g = e.currentTarget.getContext('2d');
    if (!g) return;
    const p = at(e);
    g.lineTo(p.x, p.y);
    g.stroke();
    inked.current = true;
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;
    inked.current = true;
    e.currentTarget.toBlob((b) => {
      if (b) void b.arrayBuffer().then((buf) => onSigned(new Uint8Array(buf)));
    }, 'image/png');
  };

  const signed = png !== null;
  return (
    <div className={`sig${signed ? '' : ' empty'} bw-sig`} data-ctl="CTL-TEC-07-14" data-signed={signed ? '1' : '0'}>
      <canvas ref={canvas} width={SIG_W} height={SIG_H} className="bw-sig-pad" role="img"
        aria-label={signed && signedLine ? t('tech.finish.sigLabelSigned', { line: signedLine }) : t('tech.finish.sigLabel')}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      {signed ? null : <span className="bw-sig-hint" aria-hidden="true">{t('tech.finish.signHere')}</span>}
      {signed ? <button type="button" className="clr bw-btn-reset" data-ctl="CTL-TEC-07-15" onClick={onClear}>{t('tech.finish.clear')}</button> : null}
      <div className="line" />
      {signed && signedLine ? <div className="who">{signedLine}</div> : null}
    </div>
  );
}
