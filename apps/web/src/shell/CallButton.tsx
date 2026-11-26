// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CMP-16 call button (CTL-CMP-16-01; SD-33, OA-67, FR-DISP-20). On a phone ((pointer: coarse) and (hover: none)) it is a
// tel: link that opens the dialer; on a computer pressing it shows the number beside the button, in a live region so a
// screen reader reads it, and starts no call. The server never reads the user agent (GAP-22). Before the page's scripts run
// the server render holds both forms and a style rule on the same media query (styles/app/shell.css) shows only the matching
// one, so a tap on a phone dials from the first paint (UD-56, F-1192); once the browser's query is known one form is left.
import { useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import { useT } from './intl.tsx';
import { callMode, PHONE_QUERY, telHref, type CallMode } from './keys.ts';
import { formatPhone } from './phone.ts';

function subscribe(cb: () => void) {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
const clientMode = (): CallMode => callMode((q) => window.matchMedia(q));
/** The server and the first client render draw both forms; the style rule picks one until the query is read. */
type DrawnMode = CallMode | 'both';
const serverMode = (): DrawnMode => 'both';

export function useCallMode(): DrawnMode {
  return useSyncExternalStore(subscribe, clientMode, serverMode);
}

export interface CallButtonProps {
  /** Short name on the button ("Maria"); full name in the shown number's heading ("Maria Santos"). */
  name: string;
  fullName?: string;
  number: string;
  /** Overrides the button class; the default is the kit's small button. */
  className?: string;
  /** Overrides the visible content (the office phone in the booking site header, CMP-15, shows the number itself). */
  children?: ReactNode;
  /** Previews: the number already shown, as the kit frame draws it. */
  initialShown?: boolean;
}

export function CallButton({ name, fullName, number, className = 'btn sm', children, initialShown = false }: CallButtonProps) {
  const t = useT();
  const mode = useCallMode();
  const [shown, setShown] = useState(initialShown);
  const popId = useId();
  // F-1888: the number reads in the 1 shown form (shell/phone.ts) however it is stored; the tel: link dials its digits.
  const shownNumber = formatPhone(number);
  const label = children ?? (
    <>
      <Icon name="phone" />
      {t('shell.call.label', { name })}
    </>
  );
  const dial = (form: boolean) => (
      <a className={className} {...(form ? { 'data-callform': 'tel' } : {})} href={telHref(number)} data-ctl="CTL-CMP-16-01" data-cmp="CMP-16" aria-label={t('shell.call.number', { name: fullName ?? name, number: shownNumber })}>
        {label}
      </a>
  );
  if (mode === 'dial') return dial(false);
  const reveal = (
    <div className="bw-call" data-cmp="CMP-16" {...(mode === 'both' ? { 'data-callform': 'reveal' } : {})}>
      <button
        type="button"
        className={className}
        data-ctl="CTL-CMP-16-01"
        aria-expanded={shown}
        aria-controls={popId}
        onClick={() => setShown(true)}
      >
        {label}
      </button>
      <div id={popId} role="status" className="bw-call-live">
        {shown ? (
          <div className="r1-pop in bw-call-pop">
            <h3>{t('shell.call.label', { name: fullName ?? name })}</h3>
            <p className="bw-num" data-call-number="">
              {shownNumber}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
  return mode === 'both' ? <>{dial(true)}{reveal}</> : reveal;
}
