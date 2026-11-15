// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-GATE-02 Start page (frame mockups/pages/r1-gate-a-start.html, DK-83; markup DK-60 and DK-61 option A): the 3 ways in
// (CTL-GATE-02-01 to -03) and, with demo mode on, the iPhone app's sample sign-ins (CTL-GATE-02-04, API-15) and the install
// line (CTL-GATE-02-05: the link, or "The iPhone app is coming" while the server has none, OA-63). Demo mode off shows only
// the 3 ways in. The page carries the demo clock (CMP-01) and the footer, and sits behind the access code like every page.
import '../shell/css/gate.ts';
import { useCallback, useEffect, useState } from 'react';
import { BRANCHES, branchById } from '../shell/branches.ts';
import type { AppInfo } from '../shell/Footer.tsx';
import { PublicHeader } from '../shell/Headers.tsx';
import { Icon } from '../shell/Icon.tsx';
import type { IconName } from '../shell/icon-paths.ts';
import { useT } from '../shell/intl.tsx';
import type { ClockAnswer } from '../shell/clock.ts';
import { createReader, type Reader } from '../shell/reads.ts';
import { Screen } from '../shell/Surface.tsx';
import { readSignInList, type SignInList } from './sign-in-list.ts';

export type { SignInList, TechSignIn, TechSignIns } from './sign-in-list.ts';

export interface StartScreenProps {
  /** Preview states (the harness build): API-02's answer and API-15's state, fixed. Absent: the page reads both. */
  info?: AppInfo | null;
  list?: SignInList;
  /** Preview: the demo clock's first read, fixed. */
  clock?: ClockAnswer | null;
  reader?: Reader | false;
}

const DOORS: { icon: IconName; title: 'office' | 'tech' | 'customers'; href: string; ctl: string }[] = [
  { icon: 'grid', title: 'office', href: '/sign-in', ctl: 'CTL-GATE-02-01' },
  { icon: 'truck', title: 'tech', href: '/tech', ctl: 'CTL-GATE-02-02' },
  { icon: 'calendar', title: 'customers', href: '/book', ctl: 'CTL-GATE-02-03' },
];

export function StartScreen({ info: givenInfo, list: givenList, clock, reader }: StartScreenProps) {
  const t = useT();
  const [info, setInfo] = useState<AppInfo | null>(givenInfo ?? null);
  const [list, setList] = useState<SignInList>(givenList ?? 'loading');
  const read = useCallback(() => reader || createReader({ baseUrl: window.location.origin }), [reader]);

  const load = useCallback(async () => {
    setList('loading');
    setList(await readSignInList(read()));
  }, [read]);

  useEffect(() => {
    if (givenInfo !== undefined || reader === false) return;
    void read().read<AppInfo>('API-02').then((r) => {
      if (r.ok) setInfo(r.data);
    });
  }, [givenInfo, reader, read]);
  const demo = info?.demoMode === true;
  useEffect(() => {
    if (givenList !== undefined || reader === false || !demo) return;
    void load();
  }, [givenList, reader, demo, load]);

  return (
    <Screen
      screen="SCR-GATE-02" surface="SURF-GATE" className="g-a start" title={t('auth.start.doc')}
      appInfo={info} {...(clock !== undefined ? { clock } : {})} {...(reader !== undefined ? { reader } : {})}
    >
      <PublicHeader branch={BRANCHES[0]!} />
      <section className="band">
        <h1>{t('auth.start.title')}</h1>
        <p>{t('auth.start.lead')}</p>
      </section>
      <div className="doors">
        {DOORS.map((d) => (
          <a key={d.ctl} className="door" href={d.href} data-ctl={d.ctl}>
            <span className="dico">
              <Icon name={d.icon} />
            </span>
            <b>{t(`auth.start.door.${d.title}.title`)}</b>
            <p>{t(`auth.start.door.${d.title}.body`)}</p>
            <span className="btn primary lg">
              {t(`auth.start.door.${d.title}.go`)}
              <Icon name="chevRight" />
            </span>
          </a>
        ))}
      </div>
      {demo && list !== 'hidden' ? (
        <section className="iph">
          <div className="iphl">
            <h2>{t('auth.start.iph.title')}</h2>
            <p className="signintro">{t('auth.start.iph.intro')}</p>
            <SignInTable list={list} onRetry={() => void load()} />
          </div>
          {typeof list === 'object' ? <AppLine link={list.iosAppLink} /> : null}
        </section>
      ) : null}
    </Screen>
  );
}

function SignInTable({ list, onRetry }: { list: Exclude<SignInList, 'hidden'>; onRetry: () => void }) {
  const t = useT();
  if (list === 'loading') {
    return (
      <div data-ctl="CTL-GATE-02-04" aria-busy="true">
        <span className="r1-skel bw-w-40" />
        <span className="r1-skel bw-w-95" />
        <span className="r1-skel bw-w-95" />
        <span className="r1-skel bw-w-80" />
      </div>
    );
  }
  if (list === 'error') {
    return (
      <div className="r1-errpanel" role="alert" data-ctl="CTL-CMP-12-01">
        <Icon name="alert" />
        <div>
          <b>{t('auth.start.iph.error')}</b>
          <button type="button" className="btn sm" data-ctl="CTL-CMP-12-02" onClick={onRetry}>
            {t('shell.error.tryAgain')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <table className="signs" data-ctl="CTL-GATE-02-04">
      <thead>
        <tr>
          <th>{t('auth.start.col.tech')}</th>
          <th>{t('auth.start.col.branch')}</th>
          <th>{t('auth.start.col.language')}</th>
          <th>{t('auth.start.col.email')}</th>
          <th>{t('auth.start.col.passwordLabel')}</th>
        </tr>
      </thead>
      <tbody>
        {list.signIns.map((s) => (
          <tr key={s.email}>
            <td translate="no">
              <b>{s.name}</b>
            </td>
            <td translate="no">{branchById(s.branch).name}</td>
            <td>{t(s.language === 'es' ? 'auth.lang.es' : 'auth.lang.en')}</td>
            <td className="mono" translate="no">
              {s.email}
            </td>
            <td className="mono" translate="no">
              {s.password}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** CTL-GATE-02-05: the install link, or the coming line with no link while the server has none (OI-14, OA-63). */
function AppLine({ link }: { link: string | null }) {
  const t = useT();
  if (link === null) {
    return (
      <div className="appline coming" data-ctl="CTL-GATE-02-05">
        <Icon name="clock" />
        <div>
          <b>{t('auth.start.app.title')}</b>
          <span>{t('auth.start.app.coming')}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="appline" data-ctl="CTL-GATE-02-05">
      <span className="aico">
        <Icon name="phone" />
      </span>
      <div>
        <b>{t('auth.start.app.title')}</b>
        <span>{t('auth.start.app.body')}</span>
      </div>
      <a className="btn accent lg" href={link}>
        <Icon name="download" />
        {t('auth.start.app.get')}
      </a>
    </div>
  );
}
